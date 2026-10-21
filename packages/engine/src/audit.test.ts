import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, readAuditLines, setAuditPathForTests } from "./audit.js";
import { evaluate } from "./evaluate.js";
import { approvePending } from "./adapter.js";
import { setKillPathForTests, writeKillSwitch } from "./kill.js";
import { createPending, denyPending, resetPendingStoreForTests } from "./pendingStore.js";
import type { Intent, Mandate } from "../../schema/src/index.js";

let tmpDir: string;
let auditPath: string;
let killPath: string;
let previousSecrets: string | undefined;

before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "meruntime-audit-"));
    auditPath = join(tmpDir, "audit.jsonl");
    killPath = join(tmpDir, "kill.json");
    const secretsPath = join(tmpDir, "secrets.json");
    writeFileSync(secretsPath, JSON.stringify({}), "utf-8");
    previousSecrets = process.env.MERUNTIME_SECRETS;
    process.env.MERUNTIME_SECRETS = secretsPath;
    setAuditPathForTests(auditPath);
    setKillPathForTests(killPath);
});

after(() => {
    setAuditPathForTests(undefined);
    setKillPathForTests(undefined);
    if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
    else process.env.MERUNTIME_SECRETS = previousSecrets;
    rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    if (existsSync(auditPath)) rmSync(auditPath);
    writeKillSwitch(false);
    resetPendingStoreForTests();
});

const denyMandate: Mandate = {
    version: "1",
    userId: "demo",
    default: "deny",
    denyHosts: ["evil.example"],
    rules: [],
};

const confirmMandate: Mandate = {
    version: "1",
    userId: "demo",
    default: "deny",
    rules: [{ effect: "confirm", action: "write", tool: "http.request", host: "httpbin.org" }],
};

const writeIntent: Intent = {
    agentId: "demo-agent",
    action: "write",
    tool: "http.request",
    target: "https://httpbin.org",
    effects: [{ kind: "write", reversible: false }],
};

function makePending() {
    return createPending({
        agent: writeIntent.agentId,
        action: writeIntent.action,
        method: "POST",
        url: "https://httpbin.org/post?mark=meruntime",
        intent: writeIntent,
    });
}

test("un request RED deja 1 línea en audit.jsonl", () => {
    const intent: Intent = {
        agentId: "demo-agent",
        action: "read",
        tool: "http.request",
        target: "https://evil.example",
        effects: [{ kind: "read", reversible: true }],
    };
    const verdict = evaluate(denyMandate, intent, new Date());
    assert.equal(verdict, "RED");

    appendAudit({
        event: "request",
        request_id: null,
        agent: intent.agentId,
        action: intent.action,
        decision: verdict,
        reason: "GET https://evil.example",
    });

    const lines = readAuditLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].decision, "RED");
});

test("un request YELLOW deja 1 línea en audit.jsonl", () => {
    const verdict = evaluate(confirmMandate, writeIntent, new Date());
    assert.equal(verdict, "YELLOW");

    const record = makePending();
    appendAudit({
        event: "request",
        request_id: record.id,
        agent: writeIntent.agentId,
        action: writeIntent.action,
        decision: verdict,
        reason: "POST https://httpbin.org/post?mark=meruntime",
    });

    const lines = readAuditLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].decision, "YELLOW");
    assert.equal(lines[0].request_id, record.id);
});

test("approve añade evento execute", async () => {
    const record = makePending();
    const approved = await approvePending(record.id);

    appendAudit({
        event: "execute",
        request_id: approved.id,
        agent: approved.agent,
        action: approved.action,
        decision: approved.execution?.success ? "executed" : "blocked",
        reason: "approved and executed",
    });

    const lines = readAuditLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "execute");
    assert.equal(lines[0].decision, "executed");
});

test("deny añade evento denied", () => {
    const record = makePending();
    const denied = denyPending(record.id);

    appendAudit({
        event: "deny",
        request_id: denied.id,
        agent: denied.agent,
        action: denied.action,
        decision: "denied",
        reason: "human denied",
    });

    const lines = readAuditLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "deny");
    assert.equal(lines[0].decision, "denied");
});
