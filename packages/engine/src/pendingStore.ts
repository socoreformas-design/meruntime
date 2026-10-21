// Almacén local de solicitudes YELLOW pendientes de aprobación humana.
// Archivo: .meruntime/pending.json (array JSON). Sin red, sin DB externa.

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Intent } from "../../schema/src/index.js";
import { appendAudit } from "./audit.js";
import { withFileLock, writeFileAtomic } from "./fsAtomic.js";
import { MERUNTIME_DIR } from "./paths.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./policy.js";
import { readPendingHmacKey } from "./secrets.js";

export { MERUNTIME_DIR } from "./paths.js";
export const PENDING_PATH = join(MERUNTIME_DIR, "pending.json");
let pendingPathOverride: string | undefined;

export type PendingStatus = "pending" | "approved" | "denied" | "invalidated" | "expired";

export interface PendingExecution {
    success: boolean;
    executed_at: string;
    status?: number;
    detail?: string;
}

export interface PendingRecord {
    id: string;
    created_at: string;
    expiresAt: string;
    status: PendingStatus;
    agent: string;
    action: string;
    method: string;
    url: string;
    body?: string;
    fingerprint: string;
    intent: Intent;
    intentMac: string;
    decision: PendingStatus | null;
    decision_at: string | null;
    execution?: PendingExecution;
}

export class PendingNotFoundError extends Error { }
export class PendingNotActionableError extends Error {
    constructor(message: string, readonly status?: PendingStatus) {
        super(message);
    }
}
export class PendingInvalidatedError extends Error { }

export function getPendingPath(): string {
    return pendingPathOverride ?? PENDING_PATH;
}

export function setPendingPathForTests(path: string | undefined): void {
    pendingPathOverride = path;
}

function readAll(): PendingRecord[] {
    try {
        return JSON.parse(readFileSync(getPendingPath(), "utf-8")) as PendingRecord[];
    } catch {
        return [];
    }
}

function writeAll(records: PendingRecord[]): void {
    writeFileAtomic(getPendingPath(), JSON.stringify(records, null, 2));
}

/** Lectura-modificación-escritura exclusiva entre procesos; solo escribe si fn cambió algo. */
export function mutatePending<T>(fn: (records: PendingRecord[]) => T): T {
    return withFileLock(`${getPendingPath()}.lock`, () => {
        const records = readAll();
        const before = JSON.stringify(records);
        const result = fn(records);
        if (JSON.stringify(records) !== before) writeAll(records);
        return result;
    });
}

export function isOverdue(record: Pick<PendingRecord, "expiresAt">, now = Date.now()): boolean {
    const expires = Date.parse(record.expiresAt);
    return Number.isFinite(expires) && now >= expires;
}

/** Pasa a EXPIRED sin persistir ni auditar; el llamador está dentro de mutatePending. */
export function markExpired(record: PendingRecord): void {
    record.status = "expired";
    record.decision = "expired";
    record.decision_at = new Date().toISOString();
}

export function auditExpired(record: PendingRecord): void {
    appendAudit({
        event: "expire",
        request_id: record.id,
        agent: record.agent,
        action: record.action,
        decision: "expired",
        reason: "approval timeout elapsed; action not executed",
    });
}

/** Expira de forma atómica un pending vencido (o cualquiera si force) y devuelve el estado observado. */
export function expirePendingIfDue(id: string, options: { force?: boolean } = {}): PendingRecord | undefined {
    const { record, expired } = mutatePending((records) => {
        const found = records.find((r) => r.id === id);
        if (found && found.status === "pending" && (options.force || isOverdue(found))) {
            markExpired(found);
            return { record: { ...found }, expired: true };
        }
        return { record: found && { ...found }, expired: false };
    });
    if (expired && record) auditExpired(record);
    return record;
}

export function generateId(): string {
    return `mr_${randomBytes(6).toString("hex")}`;
}

function fingerprint(method: string, url: string, body: string | undefined): string {
    return createHash("sha256").update(`${method.toUpperCase()}\0${url}\0${body ?? ""}`).digest("hex");
}

export function canonicalIntent(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalIntent).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalIntent(item)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

export function createIntentMac(intent: Intent, id: string, agent: string, action: string, expiresAt: string): string {
    const payload = `${canonicalIntent(intent)}|${id}|${agent}|${action}|${expiresAt}`;
    return createHmac("sha256", readPendingHmacKey()).update(payload).digest("hex");
}

