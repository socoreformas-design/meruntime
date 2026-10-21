import { readApiToken } from "../../http-api/src/token.js";

const HOOK_EVENT = "PreToolUse";
const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const API_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;

interface ClaudeHookInput {
    hook_event_name?: unknown;
    session_id?: unknown;
    agent_id?: unknown;
    agent_type?: unknown;
    tool_use_id?: unknown;
    tool_name?: unknown;
    tool_input?: { command?: unknown };
    cwd?: unknown;
}

interface ApiDecision {
    verdict?: unknown;
    status?: unknown;
    request_id?: unknown;
    expires_at?: unknown;
    status_url?: unknown;
    error?: { code?: unknown; message?: unknown };
}

function response(permissionDecision: "allow" | "deny", reason: string): void {
    const output = {
        hookSpecificOutput: {
            hookEventName: HOOK_EVENT,
            permissionDecision,
            ...(permissionDecision === "deny" ? { permissionDecisionReason: reason } : {}),
        },
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
}

function deny(reason: string): number {
    console.error(`meruntime hook claude: ${reason}`);
    response("deny", reason);
    return 0;
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_HOOK_INPUT_BYTES) throw new Error("hook input exceeded the size limit");
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf-8");
}

function localApiBase(): string {
    const configured = process.env.MERUNTIME_API_URL ?? "http://127.0.0.1:4319";
    const url = new URL(configured);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error("MERUNTIME_API_URL must be a plain HTTP loopback base URL");
    }
    return url.origin;
}

async function apiRequest(base: string, token: string, path: string, method: "GET" | "POST", body?: unknown): Promise<ApiDecision> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
        const result = await fetch(new URL(path, base), {
            method,
            headers: {
                "x-meruntime-token": token,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
        });
        let json: ApiDecision;
        try {
            json = await result.json() as ApiDecision;
        } catch {
            throw new Error("Me Runtime returned invalid JSON");
        }
        if (!result.ok) {
            const code = typeof json.error?.code === "string" ? json.error.code : `HTTP_${result.status}`;
            throw new Error(`Me Runtime rejected the authorization request (${code})`);
        }
        return json;
    } finally {
        clearTimeout(timer);
    }
}

function isDecision(value: ApiDecision): value is ApiDecision & { verdict: "GREEN" | "YELLOW" | "RED"; status: string } {
    return ["GREEN", "YELLOW", "RED"].includes(String(value.verdict)) && typeof value.status === "string";
}

async function waitForApproval(base: string, token: string, statusUrl: string, expiresAt?: string): Promise<ApiDecision> {
    if (!/^\/api\/authorizations\/mr_[0-9a-f]{12}$/.test(statusUrl)) throw new Error("Me Runtime returned an invalid authorization status URL");
    const deadline = expiresAt ? Date.parse(expiresAt) : Date.now() + 5 * 60 * 1000;
    if (!Number.isFinite(deadline)) throw new Error("Me Runtime returned an invalid approval expiry");
    for (; ;) {
        if (Date.now() >= deadline) throw new Error("authorization approval timed out");
        await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))));
        const status = await apiRequest(base, token, statusUrl, "GET");
        if (!isDecision(status)) throw new Error("Me Runtime returned an unknown authorization status");
        if (status.verdict !== "YELLOW" || status.status !== "PENDING") return status;
    }
}

export async function runHookClaude(args: string[]): Promise<number> {
    if (args.length !== 0) return deny("Usage: meruntime hook claude");
    let event: ClaudeHookInput;
    try {
        const input = await readStdin();
        const parsed: unknown = JSON.parse(input);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("hook input must be a JSON object");
        event = parsed as ClaudeHookInput;
    } catch {
        return deny("invalid or oversized Claude hook input");
    }

    if (event.hook_event_name !== HOOK_EVENT
        || (event.tool_name !== "Bash" && event.tool_name !== "PowerShell")
        || typeof event.session_id !== "string" || event.session_id.length === 0
        || typeof event.tool_use_id !== "string" || event.tool_use_id.length === 0
        || typeof event.tool_input?.command !== "string" || event.tool_input.command.length === 0
        || typeof event.cwd !== "string" || event.cwd.length === 0) {
        return deny("unsupported or incomplete Claude PreToolUse event");
    }

    let token: string;
    let base: string;
    try {
        token = readApiToken();
        base = localApiBase();
    } catch {
        return deny("local Me Runtime token or API configuration is unavailable");
    }

    try {
        const decision = await apiRequest(base, token, "/api/authorize", "POST", {
            agent_id: typeof event.agent_id === "string" && event.agent_id.length > 0
                ? event.agent_id
                : typeof event.agent_type === "string" && event.agent_type.length > 0 ? event.agent_type : "claude-code",
            tool_name: event.tool_name,
            command: event.tool_input.command,
            cwd: event.cwd,
            idempotency_key: `claude-code:${event.session_id}:${event.tool_use_id}`,
        });
        if (!isDecision(decision)) return deny("Me Runtime returned no recognized verdict");
        const finalDecision = decision.verdict === "YELLOW"
            ? await waitForApproval(base, token, String(decision.status_url ?? ""), typeof decision.expires_at === "string" ? decision.expires_at : undefined)
            : decision;
        if (!isDecision(finalDecision)) return deny("Me Runtime returned no recognized final verdict");
        if (finalDecision.verdict === "GREEN" && finalDecision.status === "AUTHORIZED") {
            response("allow", "");
            return 0;
        }
        return deny(`Me Runtime decision: ${finalDecision.verdict} (${String(finalDecision.rule ?? finalDecision.status)})`);
    } catch (error) {
        return deny(error instanceof Error ? error.message : "Me Runtime authorization failed");
    }
}