import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBank, type FakeBank } from "../../fakebank/src/server.js";
import { intentFromPayment } from "../../proxy/src/intentFromTool.js";
import { executeAuthorized } from "./adapter.js";
import { setAuditPathForTests } from "./audit.js";
import { RuntimeError } from "./errors.js";
import { setKillPathForTests, writeKillSwitch } from "./kill.js";
import { setBankUrlForTests } from "./paymentAdapter.js";
import { setPendingPathForTests } from "./pendingStore.js";
import { setMandatePathForTests } from "./policy.js";
import { approveRequest, denyRequest, submitRequest } from "./requestRuntime.js";
import { validateMandate } from "../../schema/src/index.js";

const BANK_TOKEN = "fakebank-test-token-abc123";
const KNOWN_IBAN = "ES00 DEMO 0000 0000 0000 0001";
const NEW_IBAN = "ES00 EVIL 0000 0000 0000 0666";
const PAGOS = join(import.meta.dirname, "..", "..", "..", "examples", "mandates", "pagos.json");

let dir: string;
let bank: FakeBank;
let previousSecrets: string | undefined;

const pay = (iban: string, amountEur: number) => intentFromPayment({ agentId: "payment-agent", iban, amountEur, concept: "Factura 2026-0042" });
const codeIs = (code: string) => (error: unknown) => error instanceof RuntimeError && error.code === code;

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "meruntime-payment-"));
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ fakeBankToken: BANK_TOKEN }), "utf-8");
    previousSecrets = process.env.MERUNTIME_SECRETS;
    process.env.MERUNTIME_SECRETS = join(dir, "secrets.json");
    bank = await startFakeBank({ token: BANK_TOKEN, port: 0 });
    setBankUrlForTests(bank.url);
    setMandatePathForTests(PAGOS);
    setKillPathForTests(join(dir, "kill.json"));
    writeKillSwitch(false);
    setPendingPathForTests(join(dir, "pending.json"));
    setAuditPathForTests(join(dir, "audit.jsonl"));
});

afterEach(async () => {
    await bank.close();
    setBankUrlForTests(undefined);
    setMandatePathForTests(undefined);
    setKillPathForTests(undefined);
    setPendingPathForTests(undefined);
    setAuditPathForTests(undefined);
    if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
    else process.env.MERUNTIME_SECRETS = previousSecrets;
    rmSync(dir, { recursive: true, force: true });
});

test("los mandatos de ejemplo cumplen el schema", () => {
    assert.deepEqual(validateMandate(JSON.parse(readFileSync(PAGOS, "utf-8"))), []);
    assert.deepEqual(validateMandate(JSON.parse(readFileSync(join(PAGOS, "..", "personal.json"), "utf-8"))), []);
    assert.ok(validateMandate({ version: 1, rules: "x", knownIbans: [1] }).length >= 3);
});

test("pago GREEN a IBAN conocido ejecuta una sola vez en el banco", async () => {
    const view = await submitRequest({ intent: pay(KNOWN_IBAN, 35) });

    assert.equal(view.status, "EXECUTED");
    assert.equal(view.verdict, "GREEN");
    assert.equal(bank.transfers().length, 1);
    assert.equal(view.result?.data?.transferId, bank.transfers()[0].transferId);
});

test("reintento con la misma idempotency_key: una sola transferencia", async () => {
    const first = await submitRequest({ intent: pay(KNOWN_IBAN, 35), idempotencyKey: "invoice-42" });
    const retry = await submitRequest({ intent: pay(KNOWN_IBAN, 35), idempotencyKey: "invoice-42" });
    const viaCore = await executeAuthorized(pay(KNOWN_IBAN, 35), { idempotencyKey: "invoice-42" });

    assert.equal(retry.requestId, first.requestId);
    assert.deepEqual(viaCore, { success: true, status: 201 });
    assert.equal(bank.transfers().length, 1);
});

test("YELLOW (IBAN nuevo) denegado: el banco queda vacío", async () => {
    const view = await submitRequest({ intent: pay(NEW_IBAN, 35) }, { wait: false });
    assert.equal(view.status, "PENDING");
    assert.equal(view.verdict, "YELLOW");
    assert.equal(view.rule, "payees.unknownIban");

    assert.equal(denyRequest(view.requestId).status, "DENIED");
    assert.equal(bank.transfers().length, 0);
});