export function pendingIntentMacMatches(record: Pick<PendingRecord, "intent" | "intentMac" | "id" | "agent" | "action" | "expiresAt">): boolean {
    if (typeof record.intentMac !== "string" || !/^[0-9a-f]{64}$/i.test(record.intentMac)) return false;
    try {
        const expected = Buffer.from(createIntentMac(record.intent, record.id, record.agent, record.action, record.expiresAt), "hex");
        const actual = Buffer.from(record.intentMac, "hex");
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

export function redactText(value: string): string {
    return value
        .replace(/([?&])(?:pendingHmacKey|[\w-]*(?:token|authorization|secret))[^=]*=[^&#]*/gi, "$1[REDACTED]")
        .replace(/\b(?:pendingHmacKey|[\w-]*(?:token|authorization|secret))\s*[=:]\s*(["']?)[^&\s"',}]*/gi, "[REDACTED]")
        .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
}

export function redactValue(value: unknown): unknown {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                return JSON.stringify(redactValue(JSON.parse(value)));
            } catch {
                return redactText(value);
            }
        }
        return redactText(value);
    }
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).filter(([key]) => !/(token|authorization|secret|pendingHmacKey)/i.test(key)).map(([key, item]) => [key, redactValue(item)])
        );
    }
    return value;
}

export function markPath(id: string): string {
    return join(MERUNTIME_DIR, `mark-${id}.txt`);
}

export function createPending(input: {
    agent: string;
    action: string;
    method: string;
    url: string;
    body?: string;
    intent: Intent;
    timeoutMs?: number;
}): PendingRecord {
    const requestFingerprint = fingerprint(input.method, input.url, input.body);
    const safeIntent = redactValue(input.intent) as Intent;
    const { record, expiredNow } = mutatePending((records) => {
        const nowMs = Date.now();
        const expiredNow: PendingRecord[] = [];
        for (const r of records) {
            if (r.status === "pending" && isOverdue(r, nowMs)) {
                markExpired(r);
                expiredNow.push({ ...r });
            }
        }
        const existing = records.find((r) => {
            const recordFingerprint = r.fingerprint ?? fingerprint(r.method, r.url, r.body);
            return recordFingerprint === requestFingerprint &&
                (r.status === "pending" || (r.status === "approved" && r.execution?.success === true));
        });
        if (existing) return { record: { ...existing }, expiredNow };

        const id = generateId();
        const expiresAt = new Date(nowMs + (input.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS)).toISOString();
        const created: PendingRecord = {
            id,
            created_at: new Date(nowMs).toISOString(),
            expiresAt,
            status: "pending",
            agent: input.agent,
            action: input.action,
            method: input.method,
            url: redactText(input.url),
            body: input.body === undefined ? undefined : String(redactValue(input.body)),
            fingerprint: requestFingerprint,
            intent: safeIntent,
            intentMac: createIntentMac(safeIntent, id, input.agent, input.action, expiresAt),
            decision: null,
            decision_at: null,
        };
        records.push(created);
        return { record: { ...created }, expiredNow };
    });
    for (const r of expiredNow) auditExpired(r);
    return record;
}

export function listPending(): PendingRecord[] {
    return readAll().filter((r) => r.status === "pending" && !isOverdue(r));
}

export function findById(id: string): PendingRecord | undefined {
    return readAll().find((r) => r.id === id);
}

export function readPendingForCore(): PendingRecord[] {
    return readAll();
}

export function writePendingForCore(records: PendingRecord[]): void {
    writeAll(records);
}

export function denyPending(id: string): PendingRecord {
    const outcome = mutatePending((records) => {
        const record = records.find((r) => r.id === id);
        if (!record) throw new PendingNotFoundError(`Request ${id} not found.`);
        if (record.status === "pending" && isOverdue(record)) {
            markExpired(record);
            return { expired: { ...record } };
        }
        if (record.status !== "pending") {
            throw new PendingNotActionableError(`Request ${id} is not pending (status=${record.status}).`, record.status);
        }
        record.status = "denied";
        record.decision = "denied";
        record.decision_at = new Date().toISOString();
        return { denied: { ...record } };
    });
    if (outcome.expired) {
        auditExpired(outcome.expired);
        throw new PendingNotActionableError(`Request ${id} is not pending (status=expired).`, "expired");
    }
    return outcome.denied!;
}

/** Solo para tests: limpia pending.json y las marcas generadas en .meruntime/. */
export function resetPendingStoreForTests(): void {
    if (existsSync(getPendingPath())) unlinkSync(getPendingPath());
    if (existsSync(MERUNTIME_DIR)) {
        for (const f of readdirSync(MERUNTIME_DIR)) {
            if (f.startsWith("mark-")) unlinkSync(join(MERUNTIME_DIR, f));
        }
    }
}
