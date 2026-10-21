import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAuditPathForTests } from "./audit.js";
import { RuntimeError, toErrorShape } from "./errors.js";
import { setKillPathForTests, writeKillSwitch } from "./kill.js";
import { setPendingPathForTests } from "./pendingStore.js";
import { FileLockTimeoutError, withFileLock } from "./fsAtomic.js";
import { setMandatePathForTests } from "./policy.js";
import { approveRequest, dailySpendToday, describePending, getRequestStatus, submitRequest, type Adapter } from "./requestRuntime.js";
import { isRequestTombstone, mutateRequests, readRequests, setRequestsPathForTests } from "./requestStore.js";
import { ALLOWED_TRANSITIONS, REQUEST_STATUSES, transition, type RequestStatus } from "./stateMachine.js";
import type { Intent, Mandate } from "../../schema/src/index.js";

const intent: Intent = {
    agentId: "runtime-agent",
    action: "write",
    tool: "http.request",
    target: "https://example.test/resource",
    effects: [{ kind: "write", reversible: false }],
};

const SECRET_URL_TOKEN = "super-secret-token-value";

function mandateWith(effect: "allow" | "confirm" | "deny"): Mandate {
    return { version: "1", userId: "demo", default: "deny", rules: [{ effect, action: "write", tool: "http.request", host: "example.test" }] };
}

let dir: string;
let previousSecrets: string | undefined;
let previousHome: string | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const useMandate = (mandate: Mandate) => writeFileSync(join(dir, "mandate.json"), JSON.stringify(mandate), "utf-8");
const auditText = () => readFileSync(join(dir, "audit.jsonl"), "utf-8");
const codeIs = (code: string) => (error: unknown) => error instanceof RuntimeError && error.code === code;

test("el lock registra PID y hora y lo libera al terminar", () => {
    const lockPath = join(tmpdir(), `meruntime-lock-${process.pid}-${Date.now()}`);
    let owner: { pid: number; createdAt: string } | undefined;
    try {
        withFileLock(lockPath, () => {
            owner = JSON.parse(readFileSync(lockPath, "utf-8")) as { pid: number; createdAt: string };
            assert.equal(owner.pid, process.pid);
            assert.ok(Number.isFinite(Date.parse(owner.createdAt)));
        });
        assert.equal(existsSync(lockPath), false);
    } finally {
        rmSync(lockPath, { force: true });
    }
});

test("el lock obsoleto se recupera solo cuando su PID ya no existe", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const deadPid = child.pid;
    await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
    });
    assert.ok(deadPid);
    const lockPath = join(tmpdir(), `meruntime-dead-lock-${process.pid}-${Date.now()}`);
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, createdAt: new Date(0).toISOString() }), "utf-8");
    try {
        withFileLock(lockPath, () => {
            const owner = JSON.parse(readFileSync(lockPath, "utf-8")) as { pid: number };
            assert.equal(owner.pid, process.pid);
        });
        assert.equal(existsSync(lockPath), false);
    } finally {
        rmSync(lockPath, { force: true });
    }
});

test("un lock antiguo de un proceso vivo no se elimina y vence dentro del timeout", () => {
    const lockPath = join(tmpdir(), `meruntime-live-lock-${process.pid}-${Date.now()}`);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date(0).toISOString() }), "utf-8");
    const startedAt = Date.now();
    try {
        assert.throws(() => withFileLock(lockPath, () => undefined), FileLockTimeoutError);
        assert.ok(Date.now() - startedAt >= 900);
        assert.equal(JSON.parse(readFileSync(lockPath, "utf-8")).pid, process.pid);
    } finally {
        rmSync(lockPath, { force: true });
    }
});

test("timeout de lock antes de ejecutar devuelve RED storage.busy", async () => {
    const lockPath = join(dir, "requests.json.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf-8");
    const { state, adapter } = countingAdapter();

    const result = await submitRequest({ intent, idempotencyKey: "storage-busy" }, { adapter });

    assert.equal(result.status, "DENIED");
    assert.equal(result.verdict, "RED");
    assert.equal(result.rule, "storage.busy");
    assert.equal(result.error?.code, "STORAGE_BUSY");
    assert.equal(state.calls, 0);
    assert.equal(readRequests().length, 0);
    assert.match(auditText(), /storage\.busy/);
});

