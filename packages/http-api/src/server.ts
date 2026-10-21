import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { RuntimeError } from "../../engine/src/errors.js";
import { getRequestStatus, submitRequest, type Adapter, type RequestView } from "../../engine/src/requestRuntime.js";
import { authorizeCommand, getAuthorization } from "../../engine/src/authorizationRuntime.js";
import { intentFromHttp, intentFromPayment } from "../../proxy/src/intentFromTool.js";

export const DEFAULT_HTTP_API_PORT = 4319;
const MAX_BODY_BYTES = 8 * 1024;
const REQUEST_ID = /^mr_[0-9a-f]{12}$/;
const AGENT_ID = "http-api";
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

class BodyTooLargeError extends Error { }

export interface HttpApiServer {
    url: string;
    close(): Promise<void>;
}

export interface HttpApiOptions {
    port?: number;
    token: string | (() => string);
    adapter?: Adapter;
}

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
        let rejected = false;
        request.on("data", (chunk: Buffer) => {
            if (rejected) return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                rejected = true;
                reject(new BodyTooLargeError("Request body too large."));
                request.resume();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => {
            if (rejected) return;
            try {
                const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
                resolve(parsed as Record<string, unknown>);
            } catch {
                reject(new RuntimeError("INVALID_REQUEST", "Body must be a JSON object."));
            }
        });
        request.on("error", (error) => {
            if (!rejected) reject(error);
        });
    });
}

function decisionFor(view: RequestView): "GREEN" | "YELLOW" | "RED" | "UNKNOWN" {
    switch (view.status) {
        case "DENIED":
        case "EXPIRED":
            return "RED";
        case "FAILED":
        case "UNKNOWN":
            return "UNKNOWN";
        case "EXECUTED":
            return view.verdict === "GREEN" ? "GREEN" : "YELLOW";
        default:
            return "YELLOW";
    }
}

function publicView(view: RequestView, includeLiveOutput = false) {
    const decision = decisionFor(view);
    return {
        verdict: decision,
        status: view.status,
        request_id: view.requestId,
        ...(view.expiresAt ? { expires_at: view.expiresAt } : {}),
        ...(view.rule ? { rule: view.rule } : {}),
        ...(view.result ? {
            result: {
                ...(view.result.status === undefined ? {} : { http_status: view.result.status }),
                ...(view.result.data ? { data: view.result.data } : {}),
                ...(includeLiveOutput && view.output !== undefined ? { body: view.output } : {}),
            },
        } : includeLiveOutput && view.output !== undefined ? { result: { body: view.output } } : {}),
        ...(view.error ? { error: { code: view.error.code, message: view.error.message } } : {}),
    };
}

function onlyKeys(body: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(body).every((key) => keys.includes(key));
}

function makeSubmission(body: Record<string, unknown>) {
    if (typeof body.idempotency_key !== "string" || body.idempotency_key.length < 1 || body.idempotency_key.length > 256) {
        throw new RuntimeError("INVALID_REQUEST", "idempotency_key must contain 1-256 characters.");
    }

    if (body.tool === "http_request") {
        if (!onlyKeys(body, ["tool", "method", "url", "body", "idempotency_key"])) {
            throw new RuntimeError("INVALID_REQUEST", "Unexpected field in http_request.");
        }
        if (typeof body.method !== "string" || !HTTP_METHODS.has(body.method.toUpperCase())) {
            throw new RuntimeError("INVALID_REQUEST", "method must be GET, HEAD, POST, PUT, PATCH or DELETE.");
        }
        if (typeof body.url !== "string" || body.url.length === 0) {
            throw new RuntimeError("INVALID_REQUEST", "url must be a non-empty absolute URL.");
        }
        if (body.body !== undefined && typeof body.body !== "string") {
            throw new RuntimeError("INVALID_REQUEST", "body must be a string.");
        }
        let url: URL;
        try {
            url = new URL(body.url);
        } catch {
            throw new RuntimeError("INVALID_REQUEST", "url must be an absolute URL.");
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new RuntimeError("INVALID_REQUEST", "url must use http or https.");
        }
        const method = body.method.toUpperCase();
        const request = { method, url: body.url, ...(body.body === undefined ? {} : { body: body.body }) };
        return {
            intent: intentFromHttp({ agentId: AGENT_ID, ...request }),
            request,
            idempotencyKey: body.idempotency_key,
        };
    }

    if (body.tool === "payment_transfer") {
        if (!onlyKeys(body, ["tool", "iban", "amount_eur", "concept", "idempotency_key"])) {
            throw new RuntimeError("INVALID_REQUEST", "Unexpected field in payment_transfer.");
        }
        if (typeof body.iban !== "string" || body.iban.length === 0
            || typeof body.concept !== "string" || body.concept.length === 0
            || typeof body.amount_eur !== "number" || !Number.isFinite(body.amount_eur) || body.amount_eur <= 0) {
            throw new RuntimeError("INVALID_REQUEST", "payment_transfer requires a non-empty iban and concept, and a positive finite amount_eur.");
        }
        return {
            intent: intentFromPayment({
                agentId: AGENT_ID,
                iban: body.iban,
                amountEur: body.amount_eur,
                concept: body.concept,
            }),
            idempotencyKey: body.idempotency_key,
        };
    }

    throw new RuntimeError("INVALID_REQUEST", "tool must be http_request or payment_transfer.");
}

