// Servidor local de la interfaz de escritorio: 127.0.0.1, token de sesión y cabeceras anti-CSRF/rebinding.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import packageMetadata from "../../../package.json";
import { readAuditLines } from "../../engine/src/audit.js";
import { approveAuthorization, denyAuthorization, getAuthorization, listPendingAuthorizations } from "../../engine/src/authorizationRuntime.js";
import { RuntimeError } from "../../engine/src/errors.js";
import { describeAction, explainRule } from "../../engine/src/explain.js";
import { checkSetup } from "../../engine/src/health.js";
import { setKillSwitch } from "../../engine/src/kill.js";
import { DEFAULT_MAX_PENDING_REQUESTS, DEFAULT_RATE_LIMIT_PER_SECOND } from "../../engine/src/policy.js";
import { isProfileId, type ProfileOptions } from "../../engine/src/profiles.js";
import { approveRequest, denyRequest, describePending } from "../../engine/src/requestRuntime.js";
import { getRequestsPath } from "../../engine/src/requestStore.js";
import { initializeState } from "../../engine/src/setup.js";
import { mcpConfigs } from "../../cli/src/init.js";
import { ClientError, connectClient, disconnectClient, isClientId, listClients } from "../../cli/src/clients.js";
import { renderPage } from "./page.js";

export interface UiServer {
    url: string;
    token: string;
    close(): Promise<void>;
}

const MAX_BODY_BYTES = 8 * 1024;
const REQUEST_ID = /^mr_[0-9a-f]{12}$/;
const ACTOR = "user (ui)";

const STATUS_BY_CODE: Partial<Record<string, number>> = {
    REQUEST_NOT_FOUND: 404, ALREADY_DECIDED: 409, APPROVAL_TIMEOUT: 409, INVALID_REQUEST: 400, STORAGE_ERROR: 500,
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }).end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
    sendJson(response, status, { code, message });
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        request.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new RuntimeError("INVALID_REQUEST", "Request body too large."));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => {
            try {
                const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
                resolve(parsed as Record<string, unknown>);
            } catch {
                reject(new RuntimeError("INVALID_REQUEST", "Body must be a JSON object."));
            }
        });
        request.on("error", reject);
    });
}

function buildStatus() {
    const report = checkSetup();
    const killOn = report.killOn ?? false;
    const failed = report.checks.some((c) => c.level === "fail");
    const mandate = report.mandate
        ? `${report.mandate.rules.length} rules, perTxEur ${report.mandate.ceilings?.perTxEur ?? "-"}, approval ${Math.round((report.mandate.approvalTimeoutMs ?? 300_000) / 60_000)} min`
        : undefined;
    const lastEvent = readAuditLines(1)[0]?.at;
    return {
        state: killOn ? "blocked" : failed ? "attention" : "protected",
        killOn,
        version: packageMetadata.version,
        dataDirectory: report.stateDir,
        defaultDeny: report.mandate?.default !== "allow",
        files: {
            audit: join(report.stateDir, "audit.jsonl"),
            requests: getRequestsPath(),
            kill: join(report.stateDir, "kill.json"),
        },
        policy: {
            default: report.mandate?.default ?? "deny",
            ruleCount: report.mandate?.rules.length ?? 0,
            perTxEur: report.mandate?.ceilings?.perTxEur ?? null,
            approvalTimeoutMinutes: Math.round((report.mandate?.approvalTimeoutMs ?? 300_000) / 60_000),
            rateLimitPerSecond: report.mandate?.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT_PER_SECOND,
            maxPendingRequests: report.mandate?.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
        },
        needsSetup: report.missing.includes("mandate.json"),
        checks: report.checks,
        mandate,
        lastEvent,
    };
}