function countingAdapter(behavior: () => Promise<{ status?: number }> = async () => ({ status: 200 })) {
    const state = { calls: 0 };
    const adapter: Adapter = async () => {
        state.calls++;
        return behavior();
    };
    return { state, adapter };
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meruntime-requests-"));
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({}), "utf-8");
    previousSecrets = process.env.MERUNTIME_SECRETS;
    previousHome = process.env.MERUNTIME_HOME;
    process.env.MERUNTIME_SECRETS = join(dir, "secrets.json");
    process.env.MERUNTIME_HOME = dir;
    setMandatePathForTests(join(dir, "mandate.json"));
    setKillPathForTests(join(dir, "kill.json"));
    writeKillSwitch(false);
    setPendingPathForTests(join(dir, "pending.json"));
    setRequestsPathForTests(undefined);
    setAuditPathForTests(join(dir, "audit.jsonl"));
    useMandate(mandateWith("allow"));
});

afterEach(() => {
    setMandatePathForTests(undefined);
    setKillPathForTests(undefined);
    setPendingPathForTests(undefined);
    setRequestsPathForTests(undefined);
    setAuditPathForTests(undefined);
    if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
    else process.env.MERUNTIME_SECRETS = previousSecrets;
    if (previousHome === undefined) delete process.env.MERUNTIME_HOME;
    else process.env.MERUNTIME_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
});

test("state machine: solo las 12 transiciones válidas; el resto lanza INVALID_STATE_TRANSITION", () => {
    const expected = new Set([
        "RECEIVED>EVALUATING",
        "EVALUATING>EXECUTING", "EVALUATING>PENDING", "EVALUATING>DENIED",
        "PENDING>APPROVED", "PENDING>DENIED", "PENDING>EXPIRED",
        "APPROVED>EXECUTING", "APPROVED>DENIED",
        "EXECUTING>EXECUTED", "EXECUTING>FAILED", "EXECUTING>UNKNOWN",
    ]);
    assert.equal(expected.size, 12);
    for (const from of REQUEST_STATUSES) {
        for (const to of REQUEST_STATUSES) {
            const request = { requestId: "mr_test", status: from as RequestStatus, updatedAt: "", transitions: [] as never[] };
            if (expected.has(`${from}>${to}`)) {
                const entry = transition(request, to, { actor: "test", reason: "valid" });
                assert.equal(request.status, to);
                assert.deepEqual([entry.from, entry.to, entry.actor, entry.reason], [from, to, "test", "valid"]);
                assert.equal(request.transitions.length, 1);
            } else {
                assert.throws(() => transition(request, to, { actor: "test", reason: "invalid" }), codeIs("INVALID_STATE_TRANSITION"), `${from}>${to}`);
                assert.equal(request.status, from);
                assert.equal(request.transitions.length, 0);
            }
        }
    }
    for (const terminal of ["EXECUTED", "DENIED", "EXPIRED", "FAILED", "UNKNOWN"] as const) {
        assert.deepEqual(ALLOWED_TRANSITIONS[terminal], []);
    }
});

test("misma clave dos veces: una sola ejecución y se devuelve el resultado almacenado", async () => {
    const { state, adapter } = countingAdapter(async () => ({ status: 201 }));
    const first = await submitRequest({ intent, idempotencyKey: "key-1" }, { adapter });
    const second = await submitRequest({ intent, idempotencyKey: "key-1" }, { adapter });

    assert.equal(state.calls, 1);
    assert.equal(first.status, "EXECUTED");
    assert.match(first.requestId, /^mr_/);
    assert.equal(second.requestId, first.requestId);
    assert.deepEqual(second.result, first.result);
    assert.equal(second.result?.status, 201);
    assert.equal(readRequests().length, 1);
});

