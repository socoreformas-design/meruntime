import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateMandate, type Intent, type Mandate, type Verdict } from "../../schema/src/index.js";
import { parseJsonWithUniqueKeys } from "../../schema/src/json.js";
import { evaluate } from "./evaluate.js";
import { applyKillSwitch } from "./kill.js";
import { MERUNTIME_DIR } from "./paths.js";

const DEFAULT_MANDATE_PATH = join(MERUNTIME_DIR, "mandate.json");
let mandatePathOverride: string | undefined;

export function setMandatePathForTests(path: string | undefined): void {
    mandatePathOverride = path;
}

export function getMandatePath(): string {
    return mandatePathOverride ?? process.env.MERUNTIME_MANDATE ?? DEFAULT_MANDATE_PATH;
}

export function loadCurrentMandate(): Mandate {
    const value = parseJsonWithUniqueKeys(readFileSync(getMandatePath(), "utf-8"));
    const errors = validateMandate(value);
    if (errors.length > 0) throw new Error(`Invalid mandate: ${errors.join("; ")}`);
    const mandate = value as Mandate;
    return applyKillSwitch(mandate);
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_RATE_LIMIT_PER_SECOND = 20;
export const DEFAULT_MAX_PENDING_REQUESTS = 50;

export function approvalTimeoutMs(mandate: Mandate): number {
    const value = mandate.approvalTimeoutMs;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_APPROVAL_TIMEOUT_MS;
}

export function evaluateCurrentPolicy(intent: Intent): Verdict {
    return evaluate(loadCurrentMandate(), intent, new Date());
}

export function evaluateForApproval(intent: Intent, alreadySpentTodayEur = 0, currentMandate?: Mandate): Verdict {
    const mandate = currentMandate ?? loadCurrentMandate();
    const approvalMandate: Mandate = {
        ...mandate,
        quietHours: undefined,
        // La persona aprobó este pago, incluido un beneficiario nuevo.
        knownIbans: undefined,
        rules: mandate.rules.map((rule) => rule.effect === "confirm" ? { ...rule, effect: "allow" } : rule),
    };
    return evaluate(approvalMandate, intent, new Date(), alreadySpentTodayEur);
}