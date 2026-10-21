// Tipos base de Me Runtime: contrato del "portero de agentes".
// Ningún tipo aquí implica ejecución real: son descripciones puras de datos.

export type ActionClass =
    | "read"
    | "write"
    | "send"
    | "pay"
    | "delete"
    | "exec"
    | "grant";

export interface Effect {
    /** Descripción corta de lo que ocurriría, p.ej. "pay", "read". */
    kind: string;
    reversible: boolean;
    /** Alcance del efecto, p.ej. "account:demo" o "file:/tmp/x". Opcional. */
    scope?: string;
}

export interface Intent {
    agentId: string;
    action: ActionClass;
    tool: string;
    /** Host o URL objetivo de la acción, si aplica. */
    target?: string;
    /** Importe en euros, si la acción mueve dinero. */
    amountEur?: number;
    /** Parámetros específicos de la acción; p.ej. { iban, concept } en payment.transfer. */
    params?: Record<string, unknown>;
    effects: Effect[];
}

export interface Rule {
    /** Qué hacer si la regla coincide con el intent. */
    effect: "allow" | "confirm" | "deny";
    action?: ActionClass;
    tool?: string;
    /** Host contra el que se compara intent.target. */
    host?: string;
}

export interface Mandate {
    version: string;
    userId: string;
    default: "deny";
    timezone?: string;
    ceilings?: {
        perTxEur?: number;
        dailySpendEur?: number;
    };
    allowHosts?: string[];
    denyHosts?: string[];
    denyActions?: ActionClass[];
    quietHours?: {
        /** Hora de inicio en formato 24h, 0-23. */
        startHour: number;
        /** Hora de fin en formato 24h, 0-23. */
        endHour: number;
    };
    rules: Rule[];
    killSwitch?: boolean;
    /** IBAN conocidos; un pago a otro IBAN requiere aprobación (YELLOW). */
    knownIbans?: string[];
    /** Plazo (ms) para que un humano resuelva un pending YELLOW. Por defecto 300000 (5 min). */
    approvalTimeoutMs?: number;
    /** Nuevas solicitudes por segundo. Por defecto 20. */
    rateLimitPerSecond?: number;
    /** Solicitudes YELLOW simultáneamente pendientes. Por defecto 50. */
    maxPendingRequests?: number;
}

export type Verdict = "GREEN" | "YELLOW" | "RED";

export function hasAtMostTwoDecimalPlaces(value: number): boolean {
    if (!Number.isFinite(value)) return false;
    const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
    const fractionalDigits = coefficient.split(".")[1]?.length ?? 0;
    return fractionalDigits - Number(exponentText ?? 0) <= 2;
}

