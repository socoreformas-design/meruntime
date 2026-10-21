import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { startFakeBank, type FakeBank } from "../../fakebank/src/server.js";
import { appendAudit, setAuditPathForTests } from "../../engine/src/audit.js";
import { authorizeCommand } from "../../engine/src/authorizationRuntime.js";
import { setAuthorizationPathForTests } from "../../engine/src/authorizationStore.js";
import { setKillPathForTests } from "../../engine/src/kill.js";
import { setBankUrlForTests } from "../../engine/src/paymentAdapter.js";
import { setPendingPathForTests } from "../../engine/src/pendingStore.js";
import { MERUNTIME_DIR } from "../../engine/src/paths.js";
import { getRequestsPath } from "../../engine/src/requestStore.js";
import { buildMandate } from "../../engine/src/profiles.js";
import { setMandatePathForTests } from "../../engine/src/policy.js";
import { submitRequest } from "../../engine/src/requestRuntime.js";
import { intentFromPayment } from "../../proxy/src/intentFromTool.js";
import { startUiServer, type UiServer } from "./server.js";
import { renderPage } from "./page.js";
import packageMetadata from "../../../package.json";

const BANK_TOKEN = "ui-test-bank-token";
const NEW_IBAN = "ES00 EVIL 0000 0000 0000 0666";
const PAGOS = join(import.meta.dirname, "..", "..", "..", "examples", "mandates", "pagos.json");

let dir: string;
let bank: FakeBank;
let ui: UiServer;
let previousSecrets: string | undefined;
let previousHome: string | undefined;

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any }

function call(method: string, path: string, options: { token?: string | null; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
    const { port } = new URL(ui.url);
    const token = options.token === undefined ? ui.token : options.token;
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            host: "127.0.0.1", port, path, method,
            headers: {
                ...(token ? { "x-meruntime-token": token } : {}),
                ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
                ...options.headers,
            },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf-8");
                let json: any;
                try { json = JSON.parse(text); } catch { json = undefined; }
                resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
            });
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const pendingPayment = (amountEur = 35) => submitRequest(
    { intent: intentFromPayment({ agentId: "ui-agent", iban: NEW_IBAN, amountEur, concept: "Factura 2026-0042" }) },
    { wait: false },
);

class PageNode {
    children: PageNode[] = [];
    className = "";
    disabled = false;
    private text = "";
    private attributes = new Map<string, string>();
    private listeners = new Map<string, () => void | Promise<void>>();
    constructor(readonly tag = "") {}
    get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
    set textContent(value: string) { this.text = value; this.children = []; }
    append(...children: PageNode[]) { this.children.push(...children); }
    replaceChildren(...children: PageNode[]) { this.text = ""; this.children = children; }
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    getAttribute(key: string) { return this.attributes.get(key) ?? null; }
    addEventListener(event: string, callback: () => void | Promise<void>) { this.listeners.set(event, callback); }
    async click() { if (!this.disabled) await this.listeners.get("click")?.(); }
    classList = {
        add: (value: string) => { this.className = [...new Set([...this.className.split(" "), value])].join(" ").trim(); },
        remove: (value: string) => { this.className = this.className.split(" ").filter((item) => item !== value).join(" "); },
        contains: (value: string) => this.className.split(" ").includes(value),
    };
}

interface PageSession {
    hash?: string;
    storage?: Map<string, string>;
    storageBlocked?: boolean;
}

