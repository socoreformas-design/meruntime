import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBank, type FakeBank } from "../../fakebank/src/server.js";
import { setAuditPathForTests } from "../../engine/src/audit.js";
import { approveAuthorization } from "../../engine/src/authorizationRuntime.js";
import { setAuthorizationPathForTests } from "../../engine/src/authorizationStore.js";
import { setKillPathForTests, writeKillSwitch } from "../../engine/src/kill.js";
import { setBankUrlForTests } from "../../engine/src/paymentAdapter.js";
import { setPendingPathForTests } from "../../engine/src/pendingStore.js";
import { setMandatePathForTests } from "../../engine/src/policy.js";
import { readRequests, setRequestsPathForTests } from "../../engine/src/requestStore.js";
import type { Adapter } from "../../engine/src/requestRuntime.js";
import { startHttpApiServer, type HttpApiServer } from "./server.js";

const TOKEN = "http-api-test-token";
const BANK_TOKEN = "http-api-test-bank-token";
const IBAN = "ES00 DEMO 0000 0000 0000 0001";
let dir: string;
let server: HttpApiServer;
let bank: FakeBank | undefined;
let previousSecrets: string | undefined;
let previousHome: string | undefined;
let adapterCalls: number;

interface Reply {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    text: string;
    json: any;
}

function call(method: string, path: string, options: {
    token?: string | null;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string | Buffer;
} = {}): Promise<Reply> {
    const { port } = new URL(server.url);
    const token = options.token === undefined ? TOKEN : options.token;
    const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const payloadSize = payload === undefined ? undefined : Buffer.byteLength(payload);
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            host: "127.0.0.1", port, path, method,
            headers: {
                ...(token ? { "x-meruntime-token": token } : {}),
                ...(payload !== undefined && !options.headers?.["content-type"] ? { "content-type": "application/json" } : {}),
                ...(payload !== undefined && !options.headers?.["transfer-encoding"] ? { "content-length": String(payloadSize) } : {}),
                ...options.headers,
            },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf-8");
                let json: any;
                try { json = JSON.parse(text); } catch { json = undefined; }
                resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
            });
        });
        req.on("error", reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

function writeMandate(effect: "deny" | "confirm"): void {
    writeFileSync(join(dir, "mandate.json"), JSON.stringify({
        version: "1",
        userId: "http-api-test",
        default: "deny",
        rules: [{ effect, action: "write", tool: "http.request", host: "example.test" }],
    }), "utf-8");
}

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "meruntime-http-api-"));
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({
        pendingHmacKey: "ab".repeat(32),
        fakeBankToken: BANK_TOKEN,
    }), "utf-8");
    previousSecrets = process.env.MERUNTIME_SECRETS;
    previousHome = process.env.MERUNTIME_HOME;
    process.env.MERUNTIME_SECRETS = join(dir, "secrets.json");
    process.env.MERUNTIME_HOME = dir;
    setMandatePathForTests(join(dir, "mandate.json"));
    setKillPathForTests(join(dir, "kill.json"));
    setPendingPathForTests(join(dir, "pending.json"));
    setRequestsPathForTests(join(dir, "requests.json"));
    setAuditPathForTests(join(dir, "audit.jsonl"));
    setAuthorizationPathForTests(join(dir, "authorizations.json"));
    writeKillSwitch(false);
    writeMandate("deny");
    adapterCalls = 0;
    const spyAdapter: Adapter = async () => {
        adapterCalls++;
        return { status: 200 };
    };
    server = await startHttpApiServer({ port: 0, token: TOKEN, adapter: spyAdapter });
});

afterEach(async () => {
    await server.close();
    await bank?.close();
    bank = undefined;
    setBankUrlForTests(undefined);
    setMandatePathForTests(undefined);
    setKillPathForTests(undefined);
    setPendingPathForTests(undefined);
    setRequestsPathForTests(undefined);
    setAuditPathForTests(undefined);
    setAuthorizationPathForTests(undefined);
    if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
    else process.env.MERUNTIME_SECRETS = previousSecrets;
    if (previousHome === undefined) delete process.env.MERUNTIME_HOME;
    else process.env.MERUNTIME_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
});

function assertRejectedWithoutExecution(reply: Reply, label: string): void {
    assert.ok(reply.status >= 400 && reply.status < 500, `${label}: expected 4xx, got ${reply.status}`);
    assert.equal(Object.hasOwn(reply.json ?? {}, "verdict"), false, `${label}: response must not contain verdict`);
    assert.equal(adapterCalls, 0, `${label}: adapter must not be called`);
    assert.equal(readRequests().length, 0, `${label}: requests.json must remain empty`);
}

