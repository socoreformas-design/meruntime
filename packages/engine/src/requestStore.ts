// Libro de solicitudes: .meruntime/requests.json (array JSON, escritura atómica, lock entre procesos).
// Una solicitud es la unidad de verdad del ciclo de vida; cada transición se persiste y se audita.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Intent, Verdict } from "../../schema/src/index.js";
import { appendAudit } from "./audit.js";
import { RuntimeError, type ErrorShape } from "./errors.js";
import { FileLockTimeoutError, withFileLock, writeFileAtomic } from "./fsAtomic.js";
import { getPendingPath } from "./pendingStore.js";
import { isTerminal, TERMINAL_STATUSES, type RequestStatus, type TransitionRecord } from "./stateMachine.js";

export interface RequestResult {
    status?: number;
    data?: Record<string, string | number>;
    executedAt: string;
}

export interface RequestRecord {
    requestId: string;
    idempotencyKey: string;
    payloadHash: string;
    agent: string;
    action: string;
    status: RequestStatus;
    verdict: Verdict | null;
    rule: string | null;
    createdAt: string;
    updatedAt: string;
    expiresAt: string | null;
    transitions: TransitionRecord[];
    result: RequestResult | null;
    error: ErrorShape | null;
    /** Petición original saneada y firma HMAC del intent (solo YELLOW), para la reevaluación al aprobar. */
    method: string;
    url: string;
    body?: string;
    intent: Intent;
    intentMac: string | null;
    dailySpendDay?: string;
    dailySpendTimezone?: string;
    /** Petición HTTP original sin sanear y su firma; solo mientras la solicitud está viva. */
    replay?: { method: string; url: string; body?: string };
    replayMac?: string;
}

export type TerminalRequestStatus = typeof TERMINAL_STATUSES[number];

export interface RequestTombstone {
    tombstone: true;
    requestId: string;
    idempotencyKey: string;
    payloadHash: string;
    status: TerminalRequestStatus;
    verdict: Verdict | null;
    rule: string | null;
    createdAt: string;
    updatedAt: string;
}

export type StoredRequest = RequestRecord | RequestTombstone;

export function isRequestTombstone(record: StoredRequest): record is RequestTombstone {
    return "tombstone" in record && record.tombstone === true;
}

export const REQUEST_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let requestsPathOverride: string | undefined;

export function setRequestsPathForTests(path: string | undefined): void {
    requestsPathOverride = path;
}

/** Por defecto, junto a pending.json. */
export function getRequestsPath(): string {
    return requestsPathOverride ?? join(dirname(getPendingPath()), "requests.json");
}

export function readRequests(): StoredRequest[] {
    const path = getRequestsPath();
    if (!existsSync(path)) return [];
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
        if (!Array.isArray(parsed)) throw new Error("not an array");
        return parsed as StoredRequest[];
    } catch {
        // Un libro ilegible nunca se trata como vacío: se podría reejecutar lo ya ejecutado.
        throw new RuntimeError("STORAGE_ERROR", "Request store is unreadable.");
    }
}

export function cloneRecord<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function compactOldTerminalRequests(records: StoredRequest[], now = Date.now()): void {
    const cutoff = now - REQUEST_TOMBSTONE_RETENTION_MS;
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (isRequestTombstone(record) || !isTerminal(record.status)) continue;
        const updatedAt = Date.parse(record.updatedAt);
        if (!Number.isFinite(updatedAt) || updatedAt >= cutoff) continue;
        records[index] = {
            tombstone: true,
            requestId: record.requestId,
            idempotencyKey: record.idempotencyKey,
            payloadHash: record.payloadHash,
            status: record.status as TerminalRequestStatus,
            verdict: record.verdict,
            rule: record.rule,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        };
    }
}

/**
 * Lectura-modificación-escritura exclusiva. La escritura ocurre antes de que mutateRequests
 * devuelva, de modo que ningún adaptador se llama sin la transición persistida.
 */
export function mutateRequests<T>(fn: (records: StoredRequest[]) => T): T {
    const newTransitions: Array<{ record: RequestRecord; entry: TransitionRecord }> = [];
    let outcome: Outcome<T>;
    try {
        outcome = withFileLock(`${getRequestsPath()}.lock`, (): Outcome<T> => {
            const records = readRequests();
            const before = JSON.stringify(records);
            compactOldTerminalRequests(records);
            const counts = new Map(records.map((r) => [r.requestId, isRequestTombstone(r) ? 0 : r.transitions.length]));
            let result: Outcome<T>;
            try {
                result = { ok: true, value: fn(records) };
            } catch (error) {
                return { ok: false, error };
            }
            for (const record of records) {
                // La petición original (puede llevar credenciales) no sobrevive a la solicitud.
                if (!isRequestTombstone(record) && isTerminal(record.status)) {
                    delete record.replay;
                    delete record.replayMac;
                }
            }
            if (JSON.stringify(records) !== before) {
                writeFileAtomic(getRequestsPath(), JSON.stringify(records, null, 2));
                for (const record of records) {
                    if (isRequestTombstone(record)) continue;
                    for (const entry of record.transitions.slice(counts.get(record.requestId) ?? 0)) {
                        newTransitions.push({ record: cloneRecord(record), entry });
                    }
                }
            }
            return result;
        });
    } catch (error) {
        if (error instanceof RuntimeError) throw error;
        if (error instanceof FileLockTimeoutError) {
            throw new RuntimeError("STORAGE_BUSY", "storage.busy: request denied before execution.");
        }
        throw new RuntimeError("STORAGE_ERROR", "Request store write failed; nothing was executed.");
    }

    for (const { record, entry } of newTransitions) {
        appendAudit({
            event: "transition",
            request_id: record.requestId,
            agent: record.agent,
            action: record.action,
            decision: entry.to,
            reason: entry.reason,
            from: entry.from,
            to: entry.to,
            actor: entry.actor,
            rule: record.rule,
            params_hash: record.payloadHash,
        });
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
}
