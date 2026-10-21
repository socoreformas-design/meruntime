// Mapa de adaptadores del CORE: solo estos ejecutan acciones, y solo el CORE llama a los sistemas externos.

import type { Intent, Mandate } from "../../schema/src/index.js";
import { executeCoreIntent, isCoreManagedIntent } from "./coreExecutor.js";
import { executePayment } from "./paymentAdapter.js";

export interface HttpRequest {
    method: string;
    url: string;
    body?: string;
}

export interface AdapterContext {
    /** Petición original (sin sanear); solo la usa el adaptador http.request. */
    request?: HttpRequest;
    /** Se cancela cuando vence executionTimeoutMs. */
    signal?: AbortSignal;
}

export interface AdapterResult {
    status?: number;
    /** Datos no secretos del desenlace, p.ej. transferId. Se guardan en el libro. */
    data?: Record<string, string | number>;
    /** Cuerpo de la respuesta: solo se devuelve en la llamada en vivo, nunca se guarda. */
    output?: string;
}

export type Adapter = (intent: Intent, requestId: string, context?: AdapterContext) => Promise<AdapterResult>;

export interface RegisteredAdapter {
    execute: Adapter;
    /** Precondición estática de un veredicto GREEN; devuelve el motivo si debe denegarse. */
    guard?: (intent: Intent, mandate: Mandate, request?: HttpRequest) => string | undefined;
}

const OUTPUT_MAX_CHARS = 2000;
const READ_MAX_BYTES = 64 * 1024;

async function readCapped(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    while (bytes < READ_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        text += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
    return text.slice(0, OUTPUT_MAX_CHARS);
}

function hostOf(url: string | undefined): string | undefined {
    try {
        return url ? new URL(url).hostname : undefined;
    } catch {
        return undefined;
    }
}

const httpAdapter: Adapter = async (intent, _requestId, context) => {
    if (isCoreManagedIntent(intent)) return executeCoreIntent(intent);

    const request = context?.request;
    if (!request) throw new Error("http.request needs the original request.");
    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are supported.");
    const method = request.method.toUpperCase();

    // Sin seguir redirecciones: un host permitido no puede reenviar la petición a otro.
    const response = await fetch(url, {
        method,
        body: method === "GET" || method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        signal: context?.signal,
    });
    const output = await readCapped(response);
    if (response.status >= 400) throw new Error(`HTTP request failed with status ${response.status}.`);
    return { status: response.status, output };
};

function httpGuard(intent: Intent, mandate: Mandate, request?: HttpRequest): string | undefined {
    if (isCoreManagedIntent(intent)) return undefined;
    const host = hostOf(request?.url ?? intent.target);
    if (!host || !mandate.allowHosts?.includes(host)) return `host '${host ?? "unknown"}' is not in allowHosts`;
    return undefined;
}

export const PAYMENT_TOOL = "payment.transfer";

export const ADAPTERS: Readonly<Record<string, RegisteredAdapter>> = {
    "http.request": { execute: httpAdapter, guard: httpGuard },
    [PAYMENT_TOOL]: { execute: executePayment },
};

export function adapterFor(intent: Intent): RegisteredAdapter | undefined {
    return Object.hasOwn(ADAPTERS, intent.tool) ? ADAPTERS[intent.tool] : undefined;
}