/** Validación estructural de un mandato; devuelve la lista de errores (vacía si es válido). */
export function validateMandate(value: unknown): string[] {
    const errors: string[] = [];
    if (!value || typeof value !== "object" || Array.isArray(value)) return ["mandate must be an object"];
    const m = value as Record<string, unknown>;
    const allowedKeys = new Set([
        "version", "userId", "default", "timezone", "ceilings", "allowHosts", "denyHosts", "denyActions",
        "quietHours", "rules", "killSwitch", "knownIbans", "approvalTimeoutMs", "rateLimitPerSecond", "maxPendingRequests",
    ]);
    for (const key of Object.keys(m)) if (!allowedKeys.has(key)) errors.push(`unknown mandate key: ${key}`);
    if (typeof m.version !== "string") errors.push("version must be a string");
    if (typeof m.userId !== "string") errors.push("userId must be a string");
    if (m.default !== "deny") errors.push('default must be "deny"');
    if (m.timezone !== undefined) {
        if (typeof m.timezone !== "string" || m.timezone.length === 0) errors.push("timezone must be a valid IANA timezone string");
        else {
            try {
                new Intl.DateTimeFormat("en-US", { timeZone: m.timezone });
            } catch {
                errors.push("timezone must be a valid IANA timezone string");
            }
        }
    }
    if (!Array.isArray(m.rules)) {
        errors.push("rules must be an array");
    } else {
        m.rules.forEach((rule, i) => {
            if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
                errors.push(`rules[${i}] must be an object`);
                return;
            }
            const r = rule as Record<string, unknown>;
            for (const key of Object.keys(r)) {
                if (!(["effect", "action", "tool", "host"] as string[]).includes(key)) errors.push(`unknown mandate key: rules[${i}].${key}`);
            }
            if (!(["allow", "confirm", "deny"] as unknown[]).includes(r.effect)) {
                errors.push(`rules[${i}].effect must be allow, confirm or deny`);
            }
            if (r.action !== undefined && !(["read", "write", "send", "pay", "delete", "exec", "grant"] as unknown[]).includes(r.action)) {
                errors.push(`rules[${i}].action must be a supported action class`);
            }
            if (r.tool !== undefined && typeof r.tool !== "string") errors.push(`rules[${i}].tool must be a string`);
            if (r.host !== undefined && typeof r.host !== "string") errors.push(`rules[${i}].host must be a string`);
        });
    }
    for (const key of ["allowHosts", "denyHosts", "denyActions", "knownIbans"]) {
        const list = m[key];
        if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== "string"))) {
            errors.push(`${key} must be an array of strings`);
        }
    }
    if (m.ceilings !== undefined) {
        const c = m.ceilings as Record<string, unknown> | null;
        if (!c || typeof c !== "object") errors.push("ceilings must be an object");
        else {
            for (const key of Object.keys(c)) if (key !== "perTxEur" && key !== "dailySpendEur") errors.push(`unknown mandate key: ceilings.${key}`);
            for (const key of ["perTxEur", "dailySpendEur"]) {
                if (c[key] !== undefined && (typeof c[key] !== "number" || !Number.isFinite(c[key]))) {
                    errors.push(`ceilings.${key} must be a finite number`);
                } else if (typeof c[key] === "number" && c[key] <= 0) {
                    errors.push(`ceilings.${key} must be greater than 0`);
                } else if (typeof c[key] === "number" && !hasAtMostTwoDecimalPlaces(c[key])) {
                    errors.push(`ceilings.${key} must have no more than two decimal places`);
                }
            }
        }
    }
    if (m.quietHours !== undefined) {
        const quiet = m.quietHours as Record<string, unknown> | null;
        if (!quiet || typeof quiet !== "object" || Array.isArray(quiet)) errors.push("quietHours must be an object");
        else {
            for (const key of Object.keys(quiet)) if (key !== "startHour" && key !== "endHour") errors.push(`unknown mandate key: quietHours.${key}`);
            for (const key of ["startHour", "endHour"]) {
                if (typeof quiet[key] !== "number" || !Number.isInteger(quiet[key]) || quiet[key] < 0 || quiet[key] > 23) {
                    errors.push(`quietHours.${key} must be an integer from 0 to 23`);
                }
            }
        }
    }
    const paymentEnabled = Array.isArray(m.rules) && m.rules.some((rule) => {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
        const candidate = rule as Record<string, unknown>;
        return candidate.action === "pay" && (candidate.effect === "allow" || candidate.effect === "confirm");
    });
    if (paymentEnabled) {
        const perTx = (m.ceilings as Record<string, unknown> | undefined)?.perTxEur;
        if (typeof perTx !== "number" || !Number.isFinite(perTx) || perTx <= 0) {
            errors.push("ceilings.perTxEur must be a positive finite number when payment rules are enabled");
        }
    }
    if (m.approvalTimeoutMs !== undefined && (typeof m.approvalTimeoutMs !== "number" || !Number.isFinite(m.approvalTimeoutMs) || !Number.isInteger(m.approvalTimeoutMs) || !(m.approvalTimeoutMs > 0))) {
        errors.push("approvalTimeoutMs must be a positive integer number of milliseconds");
    }
    for (const key of ["rateLimitPerSecond", "maxPendingRequests"] as const) {
        if (m[key] !== undefined && (typeof m[key] !== "number" || !Number.isSafeInteger(m[key]) || m[key] <= 0)) {
            errors.push(`${key} must be a positive integer`);
        }
    }
    if (m.killSwitch !== undefined && typeof m.killSwitch !== "boolean") errors.push("killSwitch must be a boolean");
    return errors;
}

export interface Decision {
    verdict: Verdict;
    reason: string;
}
