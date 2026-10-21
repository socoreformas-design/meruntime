// Interruptor de emergencia local: ~/.meruntime/kill.json
// Si el archivo falta, no se puede leer o no tiene un estado válido, se bloquea.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendAudit } from "./audit.js";
import { writeFileAtomic } from "./fsAtomic.js";
import { MERUNTIME_DIR } from "./paths.js";
import type { Mandate } from "../../schema/src/index.js";

export const KILL_PATH = join(MERUNTIME_DIR, "kill.json");
let killPathOverride: string | undefined;

export function setKillPathForTests(path: string | undefined): void {
    killPathOverride = path;
}

export function getKillPath(): string {
    return killPathOverride ?? KILL_PATH;
}

export interface KillSwitch {
    on: boolean;
}

export function readKillSwitch(): KillSwitch {
    try {
        const raw = readFileSync(killPathOverride ?? KILL_PATH, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as Partial<KillSwitch>).on !== "boolean") {
            return { on: true };
        }
        return { on: (parsed as KillSwitch).on };
    } catch {
        return { on: true };
    }
}

export function writeKillSwitch(on: boolean): void {
    writeFileAtomic(getKillPath(), JSON.stringify({ on }, null, 2), 0o600);
}

/** Cambia el kill switch y lo deja en la auditoría; `source` indica qué interfaz lo pidió. */
export function setKillSwitch(on: boolean, source?: string): void {
    writeKillSwitch(on);
    const state = on ? "on" : "off";
    appendAudit({
        event: on ? "kill-on" : "kill-off",
        request_id: null,
        agent: null,
        action: null,
        decision: on ? "kill-on" : "kill-off",
        reason: `kill switch ${state}${source ? ` (${source})` : ""}`,
    });
}

/** Fusiona el estado del kill switch en el mandato, ANTES de llamar a evaluate(). */
export function applyKillSwitch(mandate: Mandate): Mandate {
    if (readKillSwitch().on) {
        return { ...mandate, killSwitch: true };
    }
    return mandate;
}
