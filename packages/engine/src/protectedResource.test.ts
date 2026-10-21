import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAuthorized } from "./adapter.js";
import { appendAudit, setAuditPathForTests } from "./audit.js";
import { withLocalCoreFetch } from "./coreFetchTestHelper.js";
import { createPending, setPendingPathForTests } from "./pendingStore.js";
import { startProtectedResourceTestServer } from "./protectedResource.js";
import { setKillPathForTests, writeKillSwitch } from "./kill.js";
import { setMandatePathForTests } from "./policy.js";
import { getDefaultSecretsPath } from "./secrets.js";
import { MERUNTIME_DIR, resolveMeruntimeDir } from "./paths.js";
import type { Intent, Mandate } from "../../schema/src/index.js";

const intent: Intent = {
    agentId: "demo-agent",
    action: "write",
    tool: "http.request",
    target: "https://protected.local/mark",
    effects: [{ kind: "write", reversible: false }],
};

test("protected resource rejects missing or invalid tokens without an execution", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "meruntime-protected-bypass-"));
    const server = await startProtectedResourceTestServer({ expectedToken: "correct-test-token" });

    try {
        const missingToken = await fetch(server.url, { method: "POST" });
        const wrongToken = await fetch(server.url, { method: "POST", headers: { Authorization: "Bearer wrong-test-token" } });
        assert.equal(missingToken.status, 401);
        assert.equal(wrongToken.status, 401);
        assert.equal(server.executionCount(), 0);
    } finally {
        await server.close();
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("executeAuthorized adds the protected header only after GREEN", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "meruntime-core-adapter-"));
    const secretsPath = join(tempDir, "secrets.json");
    const mandatePath = join(tempDir, "mandate.json");
    const token = "test-only-secret-token";
    writeFileSync(secretsPath, JSON.stringify({ protectedToken: token }), "utf-8");
    const mandate: Mandate = {
        version: "1",
        userId: "test",
        default: "deny",
        rules: [{ effect: "allow", action: "write", tool: "http.request", host: "protected.local" }],
    };
    writeFileSync(mandatePath, JSON.stringify(mandate), "utf-8");
    const server = await startProtectedResourceTestServer({ expectedToken: token });

    const previousSecrets = process.env.MERUNTIME_SECRETS;
    process.env.MERUNTIME_SECRETS = secretsPath;
    setMandatePathForTests(mandatePath);
    setKillPathForTests(join(tempDir, "kill.json"));
    writeKillSwitch(false);
    setPendingPathForTests(join(tempDir, "pending.json"));

    try {
        await withLocalCoreFetch(server, async () => {
            const result = await executeAuthorized(intent);
            assert.deepEqual(result, { success: true, status: 200 });
            assert.equal(server.executionCount(), 1);
            assert.equal(JSON.stringify(result).includes(token), false);
            await executeAuthorized(intent);
            assert.equal(server.executionCount(), 1);
        });
    } finally {
        setMandatePathForTests(undefined);
        setKillPathForTests(undefined);
        setPendingPathForTests(undefined);
        if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
        else process.env.MERUNTIME_SECRETS = previousSecrets;
        await server.close();
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("CORE authenticates GitHub /user only with its local githubToken", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "meruntime-github-core-"));
    const secretsPath = join(tempDir, "secrets.json");
    const killPath = join(tempDir, "kill.json");
    const token = "github-test-only-token";
    const server = await startProtectedResourceTestServer({ expectedToken: token });
    const githubIntent: Intent = {
        ...intent,
        action: "read",
        target: "https://api.github.com/user",
        effects: [{ kind: "read", reversible: true }],
    };
    const previousSecrets = process.env.MERUNTIME_SECRETS;
    process.env.MERUNTIME_SECRETS = secretsPath;
    setKillPathForTests(killPath);
    writeKillSwitch(false);
    setPendingPathForTests(join(tempDir, "pending.json"));

    try {
        const unauthenticated = await fetch(server.githubUserUrl);
        assert.equal(unauthenticated.status, 401);
        await withLocalCoreFetch(server, async () => {
            await assert.rejects(executeAuthorized(githubIntent, { idempotencyKey: "github-attempt-1" }), /status 401/);

            writeFileSync(secretsPath, JSON.stringify({ githubToken: token }), "utf-8");
            // FAILED es terminal: reintentar exige una clave nueva.
            const result = await executeAuthorized(githubIntent, { idempotencyKey: "github-attempt-2" });

            assert.deepEqual(result, { success: true, status: 200 });
            assert.equal(server.executionCount(), 1);
            assert.equal(JSON.stringify(result).includes(token), false);
        });
    } finally {
        setKillPathForTests(undefined);
        setPendingPathForTests(undefined);
        if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
        else process.env.MERUNTIME_SECRETS = previousSecrets;
        await server.close();
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test("la ruta de secretos por defecto está fuera del repo", () => {
    assert.equal(resolveMeruntimeDir({}, "/home/u"), join("/home/u", ".meruntime"));
    assert.equal(resolveMeruntimeDir({ MERUNTIME_HOME: "/custom" }, "/home/u"), "/custom");
    assert.equal(getDefaultSecretsPath(), join(MERUNTIME_DIR, "secrets.json"));
    assert.notEqual(getDefaultSecretsPath(), join(process.cwd(), ".meruntime", "secrets.json"));
});

test("pending and audit redact credential fields and values", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "meruntime-redaction-"));
    const token = "sensitive-test-value";
    const pendingPath = join(tempDir, "pending.json");
    const auditPath = join(tempDir, "audit.jsonl");
    const secretsPath = join(tempDir, "secrets.json");
    const previousSecrets = process.env.MERUNTIME_SECRETS;
    writeFileSync(secretsPath, JSON.stringify({}), "utf-8");
    process.env.MERUNTIME_SECRETS = secretsPath;
    setPendingPathForTests(pendingPath);
    setAuditPathForTests(auditPath);

    try {
        const sensitiveIntent = {
            ...intent,
            target: `https://protected.local/mark?githubToken=${token}`,
            authorization: `Bearer ${token}`,
            nested: { protectedToken: token, githubToken: token, pendingHmacKey: token, safe: "retained" },
        } as unknown as Intent;
        const record = createPending({
            agent: intent.agentId,
            action: intent.action,
            method: "POST",
            url: `https://protected.local/mark?githubToken=${token}`,
            body: JSON.stringify({ authorization: token, safe: "retained" }),
            intent: sensitiveIntent,
        });
        appendAudit({
            event: "request",
            request_id: record.id,
            agent: intent.agentId,
            action: intent.action,
            decision: "YELLOW",
            reason: `protectedToken=${token} githubToken=${token}`,
        });

        const pendingText = JSON.stringify(record);
        const auditText = readFileSync(auditPath, "utf-8");
        assert.equal(pendingText.includes(token), false);
        assert.equal(pendingText.includes("githubToken"), false);
        assert.equal(auditText.includes(token), false);
        assert.equal(auditText.includes("githubToken"), false);
        assert.equal("authorization" in (record.intent as unknown as Record<string, unknown>), false);
        assert.equal("protectedToken" in ((record.intent as unknown as { nested: Record<string, unknown> }).nested), false);
        assert.equal("githubToken" in ((record.intent as unknown as { nested: Record<string, unknown> }).nested), false);
        assert.equal("pendingHmacKey" in ((record.intent as unknown as { nested: Record<string, unknown> }).nested), false);
    } finally {
        setPendingPathForTests(undefined);
        setAuditPathForTests(undefined);
        if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
        else process.env.MERUNTIME_SECRETS = previousSecrets;
        rmSync(tempDir, { recursive: true, force: true });
    }
});