function pageHarness(fetch: (path: string, options?: RequestInit) => Promise<Response>, session: PageSession = {}) {
    const roots = new Map<string, PageNode>();
    const node = (id: string) => {
        if (!roots.has(id)) roots.set(id, new PageNode());
        return roots.get(id)!;
    };
    const descendants = (root: PageNode): PageNode[] => root.children.flatMap((child) => [child, ...descendants(child)]);
    const timers = new Map<number, { callback: () => void; delay: number }>();
    const storage = session.storage ?? new Map<string, string>();
    const location = { hash: session.hash ?? "#t=test", pathname: "/", origin: "http://127.0.0.1" };
    let timerId = 0;
    const script = /<script nonce="test">([\s\S]*?)<\/script>/.exec(renderPage("test", "test"))?.[1];
    if (!script) throw new Error("UI script not found");
    const startup = script.lastIndexOf('for (const button of document.querySelectorAll(".nav-btn"))');
    assert.ok(startup > 0);
    const controls: {
        setPending(requests: Array<{ requestId: string }>): void;
        refresh(): Promise<void>;
        storageUnavailable(): boolean;
    } = runInNewContext(script.slice(0, startup) + `
      renderStatus = renderSummary = renderSecurity = renderAudit = () => {};
      ({
        setPending(requests) { state.pending = requests; renderPending(); },
        refresh,
        storageUnavailable: () => storageUnavailable,
      });
    `, {
        Node: PageNode, URLSearchParams, AbortController, fetch, location,
        sessionStorage: {
            getItem(key: string) { if (session.storageBlocked) throw new Error("Storage blocked"); return storage.get(key) ?? null; },
            setItem(key: string, value: string) { if (session.storageBlocked) throw new Error("Storage blocked"); storage.set(key, value); },
            removeItem(key: string) { if (session.storageBlocked) throw new Error("Storage blocked"); storage.delete(key); },
        },
        history: { replaceState() { location.hash = ""; } },
        document: {
            documentElement: { lang: "" },
            createElement: (tag: string) => new PageNode(tag),
            createTextNode: (text: string) => { const result = new PageNode(); result.textContent = text; return result; },
            getElementById: node,
            querySelectorAll: (selector: string) => selector === "[data-request-id]"
                ? [...roots.values()].flatMap(descendants).filter((item) => item.getAttribute("data-request-id") !== null) : [],
        },
        setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; },
        clearTimeout: (id: number) => timers.delete(id),
    });
    const buttons = (id: string) => descendants(node(id)).filter((item) => item.tag === "button");
    return { ...controls, node, buttons, timers, storage, location };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const pageRequest = {
    requestId: "mr_123456789abc", agent: "claude-code",
    headline: { es: "<img src=x onerror=alert(1)>", en: "command" },
    createdAt: "2026-10-21T12:00:00Z", expiresAt: "2099-01-01T00:00:00Z",
};

test("la consola bloquea ambas copias, avisa seis segundos y retira la solicitud y el contador", async () => {
    for (const [kind, status, message, tone] of [
        ["approve", "AUTHORIZED", "Solicitud aprobada", "success"],
        ["approve", "EXECUTED", "Solicitud aprobada", "success"],
        ["deny", "DENIED", "Solicitud denegada", "danger"],
    ]) {
        const reply = deferred<Response>();
        let calls = 0;
        const page = pageHarness(async (path) => { assert.equal(path, "/api/" + kind); calls++; return reply.promise; });
        page.setPending([pageRequest]);
        const index = kind === "approve" ? 0 : 1;
        const click = page.buttons("pending")[index].click();
        for (const button of [...page.buttons("pending"), ...page.buttons("pending-preview")]) assert.equal(button.disabled, true);
        await page.buttons("pending-preview")[index].click();
        assert.equal(calls, 1);
        reply.resolve(Response.json({ requestId: pageRequest.requestId, status }));
        await click;

        assert.equal(page.node("toast").textContent, message + " · " + pageRequest.requestId);
        assert.equal(page.node("toast").className, tone);
        assert.equal(page.node("pending-count").textContent, "0");
        assert.equal(page.buttons("pending").length, 0);
        assert.equal(page.buttons("pending-preview").length, 0);
        const [timer] = [...page.timers.values()];
        assert.equal(timer.delay, 6000);
        timer.callback();
        assert.equal(page.node("toast").classList.contains("hidden"), true);
    }
});

test("la consola explica fallos y reactiva ambos botones sin anunciar un falso exito", async () => {
    const failures = [
        { code: "NETWORK_ERROR", reason: "Sin conexión" },
        { code: "APPROVAL_TIMEOUT", reason: "ha caducado" },
        { code: "ALREADY_DECIDED", reason: "ya se había resuelto" },
        { code: "REQUEST_NOT_FOUND", reason: "ya no existe" },
        { code: "UNAUTHORIZED", reason: "El acceso ha caducado" },
        { code: "INTERNAL_ERROR", reason: "error inesperado" },
        { status: "DENIED", reason: "han bloqueado" },
        { status: "EXPIRED", reason: "ha caducado" },
        { status: "FAILED", reason: "ha fallado" },
        { status: "UNKNOWN", reason: "No la repitas automáticamente" },
        { status: "PENDING", reason: "respuesta inesperada" },
        { status: "INVALID_JSON", reason: "respuesta inesperada" },
    ];
    for (const failure of failures) {
        for (const kind of ["approve", "deny"]) {
            if (kind === "deny" && failure.status === "DENIED") continue;
            const page = pageHarness(async () => {
                if (failure.code === "NETWORK_ERROR") throw new TypeError("Failed to fetch");
                if (failure.status === "INVALID_JSON") return new Response("not JSON");
                return failure.code
                    ? Response.json({ code: failure.code, message: "<script>alert(1)</script>" }, { status: 409 })
                    : Response.json({ status: failure.status });
            });
            page.setPending([pageRequest]);
            await page.buttons("pending")[kind === "approve" ? 0 : 1].click();
            assert.ok(page.node("toast").textContent.includes(failure.reason), JSON.stringify(failure));
            assert.ok(page.node("toast").textContent.includes(pageRequest.requestId));
            assert.equal(page.node("toast").className, "danger");
            assert.equal(page.node("pending-count").textContent, "1");
            for (const button of [...page.buttons("pending"), ...page.buttons("pending-preview")]) assert.equal(button.disabled, false);
            assert.equal(page.node("toast").children.length, 0);
        }
    }
});