test("solicitudes terminales de más de 30 días pasan a tombstone sin tocar audit ni perder idempotencia", async () => {
    const { state, adapter } = countingAdapter(async () => ({ status: 201 }));
    const first = await submitRequest({ intent, idempotencyKey: "old-terminal" }, { adapter });
    assert.equal(first.status, "EXECUTED");

    const requestPath = join(dir, "requests.json");
    const [record] = readRequests();
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(requestPath, JSON.stringify([{ ...record, createdAt: oldDate, updatedAt: oldDate }]), "utf-8");
    const auditBefore = auditText();

    const retry = await submitRequest({ intent, idempotencyKey: "old-terminal" }, { adapter });
    const tombstone = JSON.parse(readFileSync(requestPath, "utf-8"))[0] as Record<string, unknown>;

    assert.equal(retry.requestId, first.requestId);
    assert.equal(retry.status, "EXECUTED");
    assert.equal(retry.result, null);
    assert.equal(state.calls, 1);
    assert.deepEqual(Object.keys(tombstone).sort(), [
        "createdAt", "idempotencyKey", "payloadHash", "requestId", "rule", "status", "tombstone", "updatedAt", "verdict",
    ]);
    assert.equal(tombstone.tombstone, true);
    assert.equal(auditText(), auditBefore);
    await assert.rejects(
        submitRequest({ intent: { ...intent, target: "https://example.test/other" }, idempotencyKey: "old-terminal" }, { adapter }),
        codeIs("IDEMPOTENCY_KEY_REUSED"),
    );
});

test("rate limit deniega solicitudes nuevas y no cuenta reintentos idempotentes", async () => {
    useMandate({ ...mandateWith("allow"), rateLimitPerSecond: 2 });
    const { state, adapter } = countingAdapter();
    const first = await submitRequest({ intent, idempotencyKey: "rate-1" }, { adapter });
    const second = await submitRequest({ intent, idempotencyKey: "rate-2" }, { adapter });
    const retry = await submitRequest({ intent, idempotencyKey: "rate-1" }, { adapter });
    const limited = await submitRequest({ intent, idempotencyKey: "rate-3" }, { adapter });

    assert.equal(first.verdict, "GREEN");
    assert.equal(second.verdict, "GREEN");
    assert.equal(retry.requestId, first.requestId);
    assert.equal(limited.status, "DENIED");
    assert.equal(limited.verdict, "RED");
    assert.equal(limited.rule, "rateLimit.exceeded");
    assert.equal(state.calls, 2);
    assert.equal(readRequests().length, 2);
    assert.match(auditText(), /rateLimit\.exceeded/);
});

test("el máximo de YELLOW pendientes convierte el siguiente en RED", async () => {
    useMandate({ ...mandateWith("confirm"), rateLimitPerSecond: 100, maxPendingRequests: 1 });
    const { state, adapter } = countingAdapter();
    const first = await submitRequest({ intent, idempotencyKey: "pending-1" }, { adapter, wait: false });
    const second = await submitRequest({ intent, idempotencyKey: "pending-2" }, { adapter, wait: false });

    assert.equal(first.status, "PENDING");
    assert.equal(second.status, "DENIED");
    assert.equal(second.verdict, "RED");
    assert.equal(second.rule, "pending.limitReached");
    assert.equal(describePending().length, 1);
    assert.equal(state.calls, 0);
    assert.match(auditText(), /pending\.limitReached/);
});

test("mandatos de pago con techo inválido o ausente se deniegan sin ejecutar", async () => {
    const { state, adapter } = countingAdapter();
    const paymentIntent: Intent = {
        agentId: "runtime-agent",
        action: "pay",
        tool: "payment.transfer",
        amountEur: 900,
        params: { iban: "ES00 DEMO 0000 0000 0000 0001" },
        effects: [{ kind: "pay", reversible: false }],
    };
    const paymentMandate = {
        version: "1",
        userId: "demo",
        default: "deny",
        rules: [{ effect: "allow", action: "pay", tool: "payment.transfer" }],
    };

    for (const ceilings of [{ perTxEur: "50,00" }, undefined]) {
        useMandate({ ...paymentMandate, ...(ceilings ? { ceilings } : {}) } as unknown as Mandate);
        const result = await submitRequest({ intent: paymentIntent, idempotencyKey: `invalid-limit-${state.calls}-${ceilings ? "text" : "missing"}` }, { adapter, wait: false });
        assert.equal(result.status, "DENIED");
        assert.equal(result.rule, "mandate-unavailable");
    }
    assert.equal(state.calls, 0);
});

