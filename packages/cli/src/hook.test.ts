import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAuditPathForTests } from "../../engine/src/audit.js";
import { approveAuthorization, listPendingAuthorizations } from "../../engine/src/authorizationRuntime.js";
import { setAuthorizationPathForTests } from "../../engine/src/authorizationStore.js";
import { setKillPathForTests, writeKillSwitch } from "../../engine/src/kill.js";
import { setMandatePathForTests } from "../../engine/src/policy.js";
import { setRequestsPathForTests } from "../../engine/src/requestStore.js";
import { startHttpApiServer, type HttpApiServer } from "../../http-api/src/server.js";
import type { Adapter } from "../../engine/src/requestRuntime.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CLI = join(ROOT, "packages", "cli", "src", "cli.ts");
const API_TOKEN = "a1".repeat(32);

let dir: string;
let oldEnv: Record<string, string | undefined>;
let api: HttpApiServer | undefined;
let adapterCalls: number;

function writeMandate(rules: Array<{ effect: "allow" | "confirm" | "deny"; action: string; tool?: string }>, extra: Record<string, unknown> = {}): void {
    writeFileSync(join(dir, "mandate.json"), JSON.stringify({ version: "1", userId: "hook-test", default: "deny", rules, ...extra }), "utf-8");
}

function hookEvent(toolName: "Bash" | "PowerShell", command: string, id: string) {
    return {
        hook_event_name: "PreToolUse",
        session_id: "session-hook-tests",
        agent_id: "claude-subagent-1",
        tool_use_id: id,
        cwd: join(dir, "project"),
        tool_name: toolName,
        tool_input: { command },
    };
}

function runHook(event: unknown | string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", CLI, "hook", "claude"], {
            cwd: ROOT,
            env: { ...process.env, MERUNTIME_HOME: dir, MERUNTIME_SECRETS: join(dir, "secrets.json") },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
        child.once("error", reject);
        child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
        child.stdin.end(typeof event === "string" ? event : JSON.stringify(event));
    });
}

async function waitForPending(idempotencyKey: string): Promise<{ requestId: string; verdict: string }> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
        const pending = listPendingAuthorizations().find((record) => record.idempotencyKey === idempotencyKey);
        if (pending) return { requestId: pending.requestId, verdict: pending.verdict };
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("hook did not create a pending authorization");
}

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "meruntime-hook-"));
    writeFileSync(join(dir, "api-token"), API_TOKEN, "utf-8");
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ pendingHmacKey: "cd".repeat(32) }), "utf-8");
    oldEnv = {
        MERUNTIME_HOME: process.env.MERUNTIME_HOME,
        MERUNTIME_SECRETS: process.env.MERUNTIME_SECRETS,
        MERUNTIME_API_URL: process.env.MERUNTIME_API_URL,
    };
    process.env.MERUNTIME_HOME = dir;
    process.env.MERUNTIME_SECRETS = join(dir, "secrets.json");
    setAuthorizationPathForTests(join(dir, "authorizations.json"));
    setRequestsPathForTests(join(dir, "requests.json"));
    setAuditPathForTests(join(dir, "audit.jsonl"));
    setMandatePathForTests(join(dir, "mandate.json"));
    setKillPathForTests(join(dir, "kill.json"));
    writeKillSwitch(false);
    adapterCalls = 0;
    const adapter: Adapter = async () => { adapterCalls++; return { status: 200 }; };
    api = await startHttpApiServer({ port: 0, token: API_TOKEN, adapter });
    process.env.MERUNTIME_API_URL = api.url;
});

afterEach(async () => {
    await api?.close();
    api = undefined;
    setAuthorizationPathForTests(undefined);
    setRequestsPathForTests(undefined);
    setAuditPathForTests(undefined);
    setMandatePathForTests(undefined);
    setKillPathForTests(undefined);
    for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
});

test("hook Claude recibe PreToolUse por stdin y solo emite JSON allow para GREEN", async () => {
    writeMandate([{ effect: "allow", action: "read", tool: "terminal.command" }]);
    const result = await runHook(hookEvent("Bash", "git status", "tool-green"));

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(listPendingAuthorizations().length, 0);
    const stored = JSON.parse(readFileSync(join(dir, "authorizations.json"), "utf-8")) as Array<{ agentId: string }>;
    assert.equal(stored[0].agentId, "claude-subagent-1");
    assert.equal(adapterCalls, 0);
});

test("prueba end-to-end: RED no ejecuta el comando marcador", async () => {
    writeMandate([{ effect: "deny", action: "send", tool: "terminal.command" }]);
    const marker = join(dir, "command-ran.marker");
    const result = await runHook(hookEvent("Bash", `npm publish --tag ${marker}`, "tool-red"));
    const decision = JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
    if (decision === "allow") writeFileSync(marker, "ran", "utf-8");

    assert.equal(decision, "deny");
    assert.equal(existsSync(marker), false);
    assert.equal(adapterCalls, 0);
});

test("YELLOW permanece bloqueado hasta aprobar; solo entonces el harness ejecuta el marcador una vez", async () => {
    writeMandate([{ effect: "confirm", action: "write", tool: "terminal.command" }], { approvalTimeoutMs: 8_000 });
    const marker = join(dir, "command-ran.marker");
    const event = hookEvent("PowerShell", `Set-Content ${marker} ran`, "tool-yellow");
    const key = `claude-code:${event.session_id}:${event.tool_use_id}`;
    const hookPromise = runHook(event);
    const pending = await waitForPending(key);
    assert.equal(pending.verdict, "YELLOW");
    approveAuthorization(pending.requestId, "hook-e2e-test");
    const result = await hookPromise;
    const decision = JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
    if (decision === "allow") writeFileSync(marker, "ran", "utf-8");

    assert.equal(decision, "allow");
    assert.equal(readFileSync(marker, "utf-8"), "ran");
    assert.equal(adapterCalls, 0);
});

test("token ausente, evento inválido y API no disponible producen deny con JSON únicamente en stdout", async () => {
    writeMandate([{ effect: "allow", action: "read", tool: "terminal.command" }]);
    const marker = join(dir, "must-not-run.marker");
    const invalid = await runHook({ hook_event_name: "PostToolUse" });
    assert.equal(JSON.parse(invalid.stdout).hookSpecificOutput.permissionDecision, "deny");
    const malformed = await runHook("{not-json");
    assert.equal(JSON.parse(malformed.stdout).hookSpecificOutput.permissionDecision, "deny");

    rmSync(join(dir, "api-token"));
    const noToken = await runHook(hookEvent("Bash", "git status", "tool-no-token"));
    assert.equal(JSON.parse(noToken.stdout).hookSpecificOutput.permissionDecision, "deny");
    writeFileSync(join(dir, "api-token"), API_TOKEN, "utf-8");

    await api?.close();
    api = undefined;
    const noServer = await runHook(hookEvent("Bash", "git status", "tool-no-server"));
    const permission = JSON.parse(noServer.stdout).hookSpecificOutput.permissionDecision;
    if (permission === "allow") writeFileSync(marker, "ran", "utf-8");
    assert.equal(permission, "deny");
    assert.equal(existsSync(marker), false);
    for (const result of [invalid, malformed, noToken, noServer]) assert.equal(result.stdout.trim().split("\n").length, 1);
});