test("los avisos y tarjetas tratan HTML como texto y reemplazan el temporizador anterior", async () => {
    const page = pageHarness(async () => Response.json({ status: "AUTHORIZED" }));
    const request = { ...pageRequest, requestId: "<img src=x onerror=alert(1)>" };
    page.setPending([request]);
    assert.ok(page.node("pending").textContent.includes(request.headline.es));
    await page.buttons("pending")[0].click();
    assert.equal(page.node("toast").textContent, "Solicitud aprobada · " + request.requestId);
    assert.equal(page.node("toast").children.length, 0);
    page.setPending([pageRequest]);
    await page.buttons("pending")[0].click();
    assert.equal(page.timers.size, 1);
});

test("un refresco anterior a la decision no repone la tarjeta ya aprobada", async () => {
    const stalePending = deferred<Response>();
    const pendingStarted = deferred<void>();
    const page = pageHarness(async (path) => {
        if (path === "/api/status") return Response.json({ version: "test", needsSetup: false });
        if (path === "/api/pending") { pendingStarted.resolve(); return stalePending.promise; }
        if (path === "/api/approve") return Response.json({ status: "AUTHORIZED" });
        return Response.json([]);
    });
    page.setPending([pageRequest]);
    const refresh = page.refresh();
    await pendingStarted.promise;
    await page.buttons("pending")[0].click();
    stalePending.resolve(Response.json([pageRequest]));
    await refresh;
    assert.equal(page.node("pending-count").textContent, "0");
    assert.equal(page.buttons("pending").length, 0);
});

function healthyPageResponse(path: string): Response {
    return Response.json(path === "/api/status" ? { version: "test", needsSetup: false } : []);
}

test("F5 recupera el token solo en la sesion de la pestaña y un enlace nuevo lo sustituye", async () => {
    const storage = new Map<string, string>();
    const tokens: string[] = [];
    const fetch = async (path: string, options?: RequestInit) => {
        tokens.push(new Headers(options?.headers).get("x-meruntime-token") ?? "");
        assert.equal(options?.method, "GET");
        assert.equal(options?.mode, "same-origin");
        assert.equal(options?.redirect, "error");
        assert.equal(path.includes("secret"), false);
        return healthyPageResponse(path);
    };
    const first = pageHarness(fetch, { hash: "#t=secret", storage });
    assert.equal(first.location.hash, "");
    await first.refresh();
    const reloaded = pageHarness(fetch, { hash: "", storage });
    await reloaded.refresh();
    assert.equal(tokens.length, 8);
    assert.ok(tokens.every((token) => token === "secret"));
    const replacement = pageHarness(fetch, { hash: "#t=new-secret", storage });
    await replacement.refresh();
    assert.ok(tokens.slice(8).every((token) => token === "new-secret"));
    assert.equal(replacement.location.hash, "");
    assert.equal(storage.get("meruntime.ui.token"), "new-secret");
    let otherTabCalls = 0;
    const otherTab = pageHarness(async () => { otherTabCalls++; return healthyPageResponse("/api/status"); }, { hash: "" });
    await otherTab.refresh();
    assert.equal(otherTabCalls, 0);
    assert.ok(otherTab.node("offline").textContent.includes("No se puede recuperar esta sesión"));
});

