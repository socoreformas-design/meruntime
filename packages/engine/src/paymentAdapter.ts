import type { Intent } from "../../schema/src/index.js";
import { readFakeBankToken } from "./secrets.js";
import type { AdapterContext, AdapterResult } from "./adapters.js";

let bankUrlOverride: string | undefined;

export function setBankUrlForTests(url: string | undefined): void {
    bankUrlOverride = url;
}

function bankUrl(): string {
    return bankUrlOverride ?? process.env.MERUNTIME_FAKEBANK_URL ?? "http://127.0.0.1:4318";
}

/** Transferencia al banco de prueba. El token se lee aquí y nunca sale del CORE. */
export async function executePayment(intent: Intent, requestId: string, context?: AdapterContext): Promise<AdapterResult> {
    const iban = intent.params?.iban;
    const concept = intent.params?.concept;
    const amountEur = intent.amountEur;
    if (intent.action !== "pay" || typeof iban !== "string" || typeof concept !== "string"
        || typeof amountEur !== "number" || !Number.isFinite(amountEur) || amountEur <= 0) {
        throw new Error("Invalid payment intent.");
    }

    const response = await fetch(`${bankUrl()}/transfers`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${readFakeBankToken()}`,
            "Idempotency-Key": requestId,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ iban, amountEur, concept }),
        signal: context?.signal,
    });
    if (!response.ok) throw new Error(`Bank rejected transfer with status ${response.status}.`);

    const body = await response.json().catch(() => ({})) as { transferId?: unknown };
    return {
        status: response.status,
        data: typeof body.transferId === "string" ? { transferId: body.transferId } : undefined,
    };
}
