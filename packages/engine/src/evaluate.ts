// Motor de evaluación de Me Runtime.
// evaluate() es una función pura: nada de red, disco ni llamadas a modelos.
// El semáforo lo decide este código, siguiendo un orden fijo de reglas.

import { hasAtMostTwoDecimalPlaces, type Intent, type Mandate, type Rule, type Verdict } from "../../schema/src/index.js";

export interface EvaluationExplanation {
    verdict: Verdict;
    reason: string;
    rule?: string;
}

function extractHost(target: string | undefined): string | undefined {
    if (!target) return undefined;
    try {
        return new URL(target).hostname;
    } catch {
        return target;
    }
}

function isQuietHour(hour: { startHour: number; endHour: number }, now: Date): boolean {
    const h = now.getHours();
    if (hour.startHour === hour.endHour) return false;
    if (hour.startHour < hour.endHour) {
        return h >= hour.startHour && h < hour.endHour;
    }
    // Rango que cruza medianoche, p.ej. 22 -> 6.
    return h >= hour.startHour || h < hour.endHour;
}

function normalizeIban(value: string): string {
    return value.replace(/\s+/g, "").toUpperCase();
}

function isKnownIban(known: string[], iban: unknown): boolean {
    return typeof iban === "string" && known.some((k) => normalizeIban(k) === normalizeIban(iban));
}

function ruleMatches(rule: Rule, intent: Intent, host: string | undefined): boolean {
    if (rule.action !== undefined && rule.action !== intent.action) return false;
    if (rule.tool !== undefined && rule.tool !== intent.tool) return false;
    if (rule.host !== undefined && rule.host !== host) return false;
    return true;
}

export function evaluate(mandate: Mandate, intent: Intent, now: Date, alreadySpentTodayEur = 0): Verdict {
    return explainEvaluate(mandate, intent, now, alreadySpentTodayEur).verdict;
}

function matchedRule(mandate: Mandate, intent: Intent, host: string | undefined, effect: Rule["effect"]): { rule: Rule; index: number } | undefined {
    const index = mandate.rules.findIndex((rule) => rule.effect === effect && ruleMatches(rule, intent, host));
    return index < 0 ? undefined : { rule: mandate.rules[index], index };
}

export function explainEvaluate(mandate: Mandate, intent: Intent, now: Date, alreadySpentTodayEur = 0): EvaluationExplanation {
    if (mandate.killSwitch) {
        return { verdict: "RED", reason: "Kill switch activo", rule: "killSwitch" };
    }

    if (!intent.action || !intent.tool || !intent.effects || intent.effects.length === 0) {
        return { verdict: "RED", reason: "Intent incompleto: falta acción, herramienta o efectos", rule: "intent-validation" };
    }

    const host = extractHost(intent.target);

    if (mandate.denyActions?.includes(intent.action)) {
        return { verdict: "RED", reason: `Acción ${intent.action} denegada por denyActions`, rule: "denyActions" };
    }
    if (host && mandate.denyHosts?.includes(host)) {
        return { verdict: "RED", reason: `Host ${host} denegado por denyHosts`, rule: "denyHosts" };
    }

    if (intent.amountEur !== undefined) {
        if (typeof intent.amountEur !== "number" || !Number.isFinite(intent.amountEur) || intent.amountEur <= 0 || !hasAtMostTwoDecimalPlaces(intent.amountEur)) {
            return { verdict: "RED", reason: "Importe inválido: usa un importe positivo con un máximo de dos decimales", rule: "intent.amountEur" };
        }
        const perTx = mandate.ceilings?.perTxEur;
        if (perTx !== undefined && intent.amountEur > perTx) {
            return { verdict: "RED", reason: `Supera perTxEur (${perTx} €)`, rule: "ceilings.perTxEur" };
        }
        const daily = mandate.ceilings?.dailySpendEur;
        const totalCents = Math.round(alreadySpentTodayEur * 100) + Math.round(intent.amountEur * 100);
        if (daily !== undefined && totalCents > Math.round(daily * 100)) {
            return { verdict: "RED", reason: `Supera dailySpendEur (${daily} €)`, rule: "ceilings.dailySpendEur" };
        }
    }

    if (mandate.quietHours && intent.action !== "read" && isQuietHour(mandate.quietHours, now)) {
        return { verdict: "YELLOW", reason: "Horario silencioso → requiere aprobación", rule: "quietHours" };
    }

    const deniedRule = matchedRule(mandate, intent, host, "deny");
    if (deniedRule) {
        return { verdict: "RED", reason: "Una regla coincidente deniega la acción", rule: `rules[${deniedRule.index}]` };
    }
    const confirmRule = matchedRule(mandate, intent, host, "confirm");
    if (confirmRule) {
        return { verdict: "YELLOW", reason: "Una regla coincidente requiere aprobación", rule: `rules[${confirmRule.index}]` };
    }
    const allowRule = matchedRule(mandate, intent, host, "allow");
    if (allowRule) {
        if (mandate.knownIbans !== undefined && intent.action === "pay" && !isKnownIban(mandate.knownIbans, intent.params?.iban)) {
            return { verdict: "YELLOW", reason: "IBAN desconocido → requiere aprobación", rule: "payees.unknownIban" };
        }
        return { verdict: "GREEN", reason: "Una regla coincidente permite la acción", rule: `rules[${allowRule.index}]` };
    }

    return { verdict: "RED", reason: "Ninguna regla aplica → denegado por defecto", rule: "default" };
}