function makeAuthorization(body: Record<string, unknown>) {
    if (!onlyKeys(body, ["agent_id", "tool_name", "command", "cwd", "idempotency_key"])) {
        throw new RuntimeError("INVALID_REQUEST", "Unexpected field in terminal authorization.");
    }
    if (typeof body.agent_id !== "string" || typeof body.tool_name !== "string"
        || typeof body.command !== "string" || typeof body.cwd !== "string"
        || typeof body.idempotency_key !== "string") {
        throw new RuntimeError("INVALID_REQUEST", "Terminal authorization requires agent_id, tool_name, command, cwd and idempotency_key strings.");
    }
    if (body.tool_name !== "Bash" && body.tool_name !== "PowerShell") {
        throw new RuntimeError("INVALID_REQUEST", "tool_name must be Bash or PowerShell.");
    }
    return {
        agentId: body.agent_id,
        toolName: body.tool_name,
        command: body.command,
        cwd: body.cwd,
        idempotencyKey: body.idempotency_key,
    } as const;
}

function authorizationErrorStatus(code: string): number {
    if (code === "REQUEST_NOT_FOUND") return 404;
    if (code === "IDEMPOTENCY_KEY_REUSED" || code === "ALREADY_DECIDED" || code === "APPROVAL_TIMEOUT") return 409;
    if (code === "STORAGE_BUSY" || code === "STORAGE_ERROR") return 503;
    return 400;
}

