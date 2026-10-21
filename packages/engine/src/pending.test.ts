import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "./evaluate.js";
import { approvePending } from "./adapter.js";
import { appendAudit, setAuditPathForTests } from "./audit.js";
import { withLocalCoreFetch } from "./coreFetchTestHelper.js";
import { createPending, denyPending, markPath, PendingInvalidatedError, resetPendingStoreForTests, setPendingPathForTests } from "./pendingStore.js";
import { startProtectedResourceTestServer } from "./protectedResource.js";
import { setKillPathForTests, writeKillSwitch } from "./kill.js";
import { setMandatePathForTests } from "./policy.js";
import { readPendingHmacKey } from "./secrets.js";
import type { Intent, Mandate } from "../../schema/src/index.js";

const mandate: Mandate = {
    version: "1",
    userId: "demo",
    default: "deny",
    rules: [{ effect: "confirm", action: "write", tool: "http.request", host: "httpbin.org" }],
};

const intent: Intent = {
    agentId: "demo-agent",
    action: "write",
    tool: "http.request",
    target: "https://httpbin.org",
    effects: [{ kind: "write", reversible: false }],
};

function makePending() {
    return createPending({
        agent: intent.agentId,
        action: intent.action,
        method: "POST",
        url: "https://httpbin.org/post?mark=meruntime",
        intent,
    });
}

function canonicalIntentForTest(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalIntentForTest).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalIntentForTest(item)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function simpleIntentHash(intent: Intent): string {
    return createHash("sha256").update(canonicalIntentForTest(intent)).digest("hex");
}

const protectedIntent: Intent = {
    agentId: "demo-agent",
    action: "write",
    tool: "http.request",
    target: "https://protected.local/mark",
    effects: [{ kind: "write", reversible: false }],
};

let testDirectory: string;
let previousSecrets: string | undefined;

beforeEach(() => {
    testDirectory = mkdtempSync(join(tmpdir(), "meruntime-pending-suite-"));
    previousSecrets = process.env.MERUNTIME_SECRETS;
    const secretsPath = join(testDirectory, "secrets.json");
    writeFileSync(secretsPath, JSON.stringify({}), "utf-8");
    process.env.MERUNTIME_SECRETS = secretsPath;
    setPendingPathForTests(join(testDirectory, "pending.json"));
    setAuditPathForTests(join(testDirectory, "audit.jsonl"));
    setKillPathForTests(join(testDirectory, "kill.json"));
    writeKillSwitch(false);
    setMandatePathForTests(undefined);
    resetPendingStoreForTests();
});

afterEach(() => {
    setPendingPathForTests(undefined);
    setAuditPathForTests(undefined);
    setKillPathForTests(undefined);
    setMandatePathForTests(undefined);
    if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
    else process.env.MERUNTIME_SECRETS = previousSecrets;
    rmSync(testDirectory, { recursive: true, force: true });
});

test("YELLOW no ejecuta y crea pending", () => {
    assert.equal(evaluate(mandate, intent, new Date()), "YELLOW");

    const record = makePending();

    assert.equal(record.status, "pending");
    assert.equal(existsSync(markPath(record.id)), false);
});

test("approve ejecuta una vez y crea la marca", async () => {
    const record = makePending();

    const approved = await approvePending(record.id);

    assert.equal(approved.status, "approved");
    assert.equal(approved.execution?.success, true);
    assert.equal(existsSync(markPath(record.id)), true);
    assert.ok(readFileSync(markPath(record.id), "utf-8").length > 0);
});

test("deny no ejecuta y no crea la marca", () => {
    const record = makePending();

    const denied = denyPending(record.id);

    assert.equal(denied.status, "denied");
    assert.equal(existsSync(markPath(record.id)), false);
});

test("segundo approve da error", async () => {
    const record = makePending();

    await approvePending(record.id);

    await assert.rejects(() => approvePending(record.id), /already approved\/executed/);
});

test("approve de id inexistente da error", async () => {
    await assert.rejects(() => approvePending("mr_doesnotexist"), /not found/);
});

