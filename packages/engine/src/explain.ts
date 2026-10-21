// Traduce el veredicto y la regla del motor a frases que una persona entiende (es/en). Solo texto.

export type Lang = "en" | "es";
export type Localized = Record<Lang, string>;

export interface ExplainContext {
    perTxEur?: number;
}

export interface ActionSummary {
    agent: string;
    tool: string;
    amountEur?: number;
    params?: Record<string, unknown>;
    method: string;
    url: string;
}

function money(amount: number, lang: Lang): string {
    const fixed = amount.toFixed(2);
    return lang === "es" ? `${fixed.replace(".", ",")} €` : `€${fixed}`;
}

/** Frase corta de lo que el agente quiere hacer. */
export function describeAction(action: ActionSummary): Localized {
    if (action.tool === "payment.transfer" && typeof action.amountEur === "number") {
        const iban = typeof action.params?.iban === "string" ? action.params.iban : "?";
        return {
            en: `"${action.agent}" wants to pay ${money(action.amountEur, "en")} to ${iban}`,
            es: `«${action.agent}» quiere pagar ${money(action.amountEur, "es")} a ${iban}`,
        };
    }
    return {
        en: `"${action.agent}" wants to run ${action.method} ${action.url}`,
        es: `«${action.agent}» quiere ejecutar ${action.method} ${action.url}`,
    };
}

/** Por qué se decidió así. `rule` es el identificador que da explainEvaluate (o el runtime). */
export function explainRule(rule: string | null, verdict: "GREEN" | "YELLOW" | "RED", context: ExplainContext = {}): Localized {
    const limit = context.perTxEur;
    switch (rule) {
        case "payees.unknownIban":
            return { en: "It is an IBAN that is not in your trusted list.", es: "Es un IBAN que no está en tu lista de confianza." };
        case "ceilings.perTxEur":
            return limit === undefined
                ? { en: "It is above the per-payment limit you set.", es: "Supera el límite por pago que fijaste." }
                : { en: `It is above the ${money(limit, "en")} per-payment limit you set.`, es: `Supera el límite de ${money(limit, "es")} por pago que fijaste.` };
        case "ceilings.dailySpendEur":
            return { en: "It is above the daily spending limit you set.", es: "Supera el límite de gasto diario que fijaste." };
        case "killSwitch":
            return { en: "The Kill Switch is on, so everything is blocked.", es: "El Kill Switch está activado, así que todo se bloquea." };
        case "allowHosts":
            return { en: "That site is not in your list of allowed sites.", es: "Ese sitio no está en tu lista de sitios permitidos." };
        case "denyActions":
            return { en: "You have forbidden this kind of action.", es: "Has prohibido este tipo de acción." };
        case "denyHosts":
            return { en: "That site is on your blocked list.", es: "Ese sitio está en tu lista de bloqueados." };
        case "quietHours":
            return { en: "It is outside your allowed hours, so it needs your approval.", es: "Está fuera de tu horario permitido, así que necesita tu aprobación." };
        case "intent-validation":
            return { en: "The request is incomplete, so it is blocked.", es: "La solicitud está incompleta, así que se bloquea." };
        case "intent.amountEur":
            return { en: "The amount must be positive and have no more than two decimal places.", es: "El importe debe ser positivo y tener como máximo dos decimales." };
        case "mandate-unavailable":
            return { en: "Your rules could not be read, so everything is blocked.", es: "No se pudieron leer tus reglas, así que todo se bloquea." };
        case "default":
            return { en: "None of your rules allows this, so it is blocked.", es: "Ninguna de tus reglas lo permite, así que se bloquea." };
        default:
            break;
    }
    if (rule !== null && /^rules\[\d+\]$/.test(rule)) {
        if (verdict === "YELLOW") return { en: "One of your rules asks for your approval for this.", es: "Una de tus reglas pide tu aprobación para esto." };
        if (verdict === "GREEN") return { en: "One of your rules allows this.", es: "Una de tus reglas lo permite." };
        return { en: "One of your rules forbids this.", es: "Una de tus reglas lo prohíbe." };
    }
    const id = rule ?? "unknown";
    return { en: `Decided by rule "${id}".`, es: `Decidido por la regla «${id}».` };
}
