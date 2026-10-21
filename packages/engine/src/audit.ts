// Auditoría append-only: una línea JSON por evento en .meruntime/audit.jsonl.
// Nunca se reescribe el archivo completo; solo se añade (o se crea si falta).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MERUNTIME_DIR } from "./paths.js";
import type { RequestStatus } from "./stateMachine.js";

export type AuditEventKind = "request" | "approve" | "deny" | "invalidate" | "expire" | "kill-on" | "kill-off" | "execute" | "transition";
export type AuditDecision =
    | "GREEN"
    | "YELLOW"
    | "RED"
    | "approved"
    | "denied"
    | "blocked"
    | "executed"
    | "invalidated"
    | "expired"
    | "kill-on"
    | "kill-off";

export interface AuditEntry {
    at: string;
    event: AuditEventKind;
    request_id: string | null;
    agent: string | null;
    action: string | null;
    decision: AuditDecision | RequestStatus;
    reason: string;
    /** Solo en eventos "transition". */
    from?: RequestStatus;
    to?: RequestStatus;
    actor?: string;
    rule?: string | null;
    /** sha256 de los parámetros de la solicitud; nunca los parámetros. */
    params_hash?: string;
}

let auditPathOverride: string | undefined;

function getAuditPath(): string {
    return auditPathOverride ?? join(MERUNTIME_DIR, "audit.jsonl");
}

export function redactAuditText(value: string): string {
    return value
        .replace(/([?&])(?:pendingHmacKey|[\w-]*(?:token|authorization|secret))[^=]*=[^&#]*/gi, "$1[REDACTED]")
        .replace(/\b(?:pendingHmacKey|[\w-]*(?:token|authorization|secret))\s*[=:]\s*(["']?)[^&\s"',}]*/gi, "[REDACTED]")
        .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
}

/** Solo para tests: redirige lectura/escritura a otro archivo (o restaura con undefined). */
export function setAuditPathForTests(path: string | undefined): void {
    auditPathOverride = path;
}

export function appendAudit(entry: Omit<AuditEntry, "at">): void {
    const line: AuditEntry = {
        at: new Date().toISOString(),
        event: entry.event,
        request_id: entry.request_id === null ? null : redactAuditText(entry.request_id),
        agent: entry.agent === null ? null : redactAuditText(entry.agent),
        action: entry.action === null ? null : redactAuditText(entry.action),
        decision: entry.decision,
        reason: redactAuditText(entry.reason),
    };
    if (entry.event === "transition") {
        line.from = entry.from;
        line.to = entry.to;
    }
    line.actor = entry.actor === undefined ? undefined : redactAuditText(entry.actor);
    line.rule = entry.rule;
    line.params_hash = entry.params_hash;
    try {
        const path = getAuditPath();
        const dir = dirname(path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(path, `${JSON.stringify(line)}\n`, "utf-8");
    } catch (err) {
        // La auditoría nunca debe bloquear el semáforo: se registra el fallo y se continúa.
        console.error("MERUNTIME_AUDIT_ERROR", err instanceof Error ? err.message : String(err));
    }
}

export function readAuditLines(limit?: number): AuditEntry[] {
    try {
        const raw = readFileSync(getAuditPath(), "utf-8");
        const lines = raw
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l) as AuditEntry);
        return limit !== undefined ? lines.slice(-limit) : lines;
    } catch {
        return [];
    }
}