function buildSummary() {
    const audit = readAuditLines();
    const verdicts = { GREEN: 0, YELLOW: 0, RED: 0 };
    for (const entry of audit) {
        if (entry.event === "request" && (entry.decision === "GREEN" || entry.decision === "YELLOW" || entry.decision === "RED")) {
            verdicts[entry.decision]++;
        }
    }
    return { eventCount: audit.length, verdicts };
}

const MAX_LIST_ITEMS = 50;

function stringList(name: string, value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS || value.some((v) => typeof v !== "string" || v.length > 100)) {
        throw new RuntimeError("INVALID_REQUEST", `${name} must be a short list of strings.`);
    }
    return value;
}

/** Primer arranque: crea mandato, secretos y kill switch con el perfil elegido; nunca sobrescribe. */
function applySetup(body: Record<string, unknown>) {
    if (!checkSetup().missing.includes("mandate.json")) {
        throw new RuntimeError("ALREADY_DECIDED", "Setup was already completed.");
    }
    if (typeof body.profile !== "string" || !isProfileId(body.profile)) {
        throw new RuntimeError("INVALID_REQUEST", "Unknown profile.");
    }
    if (body.limit !== undefined && typeof body.limit !== "number") {
        throw new RuntimeError("INVALID_REQUEST", "limit must be a number.");
    }
    const options: ProfileOptions = { perTxEur: body.limit, allowHosts: stringList("hosts", body.hosts), knownIbans: stringList("ibans", body.ibans) };
    try {
        return initializeState(body.profile, options).map(({ name, status }) => ({ name, status }));
    } catch (err) {
        throw new RuntimeError("INVALID_REQUEST", err instanceof Error ? err.message : "Invalid options.");
    }
}

function buildPending() {
    const context = { perTxEur: checkSetup().mandate?.ceilings?.perTxEur };
    const requests = describePending().map((p) => ({
        ...p,
        headline: describeAction(p),
        why: explainRule(p.rule, "YELLOW", context),
    }));
    const authorizations = listPendingAuthorizations().map((p) => ({
        requestId: p.requestId,
        agent: p.agentId,
        agentId: p.agentId,
        action: p.action,
        tool: "terminal.command",
        toolName: p.toolName,
        command: p.command,
        cwd: p.cwd,
        rule: p.rule,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        headline: {
            en: `${JSON.stringify(p.agentId)} terminal command ${JSON.stringify(p.command)}`,
            es: `${JSON.stringify(p.agentId)} quiere ejecutar ${JSON.stringify(p.command)}`,
        },
        why: explainRule(p.rule, "YELLOW", context),
    }));
    return [...requests, ...authorizations];
}