test("importes con más de dos decimales se deniegan sin ejecutar ni crear pending", async () => {
    useMandate({
        version: "1",
        userId: "demo",
        default: "deny",
        ceilings: { perTxEur: 100, dailySpendEur: 100 },
        rules: [{ effect: "allow", action: "pay", tool: "payment.transfer" }],
    });
    const { state, adapter } = countingAdapter();
    for (const [index, amountEur] of [0.004, 49.995].entries()) {
        const result = await submitRequest({
            intent: {
                agentId: "runtime-agent",
                action: "pay",
                tool: "payment.transfer",
                amountEur,
                params: { iban: "ES00 DEMO 0000 0000 0000 0001", concept: "demo" },
                effects: [{ kind: "pay", reversible: false }],
            },
            idempotencyKey: `invalid-cents-${index}`,
        }, { adapter, wait: false });
        assert.equal(result.status, "DENIED");
        assert.equal(result.rule, "intent.amountEur");
    }
    assert.equal(state.calls, 0);
    assert.equal(describePending().length, 0);
});

test("dailySpendEur usa timezone del mandato aunque cambie TZ del proceso", () => {
    const previousTimezone = process.env.TZ;
    const records = [{
        action: "pay",
        status: "EXECUTED",
        intent: { amountEur: 10 },
        result: { executedAt: "2026-10-02T23:30:00.000Z" },
        transitions: [],
    }] as unknown as import("./requestStore.js").RequestRecord[];
    try {
        process.env.TZ = "UTC";
        const now = new Date("2026-10-03T00:30:00.000Z");
        assert.equal(dailySpendToday(records, now, "Europe/Madrid"), 10);
        assert.equal(dailySpendToday(records, now, "UTC"), 0);
        process.env.TZ = "America/Los_Angeles";
        assert.equal(dailySpendToday(records, now, "Europe/Madrid"), 10);
    } finally {
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
    }
});

test("el periodo diario queda anclado aunque cambie timezone en mandate.json", () => {
    const records = [{
        action: "pay",
        status: "EXECUTED",
        intent: { amountEur: 199.96 },
        result: { executedAt: "2026-10-03T09:30:00.000Z" },
        transitions: [{ to: "EXECUTING", at: "2026-10-03T09:30:00.000Z" }],
        dailySpendDay: "2026-10-03",
        dailySpendTimezone: "UTC",
    }] as unknown as import("./requestStore.js").RequestRecord[];

    assert.equal(dailySpendToday(records, new Date("2026-10-03T10:30:00.000Z"), "Pacific/Kiritimati"), 199.96);
    assert.equal(dailySpendToday(records, new Date("2026-10-04T00:00:00.000Z"), "Pacific/Kiritimati"), 0);
});

test("runtime deniega mandatos con claves desconocidas", async () => {
    const malformed = { ...mandateWith("allow"), ceilings: { perTxEur: 100, dailySpendEUR: 200 } };
    useMandate(malformed as unknown as Mandate);
    const { state, adapter } = countingAdapter();
    const result = await submitRequest({ intent, idempotencyKey: "mandate-typo" }, { adapter });

    assert.equal(result.status, "DENIED");
    assert.equal(result.rule, "mandate-unavailable");
    assert.equal(state.calls, 0);
});

test("runtime deniega mandate.json con claves duplicadas", async () => {
    writeFileSync(join(dir, "mandate.json"), '{"version":"1","userId":"demo","default":"deny","rules":[],"rules":[{"effect":"allow","action":"write","tool":"http.request"}]}', "utf-8");
    const { state, adapter } = countingAdapter();
    const result = await submitRequest({ intent, idempotencyKey: "mandate-duplicate" }, { adapter });

    assert.equal(result.status, "DENIED");
    assert.equal(result.rule, "mandate-unavailable");
    assert.equal(state.calls, 0);
});

test("runtime deniega ceilings con precisión menor que un céntimo", async () => {
    useMandate({
        version: "1",
        userId: "demo",
        default: "deny",
        ceilings: { perTxEur: 50, dailySpendEur: 0.004 },
        rules: [{ effect: "allow", action: "pay", tool: "payment.transfer" }],
    });
    const { state, adapter } = countingAdapter();
    const result = await submitRequest({
        intent: {
            agentId: "runtime-agent",
            action: "pay",
            tool: "payment.transfer",
            amountEur: 1,
            params: { iban: "ES00 DEMO 0000 0000 0000 0001" },
            effects: [{ kind: "pay", reversible: false }],
        },
    }, { adapter });

    assert.equal(result.status, "DENIED");
    assert.equal(result.rule, "mandate-unavailable");
    assert.equal(state.calls, 0);
});