test("un corte temporal reintenta solo lecturas y restaura la consola al recuperar todos los datos", async () => {
    let online = false;
    const methods: string[] = [];
    const page = pageHarness(async (path, options) => {
        methods.push(options?.method ?? "");
        if (!online) throw new TypeError("Failed to fetch");
        return healthyPageResponse(path);
    });
    await page.refresh();
    assert.ok(page.node("offline").textContent.includes("Reconectando…"));
    assert.equal(page.node("body-grid").classList.contains("offline-mode"), true);
    for (let i = 0; i < 4; i++) await page.refresh();
    assert.ok(page.node("offline").textContent.includes("Si lo cerraste"));
    online = true;
    await page.refresh();
    assert.equal(page.node("offline").classList.contains("hidden"), true);
    assert.equal(page.node("body-grid").classList.contains("offline-mode"), false);
    assert.ok(methods.every((method) => method === "GET"));
});

test("reconectar no repite una aprobacion o denegacion cuya respuesta se perdio", async () => {
    for (const kind of ["approve", "deny"]) {
        const writes: string[] = [];
        const page = pageHarness(async (path, options) => {
            if (options?.method === "POST") {
                writes.push(path);
                throw new TypeError("Connection lost after sending decision");
            }
            return healthyPageResponse(path);
        });
        page.setPending([pageRequest]);
        await page.buttons("pending")[kind === "approve" ? 0 : 1].click();
        await page.refresh();
        await page.refresh();
        assert.deepEqual(writes, ["/api/" + kind]);
        assert.equal(page.node("pending-count").textContent, "0");
        assert.ok(page.node("toast").textContent.includes("revisa el estado"));
    }
});

test("si falla una consulta secundaria no declara reconexion hasta recuperar la vista completa", async () => {
    for (const failure of ["network", "server", "json"]) {
        let broken = true;
        const page = pageHarness(async (path) => {
            if (path === "/api/pending" && broken) {
                if (failure === "network") throw new TypeError("Failed to fetch");
                return failure === "json" ? new Response("broken") : Response.json({ code: "INTERNAL_ERROR" }, { status: 500 });
            }
            return healthyPageResponse(path);
        });
        await page.refresh();
        assert.equal(page.node("offline").classList.contains("hidden"), false);
        assert.equal(page.node("body-grid").classList.contains("offline-mode"), true);
        assert.ok(page.node("offline").textContent.includes(failure === "network" ? "Se ha perdido la conexión" : "No se pudieron actualizar"));
        broken = false;
        await page.refresh();
        assert.equal(page.node("offline").classList.contains("hidden"), true);
    }
});

test("un 401 borra el token obsoleto y pide abrir la nueva sesion sin reintentar decisiones", async () => {
    let calls = 0;
    const page = pageHarness(async () => { calls++; return Response.json({ code: "UNAUTHORIZED" }, { status: 401 }); });
    await page.refresh();
    assert.equal(page.storage.has("meruntime.ui.token"), false);
    assert.ok(page.node("offline").textContent.includes("No se puede recuperar esta sesión"));
    assert.ok(page.node("offline").textContent.includes("meruntime ui"));
    await page.refresh();
    assert.equal(calls, 1);
});

test("las consultas atascadas caducan a los cinco segundos, no se solapan y luego reintentan", async () => {
    let calls = 0;
    let stalled = true;
    const page = pageHarness(async (path, options) => {
        calls++;
        if (!stalled) return healthyPageResponse(path);
        return new Promise<Response>((_, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
        });
    });
    const first = page.refresh();
    await page.refresh();
    assert.equal(calls, 1);
    const [timeout] = [...page.timers.values()];
    assert.equal(timeout.delay, 5000);
    timeout.callback();
    await first;
    assert.equal(page.timers.size, 0);
    assert.ok(page.node("offline").textContent.includes("Reconectando"));
    stalled = false;
    await page.refresh();
    assert.equal(page.node("offline").classList.contains("hidden"), true);
});