export async function startUiServer(options: { port?: number; token?: string } = {}): Promise<UiServer> {
    const token = options.token ?? randomBytes(24).toString("hex");
    const tokenBuffer = Buffer.from(token, "utf-8");
    const allowedHosts = new Set<string>();
    const allowedOrigins = new Set<string>();

    const tokenIsValid = (header: string | string[] | undefined): boolean => {
        if (typeof header !== "string") return false;
        const provided = Buffer.from(header, "utf-8");
        return provided.length === tokenBuffer.length && timingSafeEqual(provided, tokenBuffer);
    };

    const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        // Un nombre de host distinto delata DNS rebinding: ni se sirve la página ni responde la API.
        if (!allowedHosts.has(request.headers.host ?? "")) {
            sendError(response, 421, "INVALID_REQUEST", "Unexpected Host header.");
            return;
        }
        const url = new URL(request.url ?? "/", "http://localhost");

        if (request.method === "GET" && url.pathname === "/") {
            const nonce = randomBytes(16).toString("base64");
            response.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
            }).end(renderPage(nonce, packageMetadata.version));
            return;
        }
        if (!url.pathname.startsWith("/api/")) {
            sendError(response, 404, "INVALID_REQUEST", "Not found.");
            return;
        }
        if (!tokenIsValid(request.headers["x-meruntime-token"])) {
            sendError(response, 401, "UNAUTHORIZED", "Missing or invalid session token.");
            return;
        }

        try {
            if (request.method === "GET") {
                if (url.pathname === "/api/status") return sendJson(response, 200, buildStatus());
                if (url.pathname === "/api/summary") return sendJson(response, 200, buildSummary());
                if (url.pathname === "/api/mcp-config") return sendJson(response, 200, mcpConfigs());
                if (url.pathname === "/api/clients") return sendJson(response, 200, listClients());
                if (url.pathname === "/api/pending") return sendJson(response, 200, buildPending());
                if (url.pathname === "/api/audit") {
                    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
                    return sendJson(response, 200, readAuditLines(limit).reverse());
                }
                return sendError(response, 404, "INVALID_REQUEST", "Not found.");
            }

            if (request.method !== "POST") return sendError(response, 405, "INVALID_REQUEST", "Method not allowed.");
            // application/json obliga a un preflight CORS desde otros orígenes; además se valida Origin.
            if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
                return sendError(response, 415, "INVALID_REQUEST", "Content-Type must be application/json.");
            }
            const origin = request.headers.origin;
            if (origin !== undefined && !allowedOrigins.has(origin)) {
                return sendError(response, 403, "UNAUTHORIZED", "Cross-origin request rejected.");
            }
            const body = await readJsonBody(request);

            if (url.pathname === "/api/setup") return sendJson(response, 200, { files: applySetup(body) });
            if (url.pathname === "/api/clients/connect" || url.pathname === "/api/clients/disconnect") {
                if (typeof body.id !== "string" || !isClientId(body.id)) throw new RuntimeError("INVALID_REQUEST", "Unknown client.");
                try {
                    const result = url.pathname.endsWith("/connect") ? connectClient(body.id) : disconnectClient(body.id);
                    return sendJson(response, 200, { changed: result.changed, backedUp: result.backupPath !== undefined });
                } catch (err) {
                    if (err instanceof ClientError) throw new RuntimeError("INVALID_REQUEST", err.message);
                    throw err;
                }
            }
            if (url.pathname === "/api/kill") {
                if (typeof body.on !== "boolean") throw new RuntimeError("INVALID_REQUEST", "`on` must be a boolean.");
                setKillSwitch(body.on, "ui");
                return sendJson(response, 200, { on: body.on });
            }
            if (url.pathname === "/api/approve" || url.pathname === "/api/deny") {
                if (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId)) {
                    throw new RuntimeError("INVALID_REQUEST", "requestId is not valid.");
                }
                const authorization = getAuthorization(body.requestId);
                const view = authorization
                    ? url.pathname === "/api/approve"
                        ? approveAuthorization(body.requestId, ACTOR)
                        : denyAuthorization(body.requestId, ACTOR)
                    : url.pathname === "/api/approve"
                        ? await approveRequest(body.requestId, { actor: ACTOR })
                        : denyRequest(body.requestId, { actor: ACTOR });
                return sendJson(response, 200, { requestId: view.requestId, status: view.status, error: view.error });
            }
            return sendError(response, 404, "INVALID_REQUEST", "Not found.");
        } catch (err) {
            if (err instanceof RuntimeError) {
                return sendError(response, STATUS_BY_CODE[err.code] ?? 400, err.code, err.message);
            }
            return sendError(response, 500, "INTERNAL_ERROR", "Internal error.");
        }
    };

    const server: Server = createServer((request, response) => {
        handle(request, response).catch(() => {
            if (!response.headersSent) sendError(response, 500, "INTERNAL_ERROR", "Internal error.");
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("UI server did not bind to a TCP port.");
    for (const host of ["127.0.0.1", "localhost"]) {
        allowedHosts.add(`${host}:${address.port}`);
        allowedOrigins.add(`http://${host}:${address.port}`);
    }

    return {
        url: `http://127.0.0.1:${address.port}/`,
        token,
        close: () => new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}
