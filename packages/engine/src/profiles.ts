// Perfiles: mandatos prefabricados para quien no quiere escribir reglas. Solo generan datos.

import type { Mandate, Rule } from "../../schema/src/index.js";
import { DEFAULT_MAX_PENDING_REQUESTS, DEFAULT_RATE_LIMIT_PER_SECOND } from "./policy.js";

export const PROFILE_IDS = ["read-only", "payments-ask", "payments-known", "blocked"] as const;
export type ProfileId = typeof PROFILE_IDS[number];

export interface ProfileOptions {
    /** Sitios que el agente puede consultar. Por defecto, GitHub. */
    allowHosts?: string[];
    /** Límite por pago en EUR. Por defecto, 50. */
    perTxEur?: number;
    /** IBAN de confianza; solo los usa "payments-known". */
    knownIbans?: string[];
}

export const DEFAULT_HOSTS = ["api.github.com"];
export const DEFAULT_LIMIT_EUR = 50;
const APPROVAL_TIMEOUT_MS = 300_000;

export function isProfileId(value: string): value is ProfileId {
    return (PROFILE_IDS as readonly string[]).includes(value);
}

function validStrings(name: string, values: string[] | undefined): string[] | undefined {
    if (values === undefined) return undefined;
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string" || v.trim() === "")) {
        throw new Error(`${name} must be a list of non-empty strings.`);
    }
    return values.map((v) => v.trim());
}

function readRules(hosts: string[]): Rule[] {
    return hosts.map((host) => ({ effect: "allow", action: "read", tool: "http.request", host }));
}

export function buildMandate(profile: ProfileId, options: ProfileOptions = {}): Mandate {
    const hosts = validStrings("allowHosts", options.allowHosts) ?? DEFAULT_HOSTS;
    const knownIbans = validStrings("knownIbans", options.knownIbans) ?? [];
    const perTxEur = options.perTxEur ?? DEFAULT_LIMIT_EUR;
    if (typeof perTxEur !== "number" || !Number.isFinite(perTxEur) || perTxEur <= 0) {
        throw new Error("perTxEur must be a positive number.");
    }

    const base = { version: "1", userId: "me", default: "deny" as const };
    const tail = {
        approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
        rateLimitPerSecond: DEFAULT_RATE_LIMIT_PER_SECOND,
        maxPendingRequests: DEFAULT_MAX_PENDING_REQUESTS,
        killSwitch: false,
    };

    switch (profile) {
        case "read-only":
            return {
                ...base,
                allowHosts: hosts,
                denyActions: ["write", "send", "pay", "delete", "exec", "grant"],
                rules: readRules(hosts),
                ...tail,
            };
        case "payments-ask":
        case "payments-known":
            return {
                ...base,
                allowHosts: hosts,
                denyActions: ["delete", "exec", "grant"],
                ceilings: { perTxEur },
                rules: [...readRules(hosts), { effect: "allow", action: "pay", tool: "payment.transfer" }],
                // Con la lista vacía, cualquier pago pide aprobación.
                knownIbans: profile === "payments-known" ? knownIbans : [],
                ...tail,
            };
        case "blocked":
            return { ...base, denyActions: ["write", "send", "pay", "delete", "exec", "grant", "read"], rules: [], ...tail };
    }
}