test("approve con kill switch activo invalida pending sin ejecutar", async () => {
    const secretsPath = join(testDirectory, "secrets.json");
    const token = "pending-kill-test-token";
    writeFileSync(secretsPath, JSON.stringify({ protectedToken: token }), "utf-8");
    const server = await startProtectedResourceTestServer({ expectedToken: token });
    const previousSecrets = process.env.MERUNTIME_SECRETS;
    process.env.MERUNTIME_SECRETS = secretsPath;

    try {
        const record = createPending({
            agent: protectedIntent.agentId,
            action: protectedIntent.action,
            method: "POST",
            url: "https://protected.local/mark",
            intent: protectedIntent,
        });
        writeKillSwitch(true);

        await withLocalCoreFetch(server, async () => {
            await assert.rejects(() => approvePending(record.id), PendingInvalidatedError);
        });

        const stored = JSON.parse(readFileSync(join(testDirectory, "pending.json"), "utf-8")) as Array<{ id: string; status: string }>;
        assert.equal(stored.find((item) => item.id === record.id)?.status, "invalidated");
        assert.equal(server.executionCount(), 0);
        assert.match(readFileSync(join(testDirectory, "audit.jsonl"), "utf-8"), /"decision":"invalidated"/);
    } finally {
        await server.close();
        if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
        else process.env.MERUNTIME_SECRETS = previousSecrets;
    }
});

test("approve invalida pending si el mandato vigente ahora deniega el intent", async () => {
    const mandatePath = join(testDirectory, "mandate.json");
    setMandatePathForTests(mandatePath);
    writeFileSync(mandatePath, JSON.stringify({
        ...mandate,
        denyActions: ["write"],
        rules: [{ effect: "allow", action: "write", tool: "http.request", host: "httpbin.org" }],
    }), "utf-8");
    const record = makePending();

    await assert.rejects(() => approvePending(record.id), PendingInvalidatedError);

    const stored = JSON.parse(readFileSync(join(testDirectory, "pending.json"), "utf-8")) as Array<{ id: string; status: string }>;
    assert.equal(stored.find((item) => item.id === record.id)?.status, "invalidated");
    assert.equal(existsSync(markPath(record.id)), false);
});

test("recalcular un SHA-256 simple tras editar el intent no valida el pending", async () => {
    const record = createPending({
        agent: protectedIntent.agentId,
        action: protectedIntent.action,
        method: "POST",
        url: "https://protected.local/mark",
        intent: protectedIntent,
    });
    const pendingPath = join(testDirectory, "pending.json");
    const stored = JSON.parse(readFileSync(pendingPath, "utf-8")) as Array<{ id: string; intent: Intent; intentMac: string; intentHash?: string; status: string }>;
    stored[0].intent.target = "https://api.github.com/user";
    stored[0].intentHash = simpleIntentHash(stored[0].intent);
    writeFileSync(pendingPath, JSON.stringify(stored), "utf-8");

    await assert.rejects(() => approvePending(record.id), /intent MAC mismatch/);

    const invalidated = JSON.parse(readFileSync(pendingPath, "utf-8")) as Array<{ id: string; status: string }>;
    assert.equal(invalidated.find((item) => item.id === record.id)?.status, "invalidated");
    assert.equal(existsSync(markPath(record.id)), false);
});

test("copiar intentMac entre pendings invalida el segundo", async () => {
    const first = createPending({
        agent: "agent-one",
        action: "write",
        method: "POST",
        url: "https://protected.local/mark?request=one",
        intent: { ...protectedIntent, agentId: "agent-one" },
    });
    const second = createPending({
        agent: "agent-two",
        action: "write",
        method: "POST",
        url: "https://protected.local/mark?request=two",
        intent: { ...protectedIntent, agentId: "agent-two" },
    });
    const pendingPath = join(testDirectory, "pending.json");
    const stored = JSON.parse(readFileSync(pendingPath, "utf-8")) as Array<{ id: string; intentMac: string; status: string }>;
    stored.find((item) => item.id === second.id)!.intentMac = stored.find((item) => item.id === first.id)!.intentMac;
    writeFileSync(pendingPath, JSON.stringify(stored), "utf-8");

    await assert.rejects(() => approvePending(second.id), /intent MAC mismatch/);

    const invalidated = JSON.parse(readFileSync(pendingPath, "utf-8")) as Array<{ id: string; status: string }>;
    assert.equal(invalidated.find((item) => item.id === second.id)?.status, "invalidated");
});