test("si el navegador bloquea sessionStorage mantiene el acceso actual y avisa de la limitacion", async () => {
    const page = pageHarness(async (path) => healthyPageResponse(path), { storageBlocked: true });
    assert.equal(page.storageUnavailable(), true);
    await page.refresh();
    assert.equal(page.node("body-grid").classList.contains("offline-mode"), false);
    const pageText = renderPage("test", "test");
    assert.match(pageText, /if \(storageUnavailable\) toast\("El navegador no permite guardar la sesión/);
    const reloaded = pageHarness(async (path) => healthyPageResponse(path), { storageBlocked: true, hash: "" });
    await reloaded.refresh();
    assert.ok(reloaded.node("offline").textContent.includes("No se puede recuperar esta sesión"));
});

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "meruntime-ui-"));
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ fakeBankToken: BANK_TOKEN, pendingHmacKey: "ab".repeat(32) }), "utf-8");
    writeFileSync(join(dir, "kill.json"), JSON.stringify({ on: false }), "utf-8");
    previousSecrets = process.env.MERUNTIME_SECRETS;
    previousHome = process.env.MERUNTIME_HOME;
    process.env.MERUNTIME_SECRETS = join(dir, "secrets.json");
    process.env.MERUNTIME_HOME = dir;
    bank = await startFakeBank({ token: BANK_TOKEN, port: 0 });
    setBankUrlForTests(bank.url);
    setMandatePathForTests(PAGOS);
    setKillPathForTests(join(dir, "kill.json"));
    setPendingPathForTests(join(dir, "pending.json"));
    setAuditPathForTests(join(dir, "audit.jsonl"));
    setAuthorizationPathForTests(join(dir, "authorizations.json"));
    ui = await startUiServer();
});

afterEach(async () => {
    await ui.close();
    await bank.close();
    setBankUrlForTests(undefined);
    setMandatePathForTests(undefined);
    setKillPathForTests(undefined);
    setPendingPathForTests(undefined);
    setAuditPathForTests(undefined);
    setAuthorizationPathForTests(undefined);
    if (previousSecrets === undefined) delete process.env.MERUNTIME_SECRETS;
    else process.env.MERUNTIME_SECRETS = previousSecrets;
    if (previousHome === undefined) delete process.env.MERUNTIME_HOME;
    else process.env.MERUNTIME_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
});

test("la página se sirve con CSP estricta, sin token y sin innerHTML", async () => {
    const page = await call("GET", "/", { token: null });

    assert.equal(page.status, 200);
    const csp = String(page.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce);
    assert.ok(page.text.includes(`<script nonce="${nonce}">`));
    assert.equal(page.text.includes(ui.token), false);
    assert.equal(page.text.includes("innerHTML"), false);
    assert.equal(/\sstyle="/.test(page.text), false);
    assert.match(csp, /default-src 'none'/);
    assert.ok(page.text.includes(`<span id="footer-version">Versión ${packageMetadata.version}</span>`));
    assert.match(page.text, /id="body-grid" class="body-grid offline-mode"/);
});

test("estado sin conexión oculta el banner de estado y explica cómo volver", async () => {
    const page = await call("GET", "/", { token: null });

    assert.match(page.text, /id="offline" class="status-band bad hidden"/);
    assert.match(page.text, /id="banner" class="status-band hidden"/);
    assert.match(page.text, /No se puede recuperar esta sesión\. Ejecuta/);
    assert.match(page.text, /el\("code", \{\}, "meruntime ui"\)/);
    assert.match(page.text, /ventana nueva o su enlace completo con acceso/);
    assert.match(page.text, /setInterval\(refresh, 2000\)/);
    assert.match(page.text, /getElementById\("banner"\)\.classList\.add\("hidden"\)/);
    assert.match(page.text, /getElementById\("body-grid"\)\.classList\.add\("offline-mode"\)/);
});

test("la consola ofrece cuatro vistas en español y no incluye claims del mock de diseño", async () => {
    const page = await call("GET", "/", { token: null });

    for (const view of ["Resumen", "Solicitudes", "Actividad", "Seguridad"]) assert.ok(page.text.includes(view));
    assert.match(page.text, /none:"No hay solicitudes pendientes"/);
    assert.match(page.text, /noEvents:"Aún no hay actividad\. Prueba la demo del IBAN"/);
    assert.match(page.text, /unknownOutcome:"La acción pudo ejecutarse, pero no se guardó el resultado\. No la repitas automáticamente\."/);
    assert.match(page.text, /class="brand-mark"/);
    assert.match(page.text, /id="footer-version"/);
    for (const claim of [
        "0.4.1-rc", "Loopback Socket", "Exportar .jsonl", "Revalidar firmas", "Secuencia criptográfica verificada",
        "SHA-256", "inotify", "Inodos", "IMAP / RFC 822 / Token de agente", "Criptograma del Payload",
        "req_audit_98124_trace", "Telemetría de integridad", "HMAC Engine", "Aislamiento",
        "Subida: 0 fallos críticos", "/var/log", "./runtime/state", "Datos de ejemplo",
    ]) assert.equal(page.text.includes(claim), false, `unexpected design-only claim: ${claim}`);
});

test("rechaza Host ajeno, falta de token, content-type erróneo y otro origen", async () => {
    assert.equal((await call("GET", "/", { token: null, headers: { host: "evil.example" } })).status, 421);
    assert.equal((await call("GET", "/api/status", { token: null })).status, 401);
    assert.equal((await call("GET", "/api/status", { token: "wrong" })).status, 401);
    assert.equal((await call("POST", "/api/kill", { headers: { "content-type": "text/plain" } })).status, 415);
    const crossOrigin = await call("POST", "/api/kill", { headers: { origin: "https://evil.example" }, body: { on: true } });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await call("GET", "/api/status")).json.killOn, false);
});

