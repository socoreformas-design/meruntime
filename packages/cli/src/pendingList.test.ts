import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRequestsPathForTests } from "../../engine/src/requestStore.js";
import { setAuthorizationPathForTests } from "../../engine/src/authorizationStore.js";
import { runPending } from "./pendingList.js";

let directory: string;
let originalLog: typeof console.log;

afterEach(() => {
    setRequestsPathForTests(undefined);
    setAuthorizationPathForTests(undefined);
    if (originalLog) console.log = originalLog;
    if (directory) rmSync(directory, { recursive: true, force: true });
});

test("pending muestra importe, IBAN y concepto del pago", () => {
    directory = mkdtempSync(join(tmpdir(), "meruntime-cli-pending-"));
    setRequestsPathForTests(join(directory, "requests.json"));
    writeFileSync(join(directory, "requests.json"), JSON.stringify([{
        requestId: "mr_testpending001",
        idempotencyKey: "pending-test",
        payloadHash: "a".repeat(64),
        agent: "mcp-proxy",
        action: "pay",
        status: "PENDING",
        verdict: "YELLOW",
        rule: "payees.unknownIban",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        transitions: [],
        result: null,
        error: null,
        method: "POST",
        url: "",
        intent: {
            agentId: "mcp-proxy",
            action: "pay",
            tool: "payment.transfer",
            amountEur: 12.3,
            params: { iban: "XX66 ATTACKER 0000 0000 0001", concept: "Factura demo" },
            effects: [{ kind: "pay", reversible: false }],
        },
        intentMac: "b".repeat(64),
    }]), "utf-8");

    const lines: string[] = [];
    originalLog = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    assert.equal(runPending(), 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /12,30/);
    assert.match(lines[0], /€/);
    assert.match(lines[0], /XX66 ATTACKER 0000 0000 0001/);
    assert.match(lines[0], /Factura demo/);
});

test("pending muestra comando completo, cwd y agent_id como texto escapado para terminal", () => {
    directory = mkdtempSync(join(tmpdir(), "meruntime-cli-auth-pending-"));
    const path = join(directory, "authorizations.json");
    setAuthorizationPathForTests(path);
    const command = "echo </script><img src=x>\u001b[31m";
    writeFileSync(path, JSON.stringify([{
        requestId: "mr_authorize001",
        idempotencyKey: "hook-pending",
        payloadHash: "a".repeat(64),
        agentId: "claude-code\u001b[2J",
        toolName: "Bash",
        command,
        cwd: "C:\\workspace\\<project>",
        action: "exec",
        status: "PENDING",
        verdict: "YELLOW",
        rule: "rules[0]",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        intent: { agentId: "claude-code", action: "exec", tool: "terminal.command", effects: [] },
        intentMac: "b".repeat(64),
        transitions: [],
    }]), "utf-8");

    const lines: string[] = [];
    originalLog = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    assert.equal(runPending(), 0);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(JSON.stringify(command)));
    assert.ok(lines[0].includes(JSON.stringify("C:\\workspace\\<project>")));
    assert.ok(lines[0].includes(JSON.stringify("claude-code\u001b[2J")));
    assert.equal(lines[0].includes("\u001b"), false);
});