test("solo acepta loopback con Host exacto y token válido", async () => {
    assertRejectedWithoutExecution(await call("POST", "/api/check", {
        headers: { host: "evil.example" },
        body: { tool: "http_request", method: "POST", url: "https://example.test/", idempotency_key: "host-test" },
    }), "foreign Host");
    assertRejectedWithoutExecution(await call("GET", "/api/requests/mr_000000000000", { token: null }), "missing token");
    assertRejectedWithoutExecution(await call("GET", "/api/requests/mr_000000000000", { token: "wrong" }), "incorrect token");
});

test("rechaza Origin ajeno y acepta cliente sin Origin", async () => {
    const body = { tool: "http_request", method: "POST", url: "https://example.test/", idempotency_key: "origin-test" };
    assertRejectedWithoutExecution(await call("POST", "/api/check", {
        headers: { origin: "https://attacker.example" }, body,
    }), "foreign Origin POST");
    assertRejectedWithoutExecution(await call("GET", "/api/requests/mr_000000000000", {
        headers: { origin: "https://attacker.example" },
    }), "foreign Origin GET");

    const allowed = `http://127.0.0.1:${new URL(server.url).port}`;
    const response = await call("POST", "/api/check", { headers: { origin: allowed }, body });
    assert.equal(response.json.verdict, "RED");
});

test("aplica el límite de 8 KiB también a un body chunked", async () => {
    const response = await call("POST", "/api/check", {
        headers: { "transfer-encoding": "chunked" },
        body: { tool: "http_request", method: "POST", url: "https://example.test/", idempotency_key: "large", body: "x".repeat(9 * 1024) },
    });
    assertRejectedWithoutExecution(response, "body over 8 KiB");
});

test("formato inválido: rechazos 4xx sin veredicto ni ejecución", async () => {
    const wrongType = await call("POST", "/api/check", { headers: { "content-type": "text/plain" }, body: "{}" });
    assertRejectedWithoutExecution(wrongType, "unsupported content type");

    const missingKey = await call("POST", "/api/check", {
        body: { tool: "http_request", method: "GET", url: "https://example.test/" },
    });
    assertRejectedWithoutExecution(missingKey, "missing idempotency_key");

    const unknownTool = await call("POST", "/api/check", {
        body: { tool: "other", idempotency_key: "unknown-tool" },
    });
    assertRejectedWithoutExecution(unknownTool, "unknown tool");

    const missingRoute = await call("GET", "/api/missing");
    assertRejectedWithoutExecution(missingRoute, "unknown route");
});

test("JSON con sintaxis rota: rechaza bytes crudos sin veredicto ni ejecución", async () => {
    const response = await call("POST", "/api/check", { rawBody: Buffer.from('{"tool": ,', "utf-8") });
    assertRejectedWithoutExecution(response, "malformed JSON bytes");
});

test("devuelve RED para una denegación y YELLOW con status_url para aprobación", async () => {
    const red = await call("POST", "/api/check", {
        body: { tool: "http_request", method: "POST", url: "https://example.test/", idempotency_key: "deny" },
    });
    assert.equal(red.status, 200);
    assert.equal(red.json.verdict, "RED");
    assert.equal(red.json.status, "DENIED");

    writeMandate("confirm");
    const yellow = await call("POST", "/api/check", {
        body: { tool: "http_request", method: "POST", url: "https://example.test/", idempotency_key: "confirm" },
    });
    assert.equal(yellow.status, 202);
    assert.equal(yellow.json.verdict, "YELLOW");
    assert.equal(yellow.json.status, "PENDING");
    assert.equal(yellow.json.status_url, `/api/requests/${yellow.json.request_id}`);

    const status = await call("GET", yellow.json.status_url);
    assert.equal(status.json.verdict, "YELLOW");
    assert.equal(status.json.status, "PENDING");
});

test("el estado de una solicitud desconocida responde 404 sin veredicto", async () => {
    const response = await call("GET", "/api/requests/mr_000000000000");
    assert.equal(response.status, 404);
    assert.equal(response.json.verdict, undefined);
});