test("estado de protección: protegido, bloqueado con el kill switch y a la vista si falta el mandato", async () => {
    const protectedState = (await call("GET", "/api/status")).json;
    assert.equal(protectedState.state, "protected");
    assert.equal(protectedState.killOn, false);

    assert.deepEqual((await call("POST", "/api/kill", { body: { on: true } })).json, { on: true });
    assert.equal((await call("GET", "/api/status")).json.state, "blocked");
    assert.deepEqual((await call("POST", "/api/kill", { body: { on: false } })).json, { on: false });
    assert.equal((await call("GET", "/api/status")).json.state, "protected");

    setMandatePathForTests(join(dir, "missing.json"));
    assert.equal((await call("GET", "/api/status")).json.state, "attention");
    assert.equal((await call("POST", "/api/kill", { body: { on: "yes" } })).status, 400);
});

test("el resumen cuenta veredictos de audit.jsonl sin contar transiciones y expone datos reales", async () => {
    for (const decision of ["GREEN", "YELLOW", "RED"] as const) {
        appendAudit({ event: "request", request_id: `mr_${decision.toLowerCase()}00000000`, agent: "ui-test", action: "read", decision, reason: "test" });
    }
    appendAudit({
        event: "transition", request_id: "mr_transition01", agent: "ui-test", action: "read", decision: "PENDING",
        reason: "test transition", from: "EVALUATING", to: "PENDING", actor: "runtime",
    });

    const summary = (await call("GET", "/api/summary")).json;
    const status = (await call("GET", "/api/status")).json;

    assert.deepEqual(summary, { eventCount: 4, verdicts: { GREEN: 1, YELLOW: 1, RED: 1 } });
    assert.equal(status.version, packageMetadata.version);
    assert.equal(status.dataDirectory, MERUNTIME_DIR);
    assert.equal(status.defaultDeny, true);
    assert.deepEqual(status.files, {
        audit: join(MERUNTIME_DIR, "audit.jsonl"),
        requests: getRequestsPath(),
        kill: join(MERUNTIME_DIR, "kill.json"),
    });
    assert.deepEqual(status.policy, {
        default: "deny", ruleCount: 1, perTxEur: 50, approvalTimeoutMinutes: 5,
        rateLimitPerSecond: 20, maxPendingRequests: 50,
    });
});

test("el kill switch activado desde la UI bloquea las solicitudes del CORE y queda auditado", async () => {
    await call("POST", "/api/kill", { body: { on: true } });
    const view = await submitRequest({ intent: intentFromPayment({ agentId: "ui-agent", iban: NEW_IBAN, amountEur: 10, concept: "x" }) });

    assert.equal(view.status, "DENIED");
    assert.equal(view.rule, "killSwitch");
    const audit = (await call("GET", "/api/audit")).json as Array<{ event: string; reason: string }>;
    assert.ok(audit.some((e) => e.event === "kill-on" && e.reason.includes("(ui)")));
});

test("lista una solicitud pendiente con lo necesario para decidir y sin datos internos", async () => {
    const pending = await pendingPayment();
    const list = (await call("GET", "/api/pending")).json as Array<Record<string, unknown>>;

    assert.equal(list.length, 1);
    assert.equal(list[0].requestId, pending.requestId);
    assert.equal(list[0].amountEur, 35);
    assert.deepEqual(list[0].params, { iban: NEW_IBAN, concept: "Factura 2026-0042" });
    assert.equal(list[0].rule, "payees.unknownIban");
    assert.deepEqual(list[0].headline, {
        en: `"ui-agent" wants to pay €35.00 to ${NEW_IBAN}`,
        es: `«ui-agent» quiere pagar 35,00 € a ${NEW_IBAN}`,
    });
    assert.equal((list[0].why as { es: string }).es, "Es un IBAN que no está en tu lista de confianza.");
    assert.equal(/intentMac|replayMac|payloadHash|idempotencyKey/.test(JSON.stringify(list)), false);
});

