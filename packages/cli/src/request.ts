// CLI: intercepta una petición HTTP, evalúa el semáforo y actúa según el veredicto.
// Uso: npm run request -- --method POST --url https://httpbin.org/post?mark=meruntime [--body '...']

import { isProtectedIntent } from "../../engine/src/adapter.js";
import { RuntimeError } from "../../engine/src/errors.js";
import { submitRequest } from "../../engine/src/requestRuntime.js";
import { intentFromHttp } from "../../proxy/src/intentFromTool.js";

const AGENT_ID = "cli-request";

function parseArgs(argv: string[]): { method?: string; url?: string; body?: string; idempotencyKey?: string } {
    const args: { method?: string; url?: string; body?: string; idempotencyKey?: string } = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--method") args.method = argv[++i];
        if (argv[i] === "--url") args.url = argv[++i];
        if (argv[i] === "--body") args.body = argv[++i];
        if (argv[i] === "--idempotency-key") args.idempotencyKey = argv[++i];
    }
    return args;
}

const { method, url, body, idempotencyKey } = parseArgs(process.argv.slice(2));
if (!method || !url) {
    console.error("Uso: --method <GET|POST|...> --url <url> [--body <texto>] [--idempotency-key <clave>]");
    process.exit(1);
}

const intent = intentFromHttp({ agentId: AGENT_ID, method, url, body });

{
    // YELLOW espera a que otra terminal ejecute approve/deny, o a que venza el plazo.
    try {
        const view = await submitRequest(
            { intent, request: { method: method.toUpperCase(), url, body }, idempotencyKey },
            { onPending: (p) => console.error(`MERUNTIME_PENDING ${p.requestId} expires=${p.expiresAt} Waiting for approval (meruntime approve ${p.requestId} | meruntime deny ${p.requestId}).`) },
        );
        const lastActor = view.transitions[view.transitions.length - 1]?.actor;
        switch (view.status) {
            case "EXECUTED":
                if (isProtectedIntent(intent)) console.log("MERUNTIME_EXECUTED protected.local/mark");
                else if (view.output !== undefined) console.log(`status=${view.result?.status}\n${view.output}`);
                else console.log(`MERUNTIME_EXECUTED status=${view.result?.status ?? 200}`);
                process.exit(0);
                break;
            case "DENIED":
                console.log(lastActor === "runtime" ? `MERUNTIME_BLOCKED RED rule=${view.rule}` : "MERUNTIME_DENIED Denied by the user. Action NOT executed.");
                break;
            case "EXPIRED":
                console.log("MERUNTIME_EXPIRED Approval timed out. Action NOT executed.");
                break;
            case "FAILED":
                console.error(`MERUNTIME_ERROR ${view.error?.code} ${view.error?.message}`);
                break;
            case "UNKNOWN":
                console.error(`MERUNTIME_UNKNOWN request_id=${view.requestId} ${view.error?.message ?? "Outcome unknown; NOT retried automatically."}`);
                break;
            default:
                console.log(`MERUNTIME_PENDING request_id=${view.requestId} status=${view.status}`);
        }
    } catch (err) {
        const shape = err instanceof RuntimeError ? err.toShape() : { code: "INTERNAL_ERROR", message: "Internal error." };
        console.error(`MERUNTIME_ERROR ${shape.code} ${shape.message}`);
    }
    process.exit(1);
}