test("YELLOW sin decisión: EXPIRED y el banco queda vacío", async () => {
    const view = await submitRequest({ intent: pay(NEW_IBAN, 35) }, { approvalTimeoutMs: 80, pollMs: 10 });

    assert.equal(view.status, "EXPIRED");
    assert.equal(bank.transfers().length, 0);
});

test("pago por encima de perTxEur: RED inmediato y banco vacío", async () => {
    const view = await submitRequest({ intent: pay(NEW_IBAN, 500) });

    assert.equal(view.status, "DENIED");
    assert.equal(view.verdict, "RED");
    assert.equal(view.rule, "ceilings.perTxEur");
    assert.equal(bank.transfers().length, 0);
});

test("YELLOW aprobado ejecuta una vez y requestId es la Idempotency-Key del banco", async () => {
    const pending = await submitRequest({ intent: pay(NEW_IBAN, 35) }, { wait: false });
    const done = await approveRequest(pending.requestId);
    await assert.rejects(approveRequest(pending.requestId), codeIs("ALREADY_DECIDED"));

    assert.equal(done.status, "EXECUTED");
    assert.equal(bank.transfers().length, 1);
    const replay = await fetch(`${bank.url}/transfers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${BANK_TOKEN}`, "Idempotency-Key": pending.requestId },
        body: JSON.stringify({ iban: NEW_IBAN, amountEur: 35, concept: "Factura 2026-0042" }),
    });
    assert.equal(replay.status, 200);
    assert.equal(bank.transfers().length, 1);
});

test("el banco no acepta sin token y respeta la idempotencia por cuerpo", async () => {
    const post = (headers: Record<string, string>, body: object) =>
        fetch(`${bank.url}/transfers`, { method: "POST", headers, body: JSON.stringify(body) });
    const auth = { Authorization: `Bearer ${BANK_TOKEN}`, "Idempotency-Key": "k1" };
    const body = { iban: KNOWN_IBAN, amountEur: 10, concept: "x" };

    assert.equal((await post({ "Idempotency-Key": "k1" }, body)).status, 401);
    assert.equal((await post({ Authorization: "Bearer wrong", "Idempotency-Key": "k1" }, body)).status, 401);
    const first = await post(auth, body);
    const same = await post(auth, body);
    assert.equal(first.status, 201);
    assert.deepEqual(await same.json(), await first.json());
    assert.equal((await post(auth, { ...body, amountEur: 11 })).status, 409);
    assert.equal(bank.transfers().length, 1);
    const listed = (await (await fetch(`${bank.url}/transfers`)).json()) as { transfers: unknown[] };
    assert.equal(listed.transfers.length, 1);
});

test("una herramienta sin adaptador da INVALID_ACTION", async () => {
    const intent = { ...pay(KNOWN_IBAN, 35), tool: "wire.unknown" };
    await assert.rejects(submitRequest({ intent }), codeIs("INVALID_ACTION"));
});

test("el banco no responde: UNKNOWN y sin reintento", async () => {
    const slow = await startFakeBank({ token: BANK_TOKEN, port: 0, latencyMs: 300 });
    setBankUrlForTests(slow.url);
    try {
        const first = await submitRequest({ intent: pay(KNOWN_IBAN, 35), idempotencyKey: "slow-1" }, { executionTimeoutMs: 50 });
        const again = await submitRequest({ intent: pay(KNOWN_IBAN, 35), idempotencyKey: "slow-1" }, { executionTimeoutMs: 50 });
        await new Promise((resolve) => setTimeout(resolve, 500));

        assert.equal(first.status, "UNKNOWN");
        assert.equal(again.status, "UNKNOWN");
        assert.ok(slow.transfers().length <= 1);
    } finally {
        await slow.close();
    }
});

test("el token del banco nunca aparece en respuestas, audit.jsonl ni requests.json", async () => {
    const views = [
        await submitRequest({ intent: pay(KNOWN_IBAN, 35) }),
        await submitRequest({ intent: pay(NEW_IBAN, 500) }),
        await submitRequest({ intent: pay(NEW_IBAN, 20) }, { approvalTimeoutMs: 50, pollMs: 10 }),
    ];
    const pending = await submitRequest({ intent: pay(NEW_IBAN, 21) }, { wait: false });
    views.push(await approveRequest(pending.requestId));

    assert.equal(JSON.stringify(views).includes(BANK_TOKEN), false);
    assert.equal(readFileSync(join(dir, "audit.jsonl"), "utf-8").includes(BANK_TOKEN), false);
    assert.equal(readFileSync(join(dir, "requests.json"), "utf-8").includes(BANK_TOKEN), false);
});
