// Comprobaciones de instalación compartidas por `meruntime doctor` y la interfaz de escritorio.

import { existsSync, readFileSync, statSync } from "node:fs";
import type { Mandate } from "../../schema/src/index.js";
import { validateMandate } from "../../schema/src/index.js";
import { parseJsonWithUniqueKeys } from "../../schema/src/json.js";
import { getKillPath } from "./kill.js";
import { MERUNTIME_DIR } from "./paths.js";
import { getMandatePath } from "./policy.js";
import { getSecretsPath } from "./secrets.js";

export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
    level: CheckLevel;
    message: string;
}

export interface SetupReport {
    stateDir: string;
    checks: Check[];
    /** Nombres de los archivos de configuración que no existen (mandate.json, secrets.json, kill.json). */
    missing: string[];
    /** Estado del kill switch si kill.json es legible. */
    killOn?: boolean;
    /** El mandato, solo si existe y valida contra el schema. */
    mandate?: Mandate;
}

function readJson(path: string): { value?: unknown; error?: string } {
    try {
        return { value: parseJsonWithUniqueKeys(readFileSync(path, "utf-8")) };
    } catch (err) {
        return { error: err instanceof Error ? err.message : "unreadable" };
    }
}

export function checkSetup(): SetupReport {
    const checks: Check[] = [];
    const add = (level: CheckLevel, message: string) => checks.push({ level, message });
    const hint = "run `meruntime init`";
    const report: SetupReport = { stateDir: MERUNTIME_DIR, checks, missing: [] };

    const major = Number(process.versions.node.split(".")[0]);
    add(major >= 20 ? "ok" : "fail", `Node ${process.versions.node}${major >= 20 ? "" : " (Node >= 20 required)"}`);

    const mandatePath = getMandatePath();
    if (process.env.MERUNTIME_MANDATE) {
        add("warn", `MERUNTIME_MANDATE override active; mandate loaded from ${mandatePath}`);
    }
    if (!existsSync(mandatePath)) {
        report.missing.push("mandate.json");
        add("fail", `mandate.json not found at ${mandatePath} (${hint}); every request is denied without it`);
    } else {
        const { value, error } = readJson(mandatePath);
        if (error) {
            add("fail", `mandate.json is not valid JSON: ${error}`);
        } else {
            const errors = validateMandate(value);
            if (errors.length > 0) errors.forEach((e) => add("fail", `mandate.json schema: ${e}`));
            else {
                add("ok", `mandate.json is valid (${mandatePath})`);
                report.mandate = value as Mandate;
            }
        }
    }

    const secretsPath = getSecretsPath();
    if (!existsSync(secretsPath)) {
        report.missing.push("secrets.json");
        add("fail", `secrets.json not found at ${secretsPath} (${hint})`);
    } else {
        const { value, error } = readJson(secretsPath);
        if (error || !value || typeof value !== "object" || Array.isArray(value)) {
            add("fail", "secrets.json must contain a JSON object");
        } else {
            const secrets = value as Record<string, unknown>;
            if (typeof secrets.pendingHmacKey === "string" && /^[0-9a-f]{64}$/i.test(secrets.pendingHmacKey)) {
                add("ok", "secrets.json is valid and has an HMAC key");
            } else if (secrets.pendingHmacKey === undefined) {
                add("warn", "secrets.json has no pendingHmacKey; one is generated on first use");
            } else {
                add("fail", "secrets.json contains an invalid pendingHmacKey");
            }
            const missing = ["protectedToken", "githubToken"].filter((k) => typeof secrets[k] !== "string" || secrets[k] === "");
            if (missing.length > 0) add("warn", `empty tokens (optional): ${missing.join(", ")}`);
        }
        if (process.platform !== "win32" && (statSync(secretsPath).mode & 0o077) !== 0) {
            add("warn", "secrets.json is readable by other users; run chmod 600 on it");
        }
    }

    const killPath = getKillPath();
    if (!existsSync(killPath)) {
        report.missing.push("kill.json");
        add("fail", `kill.json not found at ${killPath} (${hint})`);
    } else {
        const { value, error } = readJson(killPath);
        const on = (value as { on?: unknown } | undefined)?.on;
        if (error || typeof on !== "boolean") {
            add("fail", "kill.json must be a JSON object like {\"on\": false}");
        } else {
            report.killOn = on;
            add(on ? "warn" : "ok", on ? "kill switch is ON: every request is denied" : "kill.json is valid (kill switch off)");
        }
    }
    return report;
}