test("dailySpendEur acumula pagos ejecutados y compara en céntimos", async () => {
    useMandate({
        version: "1",
        userId: "demo",
        default: "deny",
        ceilings: { perTxEur: 100, dailySpendEur: 100 },
        rules: [{ effect: "allow", action: "pay", tool: "payment.transfer" }],
    });
    const { state, adapter } = countingAdapter();
    const payment = (amountEur: number): Intent => ({
        agentId: "runtime-agent",
        action: "pay",
        tool: "payment.transfer",
        amountEur,
        params: { iban: "ES00 DEMO 0000 0000 0000 0001" },
        effects: [{ kind: "pay", reversible: false }],
    });

    const first = await submitRequest({ intent: payment(60), idempotencyKey: "daily-60" }, { adapter });
    const firstRecord = readRequests().find((record) => record.requestId === first.requestId)!;
    assert.equal(firstRecord.dailySpendTimezone, "UTC");
    assert.match(firstRecord.dailySpendDay!, /^\d{4}-\d{2}-\d{2}$/);
    const second = await submitRequest({ intent: payment(40), idempotencyKey: "daily-40" }, { adapter });
    const over = await submitRequest({ intent: payment(0.01), idempotencyKey: "daily-over" }, { adapter });

    assert.equal(first.status, "EXECUTED");
    assert.equal(second.status, "EXECUTED");
    assert.equal(over.status, "DENIED");
    assert.equal(over.rule, "ceilings.dailySpendEur");
    assert.equal(state.calls, 2);
});

test("dailySpendEur reserva pagos en curso frente a solicitudes concurrentes", async () => {
    useMandate({
        version: "1",
        userId: "demo",
        default: "deny",
        ceilings: { perTxEur: 100, dailySpendEur: 100 },
        rules: [{ effect: "allow", action: "pay", tool: "payment.transfer" }],
    });
    const { state, adapter } = countingAdapter(async () => {
        await sleep(40);
        return { status: 200 };
    });
    const payment = (amountEur: number): Intent => ({
        agentId: "runtime-agent",
        action: "pay",
        tool: "payment.transfer",
        amountEur,
        params: { iban: "ES00 DEMO 0000 0000 0000 0001" },
        effects: [{ kind: "pay", reversible: false }],
    });

    const results = await Promise.all([
        submitRequest({ intent: payment(60), idempotencyKey: "daily-race-60" }, { adapter }),
        submitRequest({ intent: payment(50), idempotencyKey: "daily-race-50" }, { adapter }),
    ]);

    assert.deepEqual(results.map((result) => result.status).sort(), ["DENIED", "EXECUTED"]);
    assert.equal(state.calls, 1);
});

test("la vista de pending expone los datos saneados necesarios para aprobar un pago", async () => {
    useMandate({
        version: "1",
        userId: "demo",
        default: "deny",
        ceilings: { perTxEur: 100 },
        rules: [{ effect: "confirm", action: "pay", tool: "payment.transfer" }],
    });
    const result = await submitRequest({
        intent: {
            agentId: "runtime-agent",
            action: "pay",
            tool: "payment.transfer",
            amountEur: 49,
            params: { iban: "XX66 ATTACKER 0000 0000 0001", concept: "Factura demo" },
            effects: [{ kind: "pay", reversible: false }],
        },
    }, { wait: false });
    const [detail] = describePending();

    assert.equal(result.status, "PENDING");
    assert.equal(detail.requestId, result.requestId);
    assert.equal(detail.amountEur, 49);
    assert.equal(detail.params?.iban, "XX66 ATTACKER 0000 0000 0001");
    assert.equal(detail.params?.concept, "Factura demo");
});