test("UI muestra comando, cwd y agent_id completos como texto no ejecutable", async () => {
    writeFileSync(join(dir, "mandate.json"), JSON.stringify({
        version: "1", userId: "ui-terminal", default: "deny",
        rules: [{ effect: "confirm", action: "write", tool: "terminal.command" }],
    }), "utf-8");
    setMandatePathForTests(join(dir, "mandate.json"));
    const command = "echo </script><img src=x onerror=alert(1)>\u001b[31m";
    const cwd = "C:\\workspace\\<project>";
    const pending = authorizeCommand({ agentId: "claude-code", toolName: "Bash", command, cwd, idempotencyKey: "ui-terminal-xss" });

    const list = await call("GET", "/api/pending");
    assert.equal(list.status, 200);
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].command, command);
    assert.equal(list.json[0].cwd, cwd);
    assert.equal(list.json[0].agentId, "claude-code");
    assert.equal(list.json[0].requestId, pending.requestId);

    const page = await call("GET", "/", { token: null });
    assert.equal(page.text.includes(command), false);
    assert.match(page.text, /el\("dd", \{\}, v\)/);
    assert.equal(page.text.includes("innerHTML"), false);
});

test("autorizar desde la UI ejecuta una vez en el banco y se audita con el actor de la UI", async () => {
    const pending = await pendingPayment();

    const approved = await call("POST", "/api/approve", { body: { requestId: pending.requestId } });
    const again = await call("POST", "/api/approve", { body: { requestId: pending.requestId } });

    assert.equal(approved.status, 200);
    assert.equal(approved.json.status, "EXECUTED");
    assert.equal(again.status, 409);
    assert.equal(again.json.code, "ALREADY_DECIDED");
    assert.equal(bank.transfers().length, 1);
    assert.deepEqual((await call("GET", "/api/pending")).json, []);
    const audit = (await call("GET", "/api/audit")).json as Array<{ actor?: string; to?: string }>;
    assert.ok(audit.some((e) => e.to === "APPROVED" && e.actor === "user (ui)"));
});

test("denegar desde la UI no envía nada al banco", async () => {
    const pending = await pendingPayment();

    const denied = await call("POST", "/api/deny", { body: { requestId: pending.requestId } });

    assert.equal(denied.json.status, "DENIED");
    assert.equal(bank.transfers().length, 0);
    assert.equal((await call("POST", "/api/deny", { body: { requestId: pending.requestId } })).status, 409);
});

test("la autorización repite la reevaluación: con el kill switch activo se deniega sin ejecutar", async () => {
    const pending = await pendingPayment();
    await call("POST", "/api/kill", { body: { on: true } });

    const result = await call("POST", "/api/approve", { body: { requestId: pending.requestId } });

    assert.equal(result.json.status, "DENIED");
    assert.equal(bank.transfers().length, 0);
});

test("valida el requestId y devuelve el historial más reciente primero", async () => {
    assert.equal((await call("POST", "/api/approve", { body: { requestId: "../etc/passwd" } })).status, 400);
    assert.equal((await call("POST", "/api/approve", { body: { requestId: "mr_000000000000" } })).status, 404);

    await call("POST", "/api/kill", { body: { on: true } });
    await call("POST", "/api/kill", { body: { on: false } });
    const audit = (await call("GET", "/api/audit?limit=2")).json as Array<{ event: string }>;
    assert.deepEqual(audit.map((e) => e.event), ["kill-off", "kill-on"]);
    assert.equal(readFileSync(join(dir, "audit.jsonl"), "utf-8").includes(ui.token), false);
});

