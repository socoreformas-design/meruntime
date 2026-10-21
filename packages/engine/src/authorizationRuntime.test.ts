import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuditLines, setAuditPathForTests } from "./audit.js";
import { setAuthorizationPathForTests, getAuthorizationPath } from "./authorizationStore.js";
import { approveAuthorization, authorizeCommand, denyAuthorization, getAuthorization, listPendingAuthorizations } from "./authorizationRuntime.js";
import { setKillPathForTests, writeKillSwitch } from "./kill.js";
import { setMandatePathForTests } from "./policy.js";
import { setRequestsPathForTests } from "./requestStore.js";
import { submitRequest } from "./requestRuntime.js";
import { intentFromHttp } from "../../proxy/src/intentFromTool.js";

let dir: string;
let oldSecrets: string | undefined;
let oldHome: string | undefined;

function setMandate(rules: Array<{ effect: "allow" | "confirm" | "deny"; action: string; tool?: string }>, extra: Record<string, unknown> = {}): void {
    writeFileSync(join(dir, "mandate.json"), JSON.stringify({
        version: "1", userId: "authorization-test", default: "deny", rules, ...extra,
    }), "utf-8");
}

function input(command: string, key: string) {
    return { agentId: "claude-code", toolName: "Bash" as const, command, cwd: join(dir, "project"), idempotencyKey: key };
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meruntime-authorize-"));
    const secretsPath = join(dir, "secrets.json");
    writeFileSync(secretsPath, JSON.stringify({ pendingHmacKey: "ab".repeat(32) }), "utf-8");
    oldSecrets = process.env.MERUNTIME_SECRETS;
    oldHome = process.env.MERUNTIME_HOME;
    process.env.MERUNTIME_SECRETS = secretsPath;
    process.env.MERUNTIME_HOME = dir;
    setAuthorizationPathForTests(join(dir, "authorizations.json"));
    setRequestsPathForTests(join(dir, "requests.json"));
    setAuditPathForTests(join(dir, "audit.jsonl"));
    setMandatePathForTests(join(dir, "mandate.json"));
    setKillPathForTests(join(dir, "kill.json"));
    writeKillSwitch(false);
    setMandate([
        { effect: "allow", action: "read", tool: "terminal.command" },
        { effect: "confirm", action: "exec", tool: "terminal.command" },
        { effect: "confirm", action: "write", tool: "terminal.command" },
        { effect: "confirm", action: "delete", tool: "terminal.command" },
    ]);
});

