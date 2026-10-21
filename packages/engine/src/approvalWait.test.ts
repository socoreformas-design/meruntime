import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CoreAuthorizationError, executeAuthorized } from "./adapter.js";
import { setAuditPathForTests } from "./audit.js";
import { withLocalCoreFetch } from "./coreFetchTestHelper.js";
import { RuntimeError } from "./errors.js";
import { setKillPathForTests, writeKillSwitch } from "./kill.js";
import { setPendingPathForTests } from "./pendingStore.js";
import { setMandatePathForTests } from "./policy.js";
import { startProtectedResourceTestServer, type ProtectedResourceTestServer } from "./protectedResource.js";
import { setRequestsPathForTests, readRequests, type StoredRequest } from "./requestStore.js";
import { approveRequest, denyRequest, getRequestStatus, listPendingRequests, submitRequest, type RequestView } from "./requestRuntime.js";
import type { Intent, Mandate } from "../../schema/src/index.js";

const mandate: Mandate = {
    version: "1",
    userId: "demo",
    default: "deny",
    rules: [{ effect: "confirm", action: "write", tool: "http.request", host: "protected.local" }],
};

const intent: Intent = {
    agentId: "wait-agent",
    action: "write",
    tool: "http.request",
    target: "https://protected.local/mark",
    effects: [{ kind: "write", reversible: false }],
};

let dir: string;
let server: ProtectedResourceTestServer;
let previousSecrets: string | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingPath = () => join(dir, "pending.json");
const auditText = () => readFileSync(join(dir, "audit.jsonl"), "utf-8");

async function waitForPending(): Promise<RequestView> {
    for (let i = 0; i < 500; i++) {
        const [view] = listPendingRequests();
        if (view) return view;
        await sleep(5);
    }
    throw new Error("pending never appeared");
}

const storedRequests = (): StoredRequest[] => readRequests();
const rejectsWithCode = (code: string) => (error: unknown) => error instanceof RuntimeError && error.code === code;

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "meruntime-wait-"));
    const token = "wait-test-token";
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ protectedToken: token }), "utf-8");
    writeFileSync(join(dir, "mandate.json"), JSON.stringify(mandate), "utf-8");
    server = await startProtectedResourceTestServer({ expectedToken: token });
    previousSecrets = process.env.MERUNTIME_SECRETS;
    process.env.MERUNTIME_SECRETS = join(dir, "secrets.json");
    setMandatePathForTests(join(dir, "mandate.json"));
    setKillPathForTests(join(dir, "kill.json"));
    writeKillSwitch(false);
    setPendingPathForTests(pendingPath());
    setRequestsPathForTests(undefined);
    setAuditPathForTests(join(dir, "audit.jsonl"));
});

afterEach(async () => {
    await server.close();
    setMandatePathForTests(undefined);
    setKillPathForTests(undefined);
    setPendingPathForTests(undefined);
    setAuditPathForTests(undefined);
    if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
    else process.env.MERUNTIME_SECRETS = previousSecrets;
    rmSync(dir, { recursive: true, force: true });
});

test("YELLOW + aprobación durante la espera devuelve ejecutado, una sola ejecución", async () => {
    await withLocalCoreFetch(server, async () => {
        const waiting = executeAuthorized(intent, { pollMs: 10, approvalTimeoutMs: 10_000 });
        const pending = await waitForPending();
        assert.ok(Date.parse(pending.expiresAt!) > Date.now());

        const approved = await approveRequest(pending.requestId);
        assert.equal(approved.status, "EXECUTED");

        assert.deepEqual(await waiting, { success: true, status: 200 });
        assert.equal(server.executionCount(), 1);
    });
});

test("YELLOW + denegación devuelve bloqueado y no ejecuta", async () => {
    await withLocalCoreFetch(server, async () => {
        const waiting = executeAuthorized(intent, { pollMs: 10, approvalTimeoutMs: 10_000 });
        const rejection = assert.rejects(waiting, rejectsWithCode("POLICY_DENY"));
        denyRequest((await waitForPending()).requestId);
        await rejection;
        assert.equal(server.executionCount(), 0);
    });
});

test("YELLOW sin decisión expira, no ejecuta y queda en audit", async () => {
    await withLocalCoreFetch(server, async () => {
        await assert.rejects(executeAuthorized(intent, { pollMs: 10, approvalTimeoutMs: 100 }), rejectsWithCode("APPROVAL_TIMEOUT"));
        assert.equal(server.executionCount(), 0);
        assert.equal(storedRequests()[0].status, "EXPIRED");
        assert.match(auditText(), /"event":"transition".*"to":"EXPIRED"/);
    });
});

test("approve sobre una solicitud EXPIRED se rechaza y no la modifica", async () => {
    await withLocalCoreFetch(server, async () => {
        const view = await submitRequest({ intent }, { wait: false, approvalTimeoutMs: 20 });
        await sleep(60);
        assert.equal(getRequestStatus(view.requestId).status, "EXPIRED");
        const before = readFileSync(join(dir, "requests.json"), "utf-8");

        await assert.rejects(approveRequest(view.requestId), rejectsWithCode("ALREADY_DECIDED"));
        assert.throws(() => denyRequest(view.requestId), rejectsWithCode("ALREADY_DECIDED"));

        assert.equal(readFileSync(join(dir, "requests.json"), "utf-8"), before);
        assert.equal(server.executionCount(), 0);
    });
});

test("approve sobre una solicitud vencida que nadie marcó la expira sin ejecutar", async () => {
    await withLocalCoreFetch(server, async () => {
        const view = await submitRequest({ intent }, { wait: false, approvalTimeoutMs: 20 });
        await sleep(60);
        await assert.rejects(approveRequest(view.requestId), rejectsWithCode("APPROVAL_TIMEOUT"));
        assert.equal(storedRequests()[0].status, "EXPIRED");
        assert.equal(server.executionCount(), 0);
        assert.match(auditText(), /"to":"EXPIRED"/);
    });
});

test("kill switch durante la espera y luego approve: RED por reevaluación, nada ejecutado", async () => {
    await withLocalCoreFetch(server, async () => {
        const waiting = executeAuthorized(intent, { pollMs: 10, approvalTimeoutMs: 10_000 });
        const rejection = assert.rejects(
            waiting,
            (error) => error instanceof CoreAuthorizationError && error.verdict === "RED",
        );
        const pending = await waitForPending();
        writeKillSwitch(true);

        const view = await approveRequest(pending.requestId);
        assert.equal(view.status, "DENIED");
        await rejection;
        assert.equal(server.executionCount(), 0);
    });
});

test("{ wait: false } devuelve el pending sin bloquear", async () => {
    const result = await executeAuthorized(intent, { wait: false });
    assert.ok("pending" in result && result.pending);
    assert.equal(listPendingRequests()[0].requestId, result.id);
});

test("pending.json siempre es parseable con un escritor concurrente", async () => {
    const script = `
        const { writeFileAtomic } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "fsAtomic.ts")).href)});
        const big = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ i, pad: "x".repeat(50) })));
        for (let n = 0; n < 150; n++) writeFileAtomic(${JSON.stringify(pendingPath())}, big);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "inherit" });
    let exitCode: number | null | undefined;
    child.on("exit", (code) => { exitCode = code; });

    let reads = 0;
    while (exitCode === undefined) {
        try {
            JSON.parse(readFileSync(pendingPath(), "utf-8"));
            reads++;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!new Set(["ENOENT", "EPERM", "EBUSY", "EACCES"]).has(code ?? "")) throw error;
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(exitCode, 0);
    assert.ok(reads > 0);
});
