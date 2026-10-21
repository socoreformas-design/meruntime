import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intentFromHttp } from "../../proxy/src/intentFromTool.js";
import { setAuditPathForTests } from "./audit.js";
import { setKillPathForTests, writeKillSwitch } from "./kill.js";
import { setPendingPathForTests } from "./pendingStore.js";
import { setMandatePathForTests } from "./policy.js";
import { approveRequest, denyRequest, submitRequest } from "./requestRuntime.js";
import type { Mandate } from "../../schema/src/index.js";

interface Seen { method?: string; url?: string; body: string }

const SECRET = "http-test-secret-value";
let dir: string;
let server: Server;
let origin: string;
let seen: Seen[];
let previousSecrets: string | undefined;
let nextResponse: { status: number; headers?: Record<string, string>; body?: string };

function useMandate(overrides: Partial<Mandate> = {}) {
    const mandate: Mandate = {
        version: "1", userId: "demo", default: "deny",
        allowHosts: ["127.0.0.1"],
        rules: [
            { effect: "allow", action: "read", tool: "http.request", host: "127.0.0.1" },
            { effect: "confirm", action: "write", tool: "http.request", host: "127.0.0.1" },
        ],
        ...overrides,
    };
    writeFileSync(join(dir, "mandate.json"), JSON.stringify(mandate), "utf-8");
}

const http = (method: string, path: string, body?: string) => {
    const url = `${origin}${path}`;
    return { intent: intentFromHttp({ agentId: "http-agent", method, url, body }), request: { method, url, body } };
};
const requestsText = () => readFileSync(join(dir, "requests.json"), "utf-8");

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "meruntime-http-"));
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({}), "utf-8");
    previousSecrets = process.env.MERUNTIME_SECRETS;
    process.env.MERUNTIME_SECRETS = join(dir, "secrets.json");
    seen = [];
    nextResponse = { status: 200, body: "hello from the server" };
    server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (c: Buffer) => chunks.push(c));
        request.on("end", () => {
            seen.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString("utf-8") });
            response.writeHead(nextResponse.status, nextResponse.headers).end(nextResponse.body ?? "");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    setMandatePathForTests(join(dir, "mandate.json"));
    setKillPathForTests(join(dir, "kill.json"));
    writeKillSwitch(false);
    setPendingPathForTests(join(dir, "pending.json"));
    setAuditPathForTests(join(dir, "audit.jsonl"));
    useMandate();
});

afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setMandatePathForTests(undefined);
    setKillPathForTests(undefined);
    setPendingPathForTests(undefined);
    setAuditPathForTests(undefined);
    if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
    else process.env.MERUNTIME_SECRETS = previousSecrets;
    rmSync(dir, { recursive: true, force: true });
});

test("GET GREEN a un host permitido lo ejecuta el CORE y devuelve el cuerpo en vivo", async () => {
    const view = await submitRequest(http("GET", "/data"));

    assert.equal(view.status, "EXECUTED");
    assert.equal(view.result?.status, 200);
    assert.equal(view.output, "hello from the server");
    assert.equal(seen.length, 1);
    assert.equal(requestsText().includes("hello from the server"), false);
});

test("repetir un GET sin clave lo ejecuta otra vez; con la misma clave solo una vez", async () => {
    await submitRequest(http("GET", "/data"));
    await submitRequest(http("GET", "/data"));
    assert.equal(seen.length, 2);

    const first = await submitRequest({ ...http("GET", "/keyed"), idempotencyKey: "k-get" });
    const replay = await submitRequest({ ...http("GET", "/keyed"), idempotencyKey: "k-get" });
    assert.equal(seen.length, 3);
    assert.equal(replay.requestId, first.requestId);
    assert.equal(replay.output, undefined);
});

test("GREEN a un host que no est\u00e1 en allowHosts: DENIED por allowHosts y sin petici\u00f3n", async () => {
    useMandate({ allowHosts: ["api.github.com"] });
    const view = await submitRequest(http("GET", "/data"));

    assert.equal(view.status, "DENIED");
    assert.equal(view.rule, "allowHosts");
    assert.equal(seen.length, 0);
});

test("las redirecciones no se siguen", async () => {
    nextResponse = { status: 302, headers: { Location: "/elsewhere" } };
    const view = await submitRequest(http("GET", "/start"));

    assert.equal(view.status, "EXECUTED");
    assert.equal(view.result?.status, 302);
    assert.deepEqual(seen.map((s) => s.url), ["/start"]);
});

test("una respuesta 500 deja la solicitud en FAILED", async () => {
    nextResponse = { status: 500, body: "boom" };
    const view = await submitRequest(http("GET", "/data"));

    assert.equal(view.status, "FAILED");
    assert.equal(view.error?.code, "ADAPTER_ERROR");
});

test("POST YELLOW aprobado se ejecuta con la petici\u00f3n original y no deja credenciales en disco", async () => {
    const body = JSON.stringify({ amount: 1, authorization: `Bearer ${SECRET}` });
    const pending = await submitRequest(http("POST", `/pay?token=${SECRET}`, body), { wait: false });
    assert.equal(pending.status, "PENDING");
    assert.equal(seen.length, 0);

    const done = await approveRequest(pending.requestId);

    assert.equal(done.status, "EXECUTED");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, `/pay?token=${SECRET}`);
    assert.equal(seen[0].body, body);
    assert.equal(requestsText().includes(SECRET), false);
    assert.equal(readFileSync(join(dir, "audit.jsonl"), "utf-8").includes(SECRET), false);
});

test("POST YELLOW denegado: nada se env\u00eda y la petici\u00f3n original se borra", async () => {
    const pending = await submitRequest(http("POST", `/pay?token=${SECRET}`, "{}"), { wait: false });
    assert.equal(requestsText().includes(SECRET), true);

    assert.equal(denyRequest(pending.requestId).status, "DENIED");

    assert.equal(seen.length, 0);
    assert.equal(requestsText().includes(SECRET), false);
});

test("si la petici\u00f3n original se manipula en disco, la aprobaci\u00f3n se deniega sin ejecutar", async () => {
    const pending = await submitRequest(http("POST", "/pay", "{}"), { wait: false });
    const path = join(dir, "requests.json");
    const records = JSON.parse(readFileSync(path, "utf-8")) as Array<{ replay: { url: string } }>;
    records[0].replay.url = `${origin}/steal`;
    writeFileSync(path, JSON.stringify(records), "utf-8");

    const view = await approveRequest(pending.requestId);

    assert.equal(view.status, "DENIED");
    assert.match(view.error?.message ?? "", /integrity/);
    assert.equal(seen.length, 0);
});
