import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBank, type FakeBank } from "../../fakebank/src/server.js";
import { setAuditPathForTests } from "../../engine/src/audit.js";
import { setKillPathForTests, writeKillSwitch } from "../../engine/src/kill.js";
import { setBankUrlForTests } from "../../engine/src/paymentAdapter.js";
import { setPendingPathForTests } from "../../engine/src/pendingStore.js";
import { setMandatePathForTests } from "../../engine/src/policy.js";
import { setRequestsPathForTests } from "../../engine/src/requestStore.js";
import { startUiServer, type UiServer } from "../../ui/src/server.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CLI = join(ROOT, "packages", "cli", "src", "cli.ts");
const UI_TOKEN = "serve-test-ui-token";
const BANK_TOKEN = "serve-test-bank-token";
const KNOWN_IBAN = "ES00 DEMO 0000 0000 0000 0001";
const NEW_IBAN = "ES00 DEMO 0000 0000 0000 0002";

let dir: string;
let secretsPath: string;
let previousEnv: Record<string, string | undefined>;
let ui: UiServer | undefined;
let bank: FakeBank | undefined;
let serveProcess: ChildProcess | undefined;

function isolatedEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("MERUNTIME_")) delete env[key];
    return { ...env, MERUNTIME_HOME: home, MERUNTIME_SECRETS: secretsPath, ...extra };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf-8"); });
        child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf-8"); });
        child.once("error", reject);
        child.once("exit", (code) => resolve({ code: code ?? 1, output }));
    });
}

function waitForReady(child: ChildProcess): Promise<string> {
    return new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error(`serve did not become ready: ${output}`)), 20_000);
        child.stdout?.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf-8");
            if (output.includes("listening at")) {
                clearTimeout(timer);
                resolve(output);
            }
        });
        child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf-8"); });
        child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`serve exited with code ${code}: ${output}`));
        });
    });
}

async function unusedPort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => resolve());
    });
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    return address.port;
}

async function stop(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
    });
}

async function launchServe(env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; port: number }> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const port = await unusedPort();
        const child = spawn(process.execPath, ["--import", "tsx", CLI, "serve", "--port", String(port)], {
            cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
        });
        try {
            await waitForReady(child);
            return { child, port };
        } catch (error) {
            await stop(child);
            if (error instanceof Error && error.message.includes("is already in use")) continue;
            throw error;
        }
    }
    throw new Error("Could not reserve a test port for meruntime serve.");
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meruntime-serve-"));
    secretsPath = join(dir, "secrets.json");
    writeFileSync(secretsPath, JSON.stringify({
        fakeBankToken: BANK_TOKEN,
        pendingHmacKey: "cd".repeat(32),
    }), "utf-8");
    previousEnv = {
        MERUNTIME_HOME: process.env.MERUNTIME_HOME,
        MERUNTIME_SECRETS: process.env.MERUNTIME_SECRETS,
        MERUNTIME_FAKEBANK_URL: process.env.MERUNTIME_FAKEBANK_URL,
    };
    process.env.MERUNTIME_HOME = dir;
    process.env.MERUNTIME_SECRETS = secretsPath;
    setMandatePathForTests(join(dir, "mandate.json"));
    setKillPathForTests(join(dir, "kill.json"));
    setPendingPathForTests(join(dir, "pending.json"));
    setRequestsPathForTests(join(dir, "requests.json"));
    setAuditPathForTests(join(dir, "audit.jsonl"));
    writeKillSwitch(false);
});

afterEach(async () => {
    await stop(serveProcess);
    serveProcess = undefined;
    await ui?.close();
    ui = undefined;
    await bank?.close();
    bank = undefined;
    setBankUrlForTests(undefined);
    setMandatePathForTests(undefined);
    setKillPathForTests(undefined);
    setPendingPathForTests(undefined);
    setRequestsPathForTests(undefined);
    setAuditPathForTests(undefined);
    for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
});

