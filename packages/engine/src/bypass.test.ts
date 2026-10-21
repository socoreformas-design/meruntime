import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as corePublicApi from "./adapter.js";
import { approvePending, CoreAuthorizationError, executeAuthorized } from "./adapter.js";
import { setAuditPathForTests } from "./audit.js";
import { withLocalCoreFetch } from "./coreFetchTestHelper.js";
import { createPending, setPendingPathForTests } from "./pendingStore.js";
import { evaluate } from "./evaluate.js";
import { startProtectedResourceTestServer } from "./protectedResource.js";
import { setKillPathForTests, writeKillSwitch } from "./kill.js";
import { setMandatePathForTests } from "./policy.js";
import type { Intent, Mandate } from "../../schema/src/index.js";

const protectedIntent: Intent = {
    agentId: "demo-agent",
    action: "write",
    tool: "http.request",
    target: "https://protected.local/mark",
    effects: [{ kind: "write", reversible: false }],
};

const confirmMandate: Mandate = {
    version: "1",
    userId: "demo",
    default: "deny",
    rules: [{ effect: "confirm", action: "write", tool: "http.request", host: "protected.local" }],
};

const allowMandate: Mandate = {
    version: "1",
    userId: "demo",
    default: "deny",
    rules: [{ effect: "allow", action: "write", tool: "http.request", host: "protected.local" }],
};

async function createFixture(mandate: Mandate = allowMandate) {
    const tempDir = mkdtempSync(join(tmpdir(), "meruntime-bypass-"));
    const secretsPath = join(tempDir, "secrets.json");
    const mandatePath = join(tempDir, "mandate.json");
    const auditPath = join(tempDir, "audit.jsonl");
    const token = "bypass-test-only-key";
    writeFileSync(secretsPath, JSON.stringify({ protectedToken: token }), "utf-8");
    writeFileSync(mandatePath, JSON.stringify(mandate), "utf-8");
    const server = await startProtectedResourceTestServer({ expectedToken: token });
    const previousSecrets = process.env.MERUNTIME_SECRETS;
    process.env.MERUNTIME_SECRETS = secretsPath;
    setMandatePathForTests(mandatePath);
    setKillPathForTests(join(tempDir, "kill.json"));
    writeKillSwitch(false);
    setPendingPathForTests(join(tempDir, "pending.json"));
    setAuditPathForTests(auditPath);
    return {
        server,
        token,
        auditPath,
        cleanup: async () => {
            await server.close();
            setMandatePathForTests(undefined);
            setKillPathForTests(undefined);
            setPendingPathForTests(undefined);
            setAuditPathForTests(undefined);
            if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
            else process.env.MERUNTIME_SECRETS = previousSecrets;
            rmSync(tempDir, { recursive: true, force: true });
        },
    };
}

test("CORE expone ejecución solo por executeAuthorized y no devuelve el secreto", async () => {
    const fixture = await createFixture();
    try {
        assert.equal("getSecrets" in corePublicApi, false);
        assert.equal("executeAllowed" in corePublicApi, false);
        assert.equal("createCoreAdapter" in corePublicApi, false);
        await withLocalCoreFetch(fixture.server, async () => {
            const result = await executeAuthorized(protectedIntent);
            assert.equal(JSON.stringify(result).includes(fixture.token), false);
            assert.deepEqual(result, { success: true, status: 200 });
            assert.equal(fixture.server.executionCount(), 1);
        });
    } finally {
        await fixture.cleanup();
    }
});

test("executeAuthorized rechaza RED directamente y no ejecuta", async () => {
    const fixture = await createFixture({ ...allowMandate, denyActions: ["write"] });
    try {
        await withLocalCoreFetch(fixture.server, async () => {
            await assert.rejects(
                executeAuthorized(protectedIntent),
                (error) => error instanceof CoreAuthorizationError && error.verdict === "RED",
            );
        });
        assert.equal(fixture.server.executionCount(), 0);
        assert.match(readFileSync(fixture.auditPath, "utf-8"), /"decision":"RED"/);
    } finally {
        await fixture.cleanup();
    }
});

test("bypass: AGENTE → recurso directo SIN token → 401 y contador 0", async () => {
    const server = await startProtectedResourceTestServer({ expectedToken: "core-only-test-key" });

    try {
        const response = await fetch(server.url, { method: "POST" });
        assert.equal(response.status, 401);
        assert.equal(server.executionCount(), 0);
    } finally {
        await server.close();
    }
});

test("autoridad: request YELLOW → aprobación persistida → CORE → recurso", async () => {
    const fixture = await createFixture(confirmMandate);
    const approvalIntent = { ...protectedIntent, agentId: "approval-agent" };
    try {
        const verdict = evaluate(confirmMandate, approvalIntent, new Date());
        assert.equal(verdict, "YELLOW");

        const record = createPending({
            agent: approvalIntent.agentId,
            action: approvalIntent.action,
            method: "POST",
            url: approvalIntent.target!,
            intent: approvalIntent,
        });
        await withLocalCoreFetch(fixture.server, async () => {
            const approved = await approvePending(record.id);
            assert.equal(approved.status, "approved");
            assert.equal(approved.execution?.success, true);
            assert.equal(fixture.server.executionCount(), 1);
            assert.equal(JSON.stringify(approved).includes(fixture.token), false);
        });
    } finally {
        await fixture.cleanup();
    }
});

test("única ruta: sin CORE no hay capacidad", async () => {
    const fixture = await createFixture();
    try {
        const fakeAgent = {
            ask(): Intent {
                return { ...protectedIntent };
            },
        };
        const intent = fakeAgent.ask();

        assert.equal("executeAllowed" in fakeAgent, false);
        assert.equal("secrets" in fakeAgent, false);

        assert.equal("executeAllowed" in corePublicApi, false);
        assert.equal("executeAuthorized" in fakeAgent, false);
        assert.equal("secrets" in fakeAgent, false);
    } finally {
        await fixture.cleanup();
    }
});