test("GREEN ejecuta el pago una sola vez con la misma idempotency_key", async () => {
    await server.close();
    server = await startHttpApiServer({ port: 0, token: TOKEN });
    bank = await startFakeBank({ token: BANK_TOKEN, port: 0 });
    setBankUrlForTests(bank.url);
    writeFileSync(join(dir, "mandate.json"), JSON.stringify({
        version: "1",
        userId: "http-api-test",
        default: "deny",
        ceilings: { perTxEur: 100 },
        knownIbans: [IBAN],
        rules: [{ effect: "allow", action: "pay", tool: "payment.transfer" }],
    }), "utf-8");

    const body = {
        tool: "payment_transfer",
        iban: IBAN,
        amount_eur: 35.5,
        concept: "Factura demo",
        idempotency_key: "payment-1",
    };
    const first = await call("POST", "/api/check", { body });
    const second = await call("POST", "/api/check", { body });

    assert.equal(first.json.verdict, "GREEN");
    assert.equal(first.json.status, "EXECUTED");
    assert.equal(first.json.result.data.transferId, bank.transfers()[0].transferId);
    assert.equal(second.json.request_id, first.json.request_id);
    assert.equal(bank.transfers().length, 1);
});

test("/api/authorize devuelve GREEN/RED sin ejecutar adaptadores ni tocar requests.json", async () => {
    writeFileSync(join(dir, "mandate.json"), JSON.stringify({
        version: "1", userId: "api-authorize", default: "deny",
        rules: [{ effect: "allow", action: "read", tool: "terminal.command" }],
    }), "utf-8");
    const green = await call("POST", "/api/authorize", {
        body: { agent_id: "claude-code", tool_name: "Bash", command: "git status", cwd: dir, idempotency_key: "authorize-green" },
    });
    assert.equal(green.status, 200);
    assert.equal(green.json.verdict, "GREEN");
    assert.equal(green.json.status, "AUTHORIZED");
    assert.equal(adapterCalls, 0);
    assert.deepEqual(readRequests(), []);

    const red = await call("POST", "/api/authorize", {
        body: { agent_id: "claude-code", tool_name: "Bash", command: "custom-tool", cwd: dir, idempotency_key: "authorize-red" },
    });
    assert.equal(red.status, 200);
    assert.equal(red.json.verdict, "RED");
    assert.equal(adapterCalls, 0);
    assert.deepEqual(readRequests(), []);
});

test("/api/authorize espera YELLOW, consulta estado final GREEN y nunca ejecuta", async () => {
    writeFileSync(join(dir, "mandate.json"), JSON.stringify({
        version: "1", userId: "api-authorize", default: "deny", approvalTimeoutMs: 10_000,
        rules: [{ effect: "confirm", action: "exec", tool: "terminal.command" }],
    }), "utf-8");
    const pending = await call("POST", "/api/authorize", {
        body: { agent_id: "claude-code", tool_name: "Bash", command: "npm test", cwd: dir, idempotency_key: "authorize-yellow" },
    });
    assert.equal(pending.status, 202);
    assert.equal(pending.json.verdict, "YELLOW");
    assert.equal(pending.json.status, "PENDING");
    assert.equal(adapterCalls, 0);

    approveAuthorization(pending.json.request_id, "http-api-test");
    const status = await call("GET", pending.json.status_url);
    assert.equal(status.status, 200);
    assert.equal(status.json.verdict, "GREEN");
    assert.equal(status.json.status, "AUTHORIZED");
    assert.equal(adapterCalls, 0);
    assert.deepEqual(readRequests(), []);
});

test("/api/authorize falla con 4xx sin veredicto para autenticación, esquema y estado desconocido", async () => {
    const body = { agent_id: "claude-code", tool_name: "Bash", command: "git status", cwd: dir, idempotency_key: "authorize-errors" };
    assertRejectedWithoutExecution(await call("POST", "/api/authorize", { token: null, body }), "missing authorize token");
    assertRejectedWithoutExecution(await call("POST", "/api/authorize", { body: { ...body, unexpected: true } }), "unexpected authorize field");
    assertRejectedWithoutExecution(await call("POST", "/api/authorize", { body: { ...body, tool_name: "Read" } }), "unsupported authorize tool");
    assertRejectedWithoutExecution(await call("POST", "/api/authorize", { body: { ...body, idempotency_key: undefined } }), "missing authorize idempotency key");
    const unknown = await call("GET", "/api/authorizations/mr_000000000000");
    assert.equal(unknown.status, 404);
    assert.equal(Object.hasOwn(unknown.json ?? {}, "verdict"), false);
});