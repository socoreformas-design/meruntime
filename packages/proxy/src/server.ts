// Servidor MCP por stdio: tools "http_request" y "payment_transfer".
// Toda solicitud pasa por el runtime (evaluación, estados, idempotencia) y solo el CORE ejecuta.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageMetadata from "../../../package.json";
import { isGitHubUserIntent, isProtectedIntent } from "../../engine/src/adapter.js";
import { RuntimeError } from "../../engine/src/errors.js";
import { submitRequest, type RequestView } from "../../engine/src/requestRuntime.js";
import type { Intent } from "../../schema/src/index.js";
import { intentFromHttp, intentFromPayment } from "./intentFromTool.js";

const AGENT_ID = "mcp-proxy";

const server = new McpServer({ name: "meruntime-proxy", version: packageMetadata.version });

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Respuesta final al agente a partir del estado de la solicitud; no expone intent, firma ni credenciales. */
function describeView(view: RequestView, intent: Intent): ToolResult {
    const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], isError: isError || undefined });
    switch (view.status) {
        case "EXECUTED":
            if (intent.tool === "payment.transfer") {
                return text(`MERUNTIME_EXECUTED payment.transfer transferId=${view.result?.data?.transferId ?? "unknown"}`);
            }
            if (isProtectedIntent(intent)) return text("MERUNTIME_EXECUTED protected.local/mark");
            if (isGitHubUserIntent(intent)) return text(`MERUNTIME_EXECUTED api.github.com/user status=${view.result?.status ?? 200}`);
            if (view.output !== undefined) return text(`status=${view.result?.status}\n${view.output}`);
            return text(`MERUNTIME_EXECUTED status=${view.result?.status ?? 200} (response body is only returned to the call that executed it; use a new idempotency_key to run it again)`);
        case "DENIED":
            if (view.transitions[view.transitions.length - 1]?.actor === "runtime") {
                return text(`MERUNTIME_BLOCKED RED rule=${view.rule}`, true);
            }
            return text("MERUNTIME_DENIED Denied by the user. Action NOT executed.", true);
        case "EXPIRED":
            return text("MERUNTIME_EXPIRED Approval timed out. Action NOT executed.", true);
        case "FAILED":
            return text(`MERUNTIME_ERROR ${view.error?.code ?? "ADAPTER_ERROR"} ${view.error?.message ?? "Execution failed."}`, true);
        case "UNKNOWN":
            return text(`MERUNTIME_UNKNOWN request_id=${view.requestId} ${view.error?.message ?? "Outcome unknown; NOT retried automatically."}`, true);
        default:
            return text(`MERUNTIME_PENDING request_id=${view.requestId} status=${view.status} Awaiting human approval.`, true);
    }
}

server.registerTool(
    "http_request",
    {
        description: "Realiza una petición HTTP tras pasar por el semáforo de Me Runtime.",
        inputSchema: {
            method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
            url: z.string(),
            body: z.string().optional(),
            idempotency_key: z.string().min(1).max(256).optional(),
        },
    },
    async ({ method, url, body, idempotency_key }) => {
        let intent: Intent;
        try {
            intent = intentFromHttp({ agentId: AGENT_ID, method, url, body });
        } catch {
            return { content: [{ type: "text", text: "MERUNTIME_ERROR INVALID_REQUEST url must be an absolute URL." }], isError: true };
        }
        try {
            // YELLOW bloquea hasta decisión humana o expiración; stdout es del protocolo MCP, el id va a stderr.
            const view = await submitRequest(
                { intent, request: { method, url, body }, idempotencyKey: idempotency_key },
                { onPending: (pending) => console.error(`MERUNTIME_PENDING ${pending.requestId} expires=${pending.expiresAt} (meruntime approve ${pending.requestId} | meruntime deny ${pending.requestId})`) },
            );
            return describeView(view, intent);
        } catch (err) {
            const shape = err instanceof RuntimeError ? err.toShape() : { code: "INTERNAL_ERROR", message: "Internal error." };
            return { content: [{ type: "text", text: `MERUNTIME_ERROR ${shape.code} ${shape.message}` }], isError: true };
        }
    }
);

server.registerTool(
    "payment_transfer",
    {
        description: "Solicita una transferencia bancaria. Pasa por el semáforo de Me Runtime; puede quedar a la espera de aprobación humana.",
        inputSchema: {
            iban: z.string().min(1).max(42),
            amountEur: z.number().positive().finite(),
            concept: z.string().max(140),
            idempotency_key: z.string().min(1).max(256).optional(),
        },
    },
    async ({ iban, amountEur, concept, idempotency_key }) => {
        const intent = intentFromPayment({ agentId: AGENT_ID, iban, amountEur, concept });
        try {
            const view = await submitRequest(
                { intent, request: { method: "POST", url: "payment.transfer" }, idempotencyKey: idempotency_key },
                { onPending: (pending) => console.error(`MERUNTIME_PENDING ${pending.requestId} expires=${pending.expiresAt} (meruntime approve ${pending.requestId} | meruntime deny ${pending.requestId})`) },
            );
            return describeView(view, intent);
        } catch (err) {
            const shape = err instanceof RuntimeError ? err.toShape() : { code: "INTERNAL_ERROR", message: "Internal error." };
            return { content: [{ type: "text", text: `MERUNTIME_ERROR ${shape.code} ${shape.message}` }], isError: true };
        }
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