test("sin clave, el runtime la deriva del payloadHash", async () => {
    const { state, adapter } = countingAdapter();
    const first = await submitRequest({ intent }, { adapter });
    const second = await submitRequest({ intent }, { adapter });

    assert.equal(first.idempotencyKey, first.payloadHash);
    assert.equal(second.requestId, first.requestId);
    assert.equal(state.calls, 1);
});

test("clave reutilizada con otro payload: IDEMPOTENCY_KEY_REUSED sin ejecutar", async () => {
    const { state, adapter } = countingAdapter();
    await submitRequest({ intent, idempotencyKey: "key-2" }, { adapter });
    await assert.rejects(
        submitRequest({ intent: { ...intent, target: "https://example.test/other" }, idempotencyKey: "key-2" }, { adapter }),
        codeIs("IDEMPOTENCY_KEY_REUSED"),
    );
    assert.equal(state.calls, 1);
});

test("la transición a EXECUTING se persiste antes de llamar al adaptador", async () => {
    let observed: string | undefined;
    const adapter: Adapter = async () => {
        observed = readRequests()[0].status;
        return { status: 200 };
    };
    await submitRequest({ intent }, { adapter });
    assert.equal(observed, "EXECUTING");
});

test("dos approve concurrentes: una ejecución y la otra ALREADY_DECIDED", async () => {
    useMandate(mandateWith("confirm"));
    const { state, adapter } = countingAdapter(async () => { await sleep(50); return { status: 200 }; });
    const pending = await submitRequest({ intent }, { wait: false });
    assert.equal(pending.status, "PENDING");

    const results = await Promise.allSettled([
        approveRequest(pending.requestId, { adapter }),
        approveRequest(pending.requestId, { adapter }),
    ]);

    assert.equal(state.calls, 1);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(codeIs("ALREADY_DECIDED")(rejected[0].reason));
    assert.equal(getRequestStatus(pending.requestId).status, "EXECUTED");
});

test("fallo de escritura antes de ejecutar: RED y el adaptador no se llama", async () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf-8");
    setRequestsPathForTests(join(blocker, "requests.json"));
    const { state, adapter } = countingAdapter();

    const result = await submitRequest({ intent }, { adapter });

    assert.equal(result.status, "DENIED");
    assert.equal(result.verdict, "RED");
    assert.equal(result.rule, "storage.error");
    assert.equal(result.error?.code, "STORAGE_ERROR");
    assert.equal(state.calls, 0);
    assert.match(auditText(), /storage\.error/);
});

test("fallo de lock al guardar tras ejecutar queda UNKNOWN, se audita y no se reintenta", async () => {
    const lockPath = join(dir, "requests.json.lock");
    const { state, adapter: innerAdapter } = countingAdapter();
    const adapter: Adapter = async (...args) => {
        const result = await innerAdapter(...args);
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf-8");
        return result;
    };

    const result = await submitRequest({ intent, idempotencyKey: "storage-write-after-execute" }, { adapter });

    assert.equal(state.calls, 1);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.error?.code, "EXECUTION_UNKNOWN");
    assert.match(result.error?.message ?? "", /may have executed/);
    assert.match(auditText(), /storage\.writeFailedAfterExecution/);
    assert.equal(readRequests()[0].status, "EXECUTING");

    rmSync(lockPath, { force: true });
    const observed = getRequestStatus(result.requestId);
    assert.equal(observed.status, "UNKNOWN");
    assert.ok(observed.transitions.some((entry) => entry.reason === "storage.writeFailedAfterExecution"));

    const retry = await submitRequest({ intent, idempotencyKey: "storage-write-after-execute" }, { adapter });
    assert.equal(retry.status, "UNKNOWN");
    assert.equal(state.calls, 1);
});

test("adaptador que no responde: UNKNOWN y nunca se reintenta", async () => {
    const { state, adapter } = countingAdapter(() => new Promise(() => { /* nunca responde */ }));
    const first = await submitRequest({ intent, idempotencyKey: "key-hang" }, { adapter, executionTimeoutMs: 50 });
    assert.equal(first.status, "UNKNOWN");
    assert.equal(first.error?.code, "EXECUTION_TIMEOUT");

    const again = await submitRequest({ intent, idempotencyKey: "key-hang" }, { adapter, executionTimeoutMs: 50 });
    assert.equal(again.status, "UNKNOWN");
    assert.equal(again.requestId, first.requestId);
    assert.equal(state.calls, 1);
});