test("asistente: sin mandato pide configuración, crea el perfil elegido sin sobrescribir y después queda protegido", async () => {
    const mandatePath = join(MERUNTIME_DIR, "mandate.json");
    rmSync(mandatePath, { force: true });
    setMandatePathForTests(mandatePath);
    try {
        const before = (await call("GET", "/api/status")).json;
        assert.equal(before.needsSetup, true);
        assert.equal(before.state, "attention");

        const done = await call("POST", "/api/setup", { body: { profile: "payments-known", limit: 30, ibans: ["ES00 DEMO 0000 0000 0000 0001"] } });
        assert.equal(done.status, 200);
        assert.deepEqual(done.json.files, [
            { name: "mandate.json", status: "created" },
            { name: "secrets.json", status: "skipped" },
            { name: "kill.json", status: "skipped" },
        ]);
        assert.deepEqual(JSON.parse(readFileSync(mandatePath, "utf-8")), buildMandate("payments-known", { perTxEur: 30, knownIbans: ["ES00 DEMO 0000 0000 0000 0001"] }));
        const after = (await call("GET", "/api/status")).json;
        assert.equal(after.needsSetup, false);
        assert.equal(after.state, "protected");

        const again = await call("POST", "/api/setup", { body: { profile: "blocked" } });
        assert.equal(again.status, 409);
        assert.deepEqual(JSON.parse(readFileSync(mandatePath, "utf-8")), buildMandate("payments-known", { perTxEur: 30, knownIbans: ["ES00 DEMO 0000 0000 0000 0001"] }));
    } finally {
        rmSync(mandatePath, { force: true });
    }
});

test("asistente: rechaza perfiles y opciones inválidos sin crear nada", async () => {
    const mandatePath = join(MERUNTIME_DIR, "mandate.json");
    rmSync(mandatePath, { force: true });
    setMandatePathForTests(mandatePath);
    try {
        for (const body of [
            { profile: "nope" },
            { profile: "payments-ask", limit: "50" },
            { profile: "payments-ask", limit: 0 },
            { profile: "read-only", hosts: "api.github.com" },
            { profile: "payments-known", ibans: [1] },
            {},
        ]) {
            assert.equal((await call("POST", "/api/setup", { body })).status, 400, JSON.stringify(body));
        }
        assert.equal((await call("POST", "/api/setup", { token: "wrong", body: { profile: "blocked" } })).status, 401);
        assert.throws(() => readFileSync(mandatePath, "utf-8"), /ENOENT/);
    } finally {
        rmSync(mandatePath, { force: true });
    }
});

test("asistente: entrega la configuración MCP para copiar", async () => {
    const config = (await call("GET", "/api/mcp-config")).json;

    assert.deepEqual(config.claudeAndCursor.mcpServers.meruntime, { command: "meruntime", args: ["mcp"] });
    assert.deepEqual(config.claudeAndCursor.mcpServers.meruntime, { command: "meruntime", args: ["mcp"] });
    assert.equal(config.vscode.servers.meruntime.type, "stdio");
    assert.equal(config.local.meruntime.command, "node");
    assert.ok(Array.isArray(config.local.meruntime.args));
});

test("clientes MCP: detecta, conecta con copia de seguridad, rechaza lo no detectado y desconecta", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const cursorFile = join(home, ".cursor", "mcp.json");
    writeFileSync(cursorFile, JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf-8");
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.APPDATA = join(home, "AppData", "Roaming");
    try {
        const before = ((await call("GET", "/api/clients")).json as Array<{ id: string; detected: boolean; connected: boolean }>);
        assert.deepEqual(before.find((c) => c.id === "cursor"), { id: "cursor", name: "Cursor", path: cursorFile, detected: true, connected: false });
        assert.equal(before.find((c) => c.id === "claude-desktop")?.detected, false);

        const done = await call("POST", "/api/clients/connect", { body: { id: "cursor" } });
        assert.deepEqual(done.json, { changed: true, backedUp: true });
        const config = JSON.parse(readFileSync(cursorFile, "utf-8"));
        assert.deepEqual(config.mcpServers.other, { command: "x" });
        assert.equal(config.mcpServers.meruntime.command, process.execPath);
        assert.deepEqual((await call("POST", "/api/clients/connect", { body: { id: "cursor" } })).json, { changed: false, backedUp: false });

        assert.equal((await call("POST", "/api/clients/connect", { body: { id: "claude-desktop" } })).status, 400);
        assert.equal((await call("POST", "/api/clients/connect", { body: { id: "../../etc/passwd" } })).status, 400);
        assert.equal((await call("POST", "/api/clients/connect", { token: "wrong", body: { id: "cursor" } })).status, 401);

        assert.deepEqual((await call("POST", "/api/clients/disconnect", { body: { id: "cursor" } })).json, { changed: true, backedUp: true });
        assert.deepEqual(JSON.parse(readFileSync(cursorFile, "utf-8")).mcpServers, { other: { command: "x" } });
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