afterEach(() => {
    setAuthorizationPathForTests(undefined);
    setRequestsPathForTests(undefined);
    setAuditPathForTests(undefined);
    setMandatePathForTests(undefined);
    setKillPathForTests(undefined);
    if (oldSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
    else process.env.MERUNTIME_SECRETS = oldSecrets;
    if (oldHome === undefined) delete process.env.MERUNTIME_HOME;
    else process.env.MERUNTIME_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
});

test("GREEN read authorizes without invoking an adapter and records audit details", () => {
    const result = authorizeCommand(input("git status", "read-1"));

    assert.equal(result.verdict, "GREEN");
    assert.equal(result.status, "AUTHORIZED");
    assert.equal(readAuditLines()[0].action, "read");
    assert.equal(readAuditLines()[0].rule, "rules[0]");
    assert.match(readAuditLines()[0].params_hash ?? "", /^[0-9a-f]{64}$/);
    const stored = JSON.parse(readFileSync(getAuthorizationPath(), "utf-8")) as Array<{ command: string }>;
    assert.equal(stored[0].command, "");
});

test("YELLOW approval re-evaluates policy and only authorizes; it never executes", () => {
    const pending = authorizeCommand(input("npm test", "exec-1"));
    assert.equal(pending.verdict, "YELLOW");
    assert.equal(listPendingAuthorizations().length, 1);
    assert.equal(getAuthorization(pending.requestId)?.command, "npm test");

    const approved = approveAuthorization(pending.requestId, "test-approver");
    assert.equal(approved.verdict, "GREEN");
    assert.equal(approved.status, "AUTHORIZED");
    assert.equal(readAuditLines().some((entry) => entry.event === "execute"), false);
    assert.equal(listPendingAuthorizations().length, 0);
    const stored = JSON.parse(readFileSync(getAuthorizationPath(), "utf-8")) as Array<{ command: string }>;
    assert.equal(stored[0].command, "");
});

test("approval is denied when mandate changes or the kill switch activates", () => {
    const pending = authorizeCommand(input("npm test", "reevaluate-1"));
    setMandate([{ effect: "deny", action: "exec", tool: "terminal.command" }]);
    assert.equal(approveAuthorization(pending.requestId).verdict, "RED");

    setMandate([{ effect: "confirm", action: "exec", tool: "terminal.command" }]);
    const next = authorizeCommand(input("npm run build", "reevaluate-2"));
    writeKillSwitch(true);
    assert.equal(approveAuthorization(next.requestId).verdict, "RED");
});

test("kill switch denies immediately and every policy decision is audited", () => {
    writeKillSwitch(true);
    const denied = authorizeCommand(input("git status", "kill-1"));
    assert.equal(denied.verdict, "RED");
    assert.equal(denied.rule, "killSwitch");
    assert.ok(readAuditLines().some((entry) => entry.event === "request" && entry.decision === "RED"));
});

test("rate limit and pending cap include terminal authorizations", () => {
    setMandate([{ effect: "allow", action: "read", tool: "terminal.command" }], { rateLimitPerSecond: 1 });
    assert.equal(authorizeCommand(input("git status", "rate-1")).verdict, "GREEN");
    const rateLimited = authorizeCommand(input("git diff", "rate-2"));
    assert.equal(rateLimited.verdict, "RED");
    assert.equal(rateLimited.rule, "rateLimit.exceeded");

    setMandate([{ effect: "confirm", action: "exec", tool: "terminal.command" }], { maxPendingRequests: 1, rateLimitPerSecond: 20 });
    assert.equal(authorizeCommand(input("npm test", "pending-1")).status, "PENDING");
    const overflow = authorizeCommand(input("npm run build", "pending-2"));
    assert.equal(overflow.verdict, "RED");
    assert.equal(overflow.rule, "pending.limitReached");
});

test("idempotency reuses an authorization and rejects a changed command", () => {
    const first = authorizeCommand(input("git status", "same-key"));
    const repeated = authorizeCommand(input("git status", "same-key"));
    assert.equal(repeated.requestId, first.requestId);
    assert.throws(() => authorizeCommand(input("git diff", "same-key")), { code: "IDEMPOTENCY_KEY_REUSED" });
    assert.equal(readAuditLines().filter((entry) => entry.event === "request").length, 1);
});

test("expired YELLOW authorization is RED and cannot be approved", () => {
    const pending = authorizeCommand(input("npm test", "expire-1"));
    const file = getAuthorizationPath();
    const records = JSON.parse(readFileSync(file, "utf-8")) as Array<{ expiresAt: string }>;
    records[0].expiresAt = new Date(Date.now() - 1).toISOString();
    writeFileSync(file, JSON.stringify(records), "utf-8");

    assert.equal(getAuthorization(pending.requestId)?.verdict, "RED");
    assert.throws(() => approveAuthorization(pending.requestId), { code: "ALREADY_DECIDED" });
    assert.ok(readAuditLines().some((entry) => entry.event === "expire" && entry.request_id === pending.requestId));
});

test("manual denial persists RED and does not execute an adapter", () => {
    const pending = authorizeCommand(input("npm test", "deny-1"));
    const denied = denyAuthorization(pending.requestId);
    assert.equal(denied.verdict, "RED");
    assert.equal(denied.status, "DENIED");
    assert.equal(readAuditLines().some((entry) => entry.event === "execute"), false);
});

test("rate limit and pending cap are shared with /api/check requests", async () => {
    setMandate([
        { effect: "confirm", action: "write", tool: "http.request", host: "example.test" },
        { effect: "confirm", action: "exec", tool: "terminal.command" },
    ], { rateLimitPerSecond: 20, maxPendingRequests: 1 });
    const httpPending = await submitRequest({
        intent: intentFromHttp({ agentId: "http-api", method: "POST", url: "https://example.test/resource" }),
        idempotencyKey: "shared-pending-http",
    }, { wait: false });
    assert.equal(httpPending.status, "PENDING");
    const command = authorizeCommand(input("npm test", "shared-pending-terminal"));
    assert.equal(command.verdict, "RED");
    assert.equal(command.rule, "pending.limitReached");

    setMandate([
        { effect: "confirm", action: "write", tool: "http.request", host: "example.test" },
        { effect: "allow", action: "read", tool: "terminal.command" },
    ], { rateLimitPerSecond: 1 });
    const limitedHttp = await submitRequest({
        intent: intentFromHttp({ agentId: "http-api", method: "POST", url: "https://example.test/second" }),
        idempotencyKey: "shared-rate-http",
    }, { wait: false });
    assert.equal(limitedHttp.rule, "rateLimit.exceeded");
});

test("terminal authorizations compact to 30-day tombstones without retaining the command", () => {
    const allowed = authorizeCommand(input("git status", "compact-1"));
    const path = getAuthorizationPath();
    const records = JSON.parse(readFileSync(path, "utf-8")) as Array<Record<string, unknown>>;
    records[0].updatedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(records), "utf-8");

    assert.equal(getAuthorization(allowed.requestId)?.status, "AUTHORIZED");
    const compacted = JSON.parse(readFileSync(path, "utf-8")) as Array<Record<string, unknown>>;
    assert.equal(compacted[0].tombstone, true);
    assert.equal("command" in compacted[0], false);
    assert.equal(compacted[0].idempotencyKey, "compact-1");
});