test("pending legacy con solo intentHash se invalida", async () => {
    const record = makePending();
    const pendingPath = join(testDirectory, "pending.json");
    const stored = JSON.parse(readFileSync(pendingPath, "utf-8")) as Array<{ id: string; intent: Intent; intentMac?: string; intentHash?: string }>;
    delete stored[0].intentMac;
    stored[0].intentHash = simpleIntentHash(stored[0].intent);
    writeFileSync(pendingPath, JSON.stringify(stored), "utf-8");

    await assert.rejects(() => approvePending(record.id), /intent MAC mismatch/);

    const invalidated = JSON.parse(readFileSync(pendingPath, "utf-8")) as Array<{ id: string; status: string }>;
    assert.equal(invalidated.find((item) => item.id === record.id)?.status, "invalidated");
});

test("pendingHmacKey no aparece en pending.json, audit.jsonl ni errores", async () => {
    const secretsPath = join(testDirectory, "secrets.json");
    rmSync(secretsPath);
    const key = readPendingHmacKey();
    const keyHex = key.toString("hex");
    const secrets = JSON.parse(readFileSync(secretsPath, "utf-8")) as { pendingHmacKey: string };
    assert.equal(secrets.pendingHmacKey, keyHex);
    assert.deepEqual(readPendingHmacKey(), key);
    const record = makePending();
    appendAudit({
        event: "request",
        request_id: record.id,
        agent: record.agent,
        action: record.action,
        decision: "YELLOW",
        reason: `pendingHmacKey=${keyHex}`,
    });

    const pendingText = readFileSync(join(testDirectory, "pending.json"), "utf-8");
    const auditText = readFileSync(join(testDirectory, "audit.jsonl"), "utf-8");
    assert.equal(pendingText.includes(keyHex), false);
    assert.equal(pendingText.includes("pendingHmacKey"), false);
    assert.equal(auditText.includes(keyHex), false);
    assert.equal(auditText.includes("pendingHmacKey"), false);
    await assert.rejects(
        () => approvePending("missing-pending"),
        (error) => error instanceof Error && !error.message.includes(keyHex),
    );
});

test("dos POST iguales a protected.local/mark reutilizan un solo mr_", () => {
    const first = createPending({
        agent: protectedIntent.agentId,
        action: protectedIntent.action,
        method: "POST",
        url: "https://protected.local/mark",
        body: "{}",
        intent: protectedIntent,
    });
    const second = createPending({
        agent: protectedIntent.agentId,
        action: protectedIntent.action,
        method: "POST",
        url: "https://protected.local/mark",
        body: "{}",
        intent: protectedIntent,
    });

    assert.equal(second.id, first.id);
    assert.equal(second.status, "pending");
});

test("un approve de la ficha deduplicada ejecuta una vez y el segundo approve falla", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "meruntime-idempotency-"));
    const pendingPath = join(tempDir, "pending.json");
    const secretsPath = join(tempDir, "secrets.json");
    const token = "idempotency-test-token";
    writeFileSync(secretsPath, JSON.stringify({ protectedToken: token }), "utf-8");
    const server = await startProtectedResourceTestServer({ expectedToken: token });
    setPendingPathForTests(pendingPath);
    const previousSecrets = process.env.MERUNTIME_SECRETS;
    process.env.MERUNTIME_SECRETS = secretsPath;
    try {
        const first = createPending({
            agent: protectedIntent.agentId,
            action: protectedIntent.action,
            method: "POST",
            url: "https://protected.local/mark",
            body: "same-body",
            intent: protectedIntent,
        });
        const second = createPending({
            agent: protectedIntent.agentId,
            action: protectedIntent.action,
            method: "POST",
            url: "https://protected.local/mark",
            body: "same-body",
            intent: protectedIntent,
        });

        assert.equal(second.id, first.id);
        await withLocalCoreFetch(server, async () => {
            const approved = await approvePending(first.id);
            assert.equal(approved.execution?.success, true);
            assert.equal(server.executionCount(), 1);
            await assert.rejects(() => approvePending(second.id), /already approved\/executed/);
        });
    } finally {
        await server.close();
        resetPendingStoreForTests();
        setPendingPathForTests(undefined);
        if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
        else process.env.MERUNTIME_SECRETS = previousSecrets;
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("un POST con body distinto crea otro mr_", () => {
    const first = createPending({
        agent: protectedIntent.agentId,
        action: protectedIntent.action,
        method: "POST",
        url: "https://protected.local/mark",
        body: "body-a",
        intent: protectedIntent,
    });
    const second = createPending({
        agent: protectedIntent.agentId,
        action: protectedIntent.action,
        method: "POST",
        url: "https://protected.local/mark",
        body: "body-b",
        intent: protectedIntent,
    });

    assert.notEqual(second.id, first.id);
});