test("serve exige instancia única y explica un puerto ocupado", async () => {
    const env = isolatedEnv(dir);
    const port = await unusedPort();
    const serveLock = join(dir, "serve.lock");
    writeFileSync(serveLock, "not-a-pid", "utf-8");
    const invalidLock = await runCli(["serve", "--port", String(port)], env);
    assert.equal(invalidLock.code, 1);
    assert.match(invalidLock.output, /serve lock .* is invalid/);
    rmSync(serveLock);

    const started = await launchServe(env);
    serveProcess = started.child;

    const another = await runCli(["serve", "--port", String(await unusedPort())], env);
    assert.equal(another.code, 1);
    assert.match(another.output, /Another meruntime serve instance is already running/);

    const busyServer = createServer();
    const busyPort = await unusedPort();
    await new Promise<void>((resolve, reject) => {
        busyServer.once("error", reject);
        busyServer.listen(busyPort, "127.0.0.1", () => resolve());
    });
    try {
        const busy = await runCli(["serve", "--port", String(busyPort)], isolatedEnv(join(dir, "other-home")));
        assert.equal(busy.code, 1);
        assert.match(busy.output, new RegExp(`127\\.0\\.0\\.1:${busyPort} is already in use`));
    } finally {
        await new Promise<void>((resolve, reject) => busyServer.close((error) => error ? reject(error) : resolve()));
    }
});

test("CLI, UI y API comparten YELLOW; token rotado entra en vigor sin reiniciar serve", async () => {
    bank = await startFakeBank({ token: BANK_TOKEN, port: 0 });
    setBankUrlForTests(bank.url);
    writeFileSync(join(dir, "mandate.json"), JSON.stringify({
        version: "1",
        userId: "serve-test",
        default: "deny",
        ceilings: { perTxEur: 100 },
        knownIbans: [KNOWN_IBAN],
        rules: [{ effect: "confirm", action: "pay", tool: "payment.transfer" }],
    }), "utf-8");

    ui = await startUiServer({ port: 0, token: UI_TOKEN });
    const env = isolatedEnv(dir, { MERUNTIME_FAKEBANK_URL: bank.url });
    const started = await launchServe(env);
    const port = started.port;
    serveProcess = started.child;

    const apiUrl = `http://127.0.0.1:${port}`;
    const tokenPath = join(dir, "api-token");
    const firstToken = (await import("node:fs")).readFileSync(tokenPath, "utf-8");
    const requestBody = {
        tool: "payment_transfer",
        iban: NEW_IBAN,
        amount_eur: 35,
        concept: "CLI UI API concurrency",
        idempotency_key: "concurrent-payment",
    };
    const first = await fetch(`${apiUrl}/api/check`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-meruntime-token": firstToken },
        body: JSON.stringify(requestBody),
    });
    const yellow = await first.json() as { verdict: string; status: string; request_id: string; status_url: string };
    assert.equal(first.status, 202);
    assert.equal(yellow.verdict, "YELLOW");

    const [apiStatusResponse, uiPendingResponse, cliPending] = await Promise.all([
        fetch(`${apiUrl}${yellow.status_url}`, { headers: { "x-meruntime-token": firstToken } }),
        fetch(new URL("/api/pending", ui.url), { headers: { "x-meruntime-token": UI_TOKEN } }),
        runCli(["pending"], env),
    ]);
    const apiStatus = await apiStatusResponse.json() as { status: string };
    const uiPending = await uiPendingResponse.json() as Array<{ requestId: string }>;
    assert.equal(apiStatus.status, "PENDING");
    assert.ok(uiPending.some((request) => request.requestId === yellow.request_id));
    assert.equal(cliPending.code, 0, cliPending.output);
    assert.ok(cliPending.output.includes(yellow.request_id));

    const rotated = await runCli(["token", "rotate"], env);
    assert.equal(rotated.code, 0, rotated.output);
    const nextToken = (await import("node:fs")).readFileSync(tokenPath, "utf-8");
    assert.notEqual(nextToken, firstToken);
    assert.equal(rotated.output.includes(nextToken), false);
    assert.equal((await fetch(`${apiUrl}${yellow.status_url}`, { headers: { "x-meruntime-token": firstToken } })).status, 401);

    const approved = await runCli(["approve", yellow.request_id], env);
    assert.equal(approved.code, 0, approved.output);
    assert.equal(bank.transfers().length, 1);
    const finalResponse = await fetch(`${apiUrl}${yellow.status_url}`, { headers: { "x-meruntime-token": nextToken } });
    const final = await finalResponse.json() as { verdict: string; status: string };
    assert.equal(final.verdict, "YELLOW");
    assert.equal(final.status, "EXECUTED");
});