export async function startHttpApiServer(options: HttpApiOptions): Promise<HttpApiServer> {
    const initialToken = typeof options.token === "string" ? options.token : options.token();
    if (Buffer.byteLength(initialToken, "utf-8") === 0) throw new Error("API token must not be empty.");
    const allowedHosts = new Set<string>();
    const allowedOrigins = new Set<string>();
    const tokenIsValid = (header: string | string[] | undefined): boolean => {
        if (typeof header !== "string") return false;
        let token: string;
        try {
            token = typeof options.token === "string" ? options.token : options.token();
        } catch {
            return false;
        }
        const tokenBuffer = Buffer.from(token, "utf-8");
        const provided = Buffer.from(header, "utf-8");
        return provided.length === tokenBuffer.length && timingSafeEqual(provided, tokenBuffer);
    };

    const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        if (!allowedHosts.has(request.headers.host ?? "")) {
            sendError(response, 421, "INVALID_REQUEST", "Unexpected Host header.");
            return;
        }
        if (!tokenIsValid(request.headers["x-meruntime-token"])) {
            sendError(response, 401, "UNAUTHORIZED", "Missing or invalid session token.");
            return;
        }
        const origin = request.headers.origin;
        if (origin !== undefined && !allowedOrigins.has(origin)) {
            sendError(response, 403, "UNAUTHORIZED", "Cross-origin request rejected.");
            return;
        }

        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET") {
            const authorizationMatch = /^\/api\/authorizations\/(mr_[0-9a-f]{12})$/.exec(url.pathname);
            if (authorizationMatch) {
                try {
                    const authorization = getAuthorization(authorizationMatch[1]);
                    if (!authorization) {
                        sendError(response, 404, "REQUEST_NOT_FOUND", "Authorization not found.");
                        return;
                    }
                    sendJson(response, 200, {
                        verdict: authorization.verdict,
                        status: authorization.status,
                        request_id: authorization.requestId,
                        rule: authorization.rule,
                        ...(authorization.expiresAt ? { expires_at: authorization.expiresAt } : {}),
                    });
                } catch (error) {
                    if (error instanceof RuntimeError) sendError(response, authorizationErrorStatus(error.code), error.code, error.message);
                    else sendError(response, 503, "STORAGE_ERROR", "Authorization status is unavailable.");
                }
                return;
            }
            const match = /^\/api\/requests\/(mr_[0-9a-f]{12})$/.exec(url.pathname);
            if (!match) {
                sendError(response, 404, "INVALID_REQUEST", "Not found.");
                return;
            }
            try {
                sendJson(response, 200, publicView(getRequestStatus(match[1])));
            } catch (error) {
                if (error instanceof RuntimeError && error.code === "REQUEST_NOT_FOUND") {
                    sendError(response, 404, error.code, error.message);
                } else {
                    sendJson(response, 503, { verdict: "UNKNOWN", status: "UNKNOWN", error: { code: "STATUS_UNAVAILABLE", message: "Request status is unavailable." } });
                }
            }
            return;
        }

        if (request.method !== "POST") {
            sendError(response, 405, "INVALID_REQUEST", "Method not allowed.");
            return;
        }
        if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
            sendError(response, 415, "INVALID_REQUEST", "Content-Type must be application/json.");
            return;
        }
        const contentLength = Number(request.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
            sendError(response, 413, "INVALID_REQUEST", "Request body too large.");
            request.resume();
            return;
        }

        try {
            const body = await readJsonBody(request);
            if (url.pathname === "/api/authorize") {
                const authorization = authorizeCommand(makeAuthorization(body));
                sendJson(response, authorization.status === "PENDING" ? 202 : 200, {
                    verdict: authorization.verdict,
                    status: authorization.status,
                    request_id: authorization.requestId,
                    rule: authorization.rule,
                    ...(authorization.expiresAt ? { expires_at: authorization.expiresAt } : {}),
                    ...(authorization.status === "PENDING" ? { status_url: `/api/authorizations/${authorization.requestId}` } : {}),
                });
                return;
            }
            if (url.pathname !== "/api/check") {
                sendError(response, 404, "INVALID_REQUEST", "Not found.");
                return;
            }
            const input = makeSubmission(body);
            const view = await submitRequest(input, { wait: false, adapter: options.adapter });
            const decision = decisionFor(view);
            sendJson(response, view.status === "PENDING" ? 202 : 200, {
                ...publicView(view, true),
                ...(decision === "YELLOW" && view.status === "PENDING"
                    ? { status_url: `/api/requests/${view.requestId}` }
                    : {}),
            });
        } catch (error) {
            if (error instanceof BodyTooLargeError) {
                sendError(response, 413, "INVALID_REQUEST", error.message);
                return;
            }
            if (error instanceof RuntimeError) {
                const status = authorizationErrorStatus(error.code);
                sendError(response, status, error.code, error.message);
                return;
            }
            sendJson(response, 503, {
                verdict: "UNKNOWN",
                status: "UNKNOWN",
                error: { code: "EVALUATION_UNAVAILABLE", message: "The evaluation outcome is unknown; do not retry automatically." },
            });
        }
    };

    const server: Server = createServer((request, response) => {
        handle(request, response).catch(() => {
            if (!response.headersSent) {
                sendJson(response, 503, {
                    verdict: "UNKNOWN",
                    status: "UNKNOWN",
                    error: { code: "EVALUATION_UNAVAILABLE", message: "The evaluation outcome is unknown; do not retry automatically." },
                });
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? DEFAULT_HTTP_API_PORT, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP API did not bind to a TCP port.");
    const host = `127.0.0.1:${address.port}`;
    allowedHosts.add(host);
    allowedOrigins.add(`http://${host}`);

    return {
        url: `http://${host}`,
        close: () => new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}