test("getRequestStatus convierte una ejecución estancada en UNKNOWN", async () => {
    useMandate(mandateWith("confirm"));
    const pending = await submitRequest({ intent, idempotencyKey: "stale-status" }, { wait: false });
    let finishAdapter!: (result: { status: number }) => void;
    const approval = approveRequest(pending.requestId, {
        executionTimeoutMs: 100,
        adapter: async () => new Promise((resolve) => { finishAdapter = resolve; }),
    });

    try {
        assert.equal(getRequestStatus(pending.requestId).status, "EXECUTING");
        mutateRequests((records) => {
            const record = records.find((item) => item.requestId === pending.requestId);
            assert.ok(record && !isRequestTombstone(record));
            record.updatedAt = new Date(Date.now() - 6_000).toISOString();
        });

        const recovered = getRequestStatus(pending.requestId, { executionTimeoutMs: 100 });
        assert.equal(recovered.status, "UNKNOWN");
        assert.equal(recovered.verdict, "YELLOW");
        assert.equal(recovered.error?.code, "EXECUTION_UNKNOWN");
    } finally {
        finishAdapter?.({ status: 200 });
        await approval;
    }
});

test("adaptador que lanza error: FAILED terminal, sin reintento con la misma clave", async () => {
    const { state, adapter } = countingAdapter(async () => { throw new Error(`boom token=${SECRET_URL_TOKEN}`); });
    const first = await submitRequest({ intent, idempotencyKey: "key-fail" }, { adapter });
    assert.equal(first.status, "FAILED");
    assert.equal(first.error?.code, "ADAPTER_ERROR");
    assert.equal(JSON.stringify(first).includes(SECRET_URL_TOKEN), false);

    const again = await submitRequest({ intent, idempotencyKey: "key-fail" }, { adapter });
    assert.equal(again.status, "FAILED");
    assert.equal(state.calls, 1);
});

test("RED: DENIED con POLICY_DENY y sin ejecutar", async () => {
    useMandate(mandateWith("deny"));
    const { state, adapter } = countingAdapter();
    const view = await submitRequest({ intent }, { adapter });
    assert.equal(view.status, "DENIED");
    assert.equal(view.verdict, "RED");
    assert.equal(view.error?.code, "POLICY_DENY");
    assert.equal(state.calls, 0);
});

test("entradas inválidas devuelven códigos estables", async () => {
    await assert.rejects(submitRequest({ intent: { ...intent, action: "fly" as never } }), codeIs("INVALID_ACTION"));
    await assert.rejects(submitRequest({ intent: null as never }), codeIs("INVALID_REQUEST"));
    await assert.rejects(submitRequest({ intent, idempotencyKey: "" }), codeIs("INVALID_REQUEST"));
    assert.throws(() => getRequestStatus("mr_missing"), codeIs("REQUEST_NOT_FOUND"));
    assert.deepEqual(toErrorShape(new Error("db password=hunter2")), { code: "INTERNAL_ERROR", message: "Internal error.", requestId: undefined, retryable: false });
});

test("audit.jsonl registra cada transición con hash de parámetros y sin secretos", async () => {
    const withSecret = { method: "POST", url: `https://example.test/resource?token=${SECRET_URL_TOKEN}`, body: `{"authorization":"Bearer ${SECRET_URL_TOKEN}"}` };
    const view = await submitRequest({ intent, request: withSecret }, { adapter: async () => ({ status: 200 }) });
    const text = auditText();
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, string>).filter((l) => l.event === "transition");

    assert.deepEqual(lines.map((l) => `${l.from}>${l.to}`), ["RECEIVED>EVALUATING", "EVALUATING>EXECUTING", "EXECUTING>EXECUTED"]);
    for (const line of lines) {
        assert.equal(line.request_id, view.requestId);
        assert.equal(line.params_hash, view.payloadHash);
        assert.ok(line.actor && line.at && line.reason && line.rule);
    }
    assert.equal(text.includes(SECRET_URL_TOKEN), false);
    assert.equal(readFileSync(join(dir, "requests.json"), "utf-8").includes(SECRET_URL_TOKEN), false);
});
