// Traduce una llamada HTTP entrante (desde la tool MCP) a un Intent de Me Runtime.
// No hace red ni I/O: es una función pura de mapeo.

import type { ActionClass, Effect, Intent } from "../../schema/src/index.js";

export interface HttpToolInput {
    agentId: string;
    method: string;
    url: string;
    body?: string;
}

export interface PaymentToolInput {
    agentId: string;
    iban: string;
    amountEur: number;
    concept: string;
}

/** Intent canónico de pago: amountEur en la raíz (lo que lee el motor) y {iban, concept} en params. */
export function intentFromPayment(input: PaymentToolInput): Intent {
    return {
        agentId: input.agentId,
        action: "pay",
        tool: "payment.transfer",
        amountEur: input.amountEur,
        params: { iban: input.iban, concept: input.concept },
        effects: [{ kind: "pay", reversible: false, scope: "bank:fakebank" }],
    };
}

export function intentFromHttp(input: HttpToolInput): Intent {
    const method = input.method.toUpperCase();
    const action: ActionClass = method === "GET" || method === "HEAD" ? "read" : "write";
    const reversible = action === "read";
    const origin = new URL(input.url).origin;

    const effect: Effect = {
        kind: action,
        reversible,
        scope: origin,
    };

    return {
        agentId: input.agentId,
        action,
        tool: "http.request",
        // target como string plano para que evaluate() pueda extraer el host con new URL().
        target: input.url,
        effects: [effect],
    };
}
