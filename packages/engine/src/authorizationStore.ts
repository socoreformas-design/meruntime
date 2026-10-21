import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionClass, Intent, Verdict } from "../../schema/src/index.js";
import { FileLockTimeoutError, withFileLock, writeFileAtomic } from "./fsAtomic.js";
import { RuntimeError } from "./errors.js";
import { MERUNTIME_DIR } from "./paths.js";
import { appendAudit } from "./audit.js";

export type AuthorizationStatus = "PENDING" | "AUTHORIZED" | "DENIED" | "EXPIRED";
export const AUTHORIZATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTHORIZATION_PATH = join(MERUNTIME_DIR, "authorizations.json");

export interface AuthorizationRecord {
    requestId: string;
    idempotencyKey: string;
    payloadHash: string;
    agentId: string;
    toolName: string;
    command: string;
    cwd: string;
    action: ActionClass;
    status: AuthorizationStatus;
    verdict: Verdict;
    rule: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string | null;
    intent: Intent;
    intentMac: string | null;
    transitions: Array<{ from: AuthorizationStatus | "RECEIVED"; to: AuthorizationStatus; actor: string; at: string; reason: string }>;
}

export interface AuthorizationTombstone {
    tombstone: true;
    requestId: string;
    idempotencyKey: string;
    payloadHash: string;
    status: Exclude<AuthorizationStatus, "PENDING">;
    verdict: Verdict;
    rule: string;
    createdAt: string;
    updatedAt: string;
}

export type StoredAuthorization = AuthorizationRecord | AuthorizationTombstone;
export function isAuthorizationTombstone(record: StoredAuthorization): record is AuthorizationTombstone {
    return "tombstone" in record && record.tombstone === true;
}

let pathOverride: string | undefined;
export function setAuthorizationPathForTests(path: string | undefined): void { pathOverride = path; }
export function getAuthorizationPath(): string { return pathOverride ?? AUTHORIZATION_PATH; }

export function readAuthorizations(): StoredAuthorization[] {
    const path = getAuthorizationPath();
    if (!existsSync(path)) return [];
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
        if (!Array.isArray(parsed)) throw new Error("not an array");
        return parsed as StoredAuthorization[];
    } catch {
        throw new RuntimeError("STORAGE_ERROR", "Authorization store is unreadable.");
    }
}

function compact(records: StoredAuthorization[], now = Date.now()): void {
    const cutoff = now - AUTHORIZATION_RETENTION_MS;
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (isAuthorizationTombstone(record) || record.status === "PENDING") continue;
        const updated = Date.parse(record.updatedAt);
        if (!Number.isFinite(updated) || updated >= cutoff) continue;
        records[index] = {
            tombstone: true,
            requestId: record.requestId,
            idempotencyKey: record.idempotencyKey,
            payloadHash: record.payloadHash,
            status: record.status,
            verdict: record.verdict,
            rule: record.rule,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        };
    }
}

/** Uses the shared PID lock and atomic replacement semantics used by requests.json. */
export function mutateAuthorizations<T>(fn: (records: StoredAuthorization[]) => T): T {
    const newTransitions: Array<{ record: AuthorizationRecord; entry: AuthorizationRecord["transitions"][number] }> = [];
    let result: T;
    try {
        result = withFileLock(`${getAuthorizationPath()}.lock`, () => {
            const records = readAuthorizations();
            const before = JSON.stringify(records);
            compact(records);
            const transitionCounts = new Map(records.map((record) => [record.requestId, isAuthorizationTombstone(record) ? 0 : record.transitions.length]));
            const result = fn(records);
            for (const record of records) {
                if (isAuthorizationTombstone(record) || record.status === "PENDING") continue;
                record.command = "";
                record.cwd = "";
                record.intentMac = null;
                record.intent.params = {};
                record.intent.effects = [];
            }
            if (JSON.stringify(records) !== before) {
                writeFileAtomic(getAuthorizationPath(), JSON.stringify(records, null, 2), 0o600);
                for (const record of records) {
                    if (isAuthorizationTombstone(record)) continue;
                    for (const entry of record.transitions.slice(transitionCounts.get(record.requestId) ?? 0)) {
                        newTransitions.push({ record: { ...record, transitions: record.transitions.map((transition) => ({ ...transition })) }, entry });
                    }
                }
            }
            return result;
        });
    } catch (error) {
        if (error instanceof RuntimeError) throw error;
        if (error instanceof FileLockTimeoutError) throw new RuntimeError("STORAGE_BUSY", "Authorization store is busy.");
        throw new RuntimeError("STORAGE_ERROR", "Authorization store write failed.");
    }
    for (const { record, entry } of newTransitions) {
        const initial = entry.from === "RECEIVED";
        const event = initial ? "request" : entry.to === "AUTHORIZED" ? "approve" : entry.to === "EXPIRED" ? "expire" : "deny";
        const decision = initial ? record.verdict : entry.to === "AUTHORIZED" ? "approved" : entry.to === "EXPIRED" ? "expired" : "denied";
        appendAudit({
            event,
            request_id: record.requestId,
            agent: record.agentId,
            action: record.action,
            decision,
            reason: entry.reason,
            actor: entry.actor,
            rule: record.rule,
            params_hash: record.payloadHash,
        });
    }
    return result;
}

export function countPendingAuthorizations(records: StoredAuthorization[] = readAuthorizations(), now = Date.now()): number {
    return records.filter((record) => !isAuthorizationTombstone(record)
        && record.status === "PENDING"
        && record.expiresAt !== null
        && Date.parse(record.expiresAt) > now).length;
}

export function countRecentAuthorizations(since: number, until: number): number {
    return readAuthorizations().filter((record) => {
        const created = Date.parse(record.createdAt);
        return Number.isFinite(created) && created > since && created <= until;
    }).length;
}
