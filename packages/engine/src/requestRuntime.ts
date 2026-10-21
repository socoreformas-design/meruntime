// Runtime de solicitudes: evaluación, idempotencia, aprobación, ejecución y espera.
// Todas las transiciones pasan por transition() y se persisten antes de actuar.

import { createHash, randomBytes } from "node:crypto";
import { withAdmissionLock } from "./admission.js";
import { countPendingAuthorizations, countRecentAuthorizations } from "./authorizationStore.js";
import type { ActionClass, Intent, Mandate, Verdict } from "../../schema/src/index.js";
import { adapterFor, type Adapter, type HttpRequest } from "./adapters.js";
import { isCoreManagedIntent } from "./coreExecutor.js";
import { RuntimeError, type ErrorShape } from "./errors.js";
import { explainEvaluate } from "./evaluate.js";
import { canonicalIntent, createIntentMac, generateId, pendingIntentMacMatches, redactText, redactValue } from "./pendingStore.js";
import { appendAudit, readAuditLines } from "./audit.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_MAX_PENDING_REQUESTS, DEFAULT_RATE_LIMIT_PER_SECOND, approvalTimeoutMs, evaluateForApproval, loadCurrentMandate } from "./policy.js";
import { createReplayMac, replayMacMatches } from "./replayMac.js";
import { cloneRecord, isRequestTombstone, mutateRequests, readRequests, type RequestRecord, type RequestResult, type RequestTombstone, type StoredRequest } from "./requestStore.js";
import { isTerminal, transition, type RequestStatus, type TransitionRecord } from "./stateMachine.js";

export const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const STALE_EXECUTION_GRACE_MS = 5_000;
const MAX_KEY_LENGTH = 256;
const ACTIONS: readonly ActionClass[] = ["read", "write", "send", "pay", "delete", "exec", "grant"];

export type { Adapter } from "./adapters.js";

/** Vista pública: sin intent, firma ni credenciales. */
export interface RequestView {
    requestId: string;
    idempotencyKey: string;
    payloadHash: string;
    status: RequestStatus;
    verdict: Verdict | null;
    rule: string | null;
    createdAt: string;
    updatedAt: string;
    expiresAt: string | null;
    transitions: TransitionRecord[];
    result: RequestResult | null;
    error: ErrorShape | null;
    /** Cuerpo de la respuesta HTTP: solo en la llamada en vivo que ejecutó; nunca se guarda. */
    output?: string;
}
export interface RuntimeOptions {/** Con YELLOW, esperar la decisión (por defecto true). */
    wait?: boolean;
    approvalTimeoutMs?: number;
    executionTimeoutMs?: number;
    pollMs?: number;
    adapter?: Adapter;
    onPending?: (view: RequestView) => void;
}

export interface SubmitInput {
    intent: Intent;
    request?: { method: string; url: string; body?: string };
    idempotencyKey?: string;
}

function toView(record: StoredRequest): RequestView {
    if (isRequestTombstone(record)) {
        return {
            requestId: record.requestId,
            idempotencyKey: record.idempotencyKey,
            payloadHash: record.payloadHash,
            status: record.status,
            verdict: record.verdict,
            rule: record.rule,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            expiresAt: null,
            transitions: [],
            result: null,
            error: null,
        };
    }
    return {
        requestId: record.requestId,
        idempotencyKey: record.idempotencyKey,
        payloadHash: record.payloadHash,
        status: record.status,
        verdict: record.verdict,
        rule: record.rule,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        expiresAt: record.expiresAt,
        transitions: cloneRecord(record.transitions),
        result: record.result,
        error: record.error,
    };
}

type PreExecutionDenialRule = "storage.busy" | "storage.error" | "rateLimit.exceeded";
type PreExecutionDenialCode = "STORAGE_BUSY" | "STORAGE_ERROR" | "POLICY_DENY";

function preExecutionDeniedView(input: {
    intent: Intent;
    idempotencyKey: string;
    payloadHash: string;
    rule: PreExecutionDenialRule;
    code: PreExecutionDenialCode;
}): RequestView {
    const now = new Date().toISOString();
    const requestId = generateId();
    const reason = input.rule;
    return {
        requestId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: input.payloadHash,
        status: "DENIED",
        verdict: "RED",
        rule: input.rule,
        createdAt: now,
        updatedAt: now,
        expiresAt: null,
        transitions: [{ from: "EVALUATING", to: "DENIED", actor: "runtime", at: now, reason }],
        result: null,
        error: new RuntimeError(
            input.code,
            input.code === "POLICY_DENY" ? `Denied by policy: ${reason}.` : `Request denied before execution: ${reason}.`,
            requestId,
            "DENIED",
        ).toShape(),
    };
}

function auditPreExecutionDenial(view: RequestView, intent: Intent): void {
    appendAudit({
        event: "request", request_id: view.requestId, agent: intent.agentId, action: intent.action,
        decision: "RED", reason: view.rule ?? "storage.error",
    });
    appendAudit({
        event: "transition", request_id: view.requestId, agent: intent.agentId, action: intent.action,
        decision: "DENIED", reason: view.rule ?? "storage.error", from: "EVALUATING", to: "DENIED",
        actor: "runtime", rule: view.rule, params_hash: view.payloadHash,
    });
}

function errorShape(code: ErrorShape["code"], message: string, requestId: string): ErrorShape {
    return new RuntimeError(code, message, requestId).toShape();
}

function isOverdue(record: RequestRecord, now = Date.now()): boolean {
    return record.expiresAt !== null && now >= Date.parse(record.expiresAt);
}

function expireRecord(record: RequestRecord): void {
    transition(record, "EXPIRED", { actor: "system", reason: "approval timeout elapsed; action not executed" });
    record.error = errorShape("APPROVAL_TIMEOUT", "Approval timed out; the action was not executed.", record.requestId);
}

function sweepExpired(records: StoredRequest[]): void {
    const now = Date.now();
    for (const record of records) {
        if (!isRequestTombstone(record) && record.status === "PENDING" && isOverdue(record, now)) expireRecord(record);
    }
}

const STORAGE_WRITE_FAILED_AFTER_EXECUTION = "storage.writeFailedAfterExecution";

function recoverStorageWriteFailure(record: StoredRequest): void {
    if (isRequestTombstone(record) || record.status !== "EXECUTING") return;
    const wasAudited = readAuditLines().some((entry) =>
        entry.event === "execute" && entry.request_id === record.requestId && entry.reason === STORAGE_WRITE_FAILED_AFTER_EXECUTION);
    if (!wasAudited) return;
    transition(record, "UNKNOWN", { actor: "system", reason: STORAGE_WRITE_FAILED_AFTER_EXECUTION });
    record.error = errorShape(
        "EXECUTION_UNKNOWN",
        "The action may have executed, but its final result could not be saved. Do not retry automatically.",
        record.requestId,
    );
}

function findRecord(records: StoredRequest[], requestId: string): StoredRequest {
    const record = records.find((r) => r.requestId === requestId);
    if (!record) throw new RuntimeError("REQUEST_NOT_FOUND", `Request ${requestId} not found.`, requestId);
    return record;
}

function denyRecord(record: RequestRecord, actor: string, reason: string, message: string): void {
    transition(record, "DENIED", { actor, reason });
    record.error = errorShape("POLICY_DENY", message, record.requestId);
}

function localDayKey(value: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
}

interface DailySpendPeriod {
    day: string;
    timeZone: string;
    spentEur: number;
}

function executionStartedAt(record: RequestRecord): string | undefined {
    return record.transitions.findLast((entry) => entry.to === "EXECUTING")?.at
        ?? (record.status === "EXECUTED" ? record.result?.executedAt : undefined);
}

function isSpendCommitted(record: StoredRequest): record is RequestRecord {
    return !isRequestTombstone(record) && record.action === "pay" && (record.status === "EXECUTED" || record.status === "EXECUTING" || record.status === "UNKNOWN");
}

function dailySpendPeriod(records: readonly StoredRequest[], now: Date, requestedTimezone: string): DailySpendPeriod {
    const committed = records.filter(isSpendCommitted);
    const latest = committed
        .filter((record) => record.dailySpendDay && record.dailySpendTimezone)
        .sort((left, right) => Date.parse(executionStartedAt(right) ?? right.createdAt) - Date.parse(executionStartedAt(left) ?? left.createdAt))[0];
    const pinnedTimezone = latest?.dailySpendTimezone;
    const pinnedDay = latest?.dailySpendDay;
    const timeZone = pinnedTimezone && pinnedDay && localDayKey(now, pinnedTimezone) === pinnedDay
        ? pinnedTimezone
        : requestedTimezone;
    const day = localDayKey(now, timeZone);
    let spentCents = 0;
    for (const record of committed) {
        if (typeof record.intent?.amountEur !== "number" || !Number.isFinite(record.intent.amountEur)) continue;
        const startedAt = executionStartedAt(record);
        if (!startedAt) continue;
        const date = new Date(startedAt);
        if (!Number.isFinite(date.getTime())) continue;
        const recordDay = record.dailySpendDay ?? localDayKey(date, timeZone);
        const recordTimezone = record.dailySpendTimezone ?? timeZone;
        if (recordDay !== day || recordTimezone !== timeZone) continue;

        const amountCents = Math.max(0, Math.round(record.intent.amountEur * 100));
        spentCents = Math.min(Number.MAX_SAFE_INTEGER, spentCents + amountCents);
    }
    return { day, timeZone, spentEur: spentCents / 100 };
}

export function dailySpendToday(records: readonly StoredRequest[], now: Date, timeZone = "UTC"): number {
    return dailySpendPeriod(records, now, timeZone).spentEur;
}

export function computePayloadHash(intent: Intent, request: { method: string; url: string; body?: string }): string {
    return createHash("sha256")
        .update(`${canonicalIntent(intent)}\0${request.method.toUpperCase()}\0${request.url}\0${request.body ?? ""}`)
        .digest("hex");
}

function validate(input: SubmitInput, options: RuntimeOptions): void {
    const { intent, idempotencyKey } = input;
    if (!intent || typeof intent !== "object" || typeof intent.agentId !== "string" || typeof intent.tool !== "string") {
        throw new RuntimeError("INVALID_REQUEST", "Intent must include agentId and tool.");
    }
    if (!ACTIONS.includes(intent.action)) {
        throw new RuntimeError("INVALID_ACTION", "Intent action is not a supported action class.");
    }
    if (!options.adapter && !adapterFor(intent)) {
        throw new RuntimeError("INVALID_ACTION", `No adapter is registered for tool ${intent.tool}.`);
    }
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > MAX_KEY_LENGTH)) {
        throw new RuntimeError("INVALID_REQUEST", `idempotencyKey must be a string of 1-${MAX_KEY_LENGTH} characters.`);
    }
}

export async function submitRequest(input: SubmitInput, options: RuntimeOptions = {}): Promise<RequestView> {
    validate(input, options);
    const { intent } = input;
    const request = input.request ?? { method: intent.action === "read" ? "GET" : "POST", url: intent.target ?? "" };
    const payloadHash = computePayloadHash(intent, request);
    // Las lecturas no se deduplican por payload: repetir un GET debe volver a ejecutarlo.
    const idempotencyKey = input.idempotencyKey ?? (intent.action === "read" ? `read:${randomBytes(8).toString("hex")}` : payloadHash);

    type AdmissionResult =
        | { kind: "stored"; record: RequestRecord; isNew: true }
        | { kind: "stored"; record: RequestTombstone; isNew: false }
        | { kind: "denied"; view: RequestView };
    let created: AdmissionResult;
    try {
        created = withAdmissionLock(() => mutateRequests((records): AdmissionResult => {
            sweepExpired(records);
            const existing = records.find((r) => r.idempotencyKey === idempotencyKey);
            if (existing) {
                if (existing.payloadHash !== payloadHash) {
                    throw new RuntimeError("IDEMPOTENCY_KEY_REUSED", "idempotencyKey was already used with a different payload.", existing.requestId);
                }
                recoverStorageWriteFailure(existing);
                return { kind: "stored", record: cloneRecord(existing), isNew: false };
            }

            const now = new Date();
            let mandate: Mandate | undefined;
            try { mandate = loadCurrentMandate(); } catch { /* policy failure is recorded as RED below */ }
            if (mandate) {
                const nowMs = now.getTime();
                const windowStart = nowMs - 1_000;
                const recentRequests = records.filter((record) => {
                    const createdAt = Date.parse(record.createdAt);
                    return Number.isFinite(createdAt) && createdAt > windowStart && createdAt <= nowMs;
                }).length + countRecentAuthorizations(windowStart, nowMs);
                const rateLimit = mandate.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT_PER_SECOND;
                if (recentRequests >= rateLimit) {
                    return {
                        kind: "denied",
                        view: preExecutionDeniedView({ intent, idempotencyKey, payloadHash, rule: "rateLimit.exceeded", code: "POLICY_DENY" }),
                    };
                }
            }

            const requestId = generateId();
            const safeIntent = redactValue(intent) as Intent;
            const record: RequestRecord = {
                requestId,
                idempotencyKey,
                payloadHash,
                agent: intent.agentId,
                action: intent.action,
                status: "RECEIVED",
                verdict: null,
                rule: null,
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
                expiresAt: null,
                transitions: [],
                result: null,
                error: null,
                method: request.method.toUpperCase(),
                url: redactText(request.url),
                body: request.body === undefined ? undefined : String(redactValue(request.body)),
                intent: safeIntent,
                intentMac: null,
            };
            records.push(record);
            transition(record, "EVALUATING", { actor: "runtime", reason: "request received" }, now);

            let verdict: Verdict;
            let rule: string;
            let reason: string;
            let timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS;
            let spendPeriod: DailySpendPeriod | undefined;
            try {
                if (!mandate) throw new Error("mandate unavailable");
                if (intent.action === "pay") spendPeriod = dailySpendPeriod(records, now, mandate.timezone ?? "UTC");
                const explanation = explainEvaluate(mandate, intent, now, spendPeriod?.spentEur ?? 0);
                verdict = explanation.verdict;
                rule = explanation.rule ?? "unknown";
                reason = explanation.reason;
                timeoutMs = options.approvalTimeoutMs ?? approvalTimeoutMs(mandate);
                // Un GREEN todavía debe pasar las precondiciones del adaptador (p.ej. allowHosts).
                const guardDenial = verdict === "GREEN" && !options.adapter ? adapterFor(intent)?.guard?.(intent, mandate, request) : undefined;
                if (guardDenial) {
                    verdict = "RED";
                    rule = "allowHosts";
                    reason = guardDenial;
                }
            } catch {
                verdict = "RED";
                rule = "mandate-unavailable";
                reason = "Mandato no disponible → denegado";
            }
            if (verdict === "YELLOW") {
                const pendingLimit = mandate?.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
                const pendingCount = records.filter((item) => item.status === "PENDING").length + countPendingAuthorizations();
                if (pendingCount >= pendingLimit) {
                    verdict = "RED";
                    rule = "pending.limitReached";
                    reason = "Maximum number of pending requests reached";
                }
            }
            record.verdict = verdict;
            record.rule = rule;

            if (verdict === "GREEN") {
                if (intent.action === "pay" && spendPeriod) {
                    record.dailySpendDay = spendPeriod.day;
                    record.dailySpendTimezone = spendPeriod.timeZone;
                }
                transition(record, "EXECUTING", { actor: "runtime", reason: `policy GREEN (${rule})` }, now);
            } else if (verdict === "YELLOW") {
                record.expiresAt = new Date(now.getTime() + timeoutMs).toISOString();
                record.intentMac = createIntentMac(safeIntent, requestId, record.agent, record.action, record.expiresAt);
                if (needsReplay(intent)) {
                    record.replay = { method: request.method.toUpperCase(), url: request.url, body: request.body };
                    record.replayMac = createReplayMac(requestId, record.replay, record.expiresAt);
                }
                transition(record, "PENDING", { actor: "runtime", reason: `policy YELLOW (${rule})` }, now);
            } else {
                denyRecord(record, "runtime", `policy RED (${rule})`, `Denied by policy: ${reason}`);
            }
            return { kind: "stored", record: cloneRecord(record), isNew: true };
        }));
    } catch (error) {
        if (!(error instanceof RuntimeError) || !["STORAGE_BUSY", "STORAGE_ERROR"].includes(error.code)) throw error;
        const rule = error.code === "STORAGE_BUSY" ? "storage.busy" : "storage.error";
        const denied = preExecutionDeniedView({ intent, idempotencyKey, payloadHash, rule, code: error.code });
        auditPreExecutionDenial(denied, intent);
        return denied;
    }

    if (created.kind === "denied") {
        auditPreExecutionDenial(created.view, intent);
        return created.view;
    }
    if (created.kind === "stored" && !created.isNew) return toView(created.record);
    const record = created.record;
    let spendPeriod: DailySpendPeriod | undefined;

    appendAudit({
        event: "request",
        request_id: record.requestId,
        agent: record.agent,
        action: record.action,
        decision: record.verdict ?? "RED",
        reason: `policy verdict ${record.verdict}`,
    });

    if (record.status === "EXECUTING") return runExecution(record.requestId, intent, options, request, record);
    if (record.status !== "PENDING") return toView(record);

    options.onPending?.(toView(record));
    if (options.wait === false) return toView(record);
    return waitForRequest(record.requestId, options);
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ timedOut: true }), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve({ timedOut: false, value }); },
            (error) => { clearTimeout(timer); reject(error); },
        );
    });
}

/** Solo las peticiones HTTP no administradas por el CORE se reejecutan desde la petición original. */
function needsReplay(intent: Intent): boolean {
    return intent.tool === "http.request" && !isCoreManagedIntent(intent);
}

/** Llama al adaptador (la solicitud ya está persistida como EXECUTING) y registra el desenlace. */
async function runExecution(requestId: string, intent: Intent, options: RuntimeOptions, request: HttpRequest | undefined, initialRecord: RequestRecord): Promise<RequestView> {
    const adapter: Adapter = options.adapter ?? adapterFor(intent)?.execute ?? (async () => { throw new Error(`No adapter is registered for tool ${intent.tool}.`); });
    const timeoutMs = options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    const controller = new AbortController();

    let to: "EXECUTED" | "FAILED" | "UNKNOWN";
    let reason: string;
    let result: RequestResult | null = null;
    let error: ErrorShape | null = null;
    let output: string | undefined;
    try {
        const outcome = await raceTimeout(Promise.resolve().then(() => adapter(intent, requestId, { request, signal: controller.signal })), timeoutMs);
        if (outcome.timedOut) {
            controller.abort();
            to = "UNKNOWN";
            reason = `adapter did not respond within ${timeoutMs} ms`;
            error = errorShape("EXECUTION_TIMEOUT", `Execution timed out after ${timeoutMs} ms; the outcome is unknown and will not be retried automatically.`, requestId);
        } else {
            to = "EXECUTED";
            reason = "adapter succeeded";
            output = outcome.value.output;
            result = { status: outcome.value.status, ...(outcome.value.data ? { data: outcome.value.data } : {}), executedAt: new Date().toISOString() };
        }
    } catch (err) {
        to = "FAILED";
        reason = "adapter reported an error";
        error = errorShape("ADAPTER_ERROR", err instanceof Error ? err.message : "Adapter failed.", requestId);
    }

    let view: RequestView;
    try {
        view = mutateRequests((records) => {
            const record = findRecord(records, requestId);
            // Si un lector ya la marcó UNKNOWN por inactividad, el estado terminal prevalece.
            if (record.status !== "EXECUTING") return toView(record);
            transition(record, to, { actor: "adapter", reason });
            record.result = result;
            record.error = error;
            return toView(record);
        });
    } catch (storageError) {
        if (!(storageError instanceof RuntimeError) || !["STORAGE_BUSY", "STORAGE_ERROR"].includes(storageError.code)) throw storageError;
        appendAudit({
            event: "execute",
            request_id: requestId,
            agent: initialRecord.agent,
            action: initialRecord.action,
            decision: "UNKNOWN",
            reason: STORAGE_WRITE_FAILED_AFTER_EXECUTION,
        });
        const unknown = cloneRecord(initialRecord);
        if (unknown.status === "EXECUTING") {
            transition(unknown, "UNKNOWN", { actor: "system", reason: STORAGE_WRITE_FAILED_AFTER_EXECUTION });
        }
        unknown.error = errorShape(
            "EXECUTION_UNKNOWN",
            "The action may have executed, but its final result could not be saved. Do not retry automatically.",
            requestId,
        );
        return toView(unknown);
    }
    return output !== undefined && view.status === "EXECUTED" ? { ...view, output } : view;
}

export async function approveRequest(requestId: string, options: RuntimeOptions & { actor?: string } = {}): Promise<RequestView> {
    const actor = options.actor ?? "user";
    const outcome = mutateRequests((records) => {
        const record = findRecord(records, requestId);
        if (record.status === "PENDING" && isOverdue(record)) {
            expireRecord(record);
            return { kind: "timeout" as const };
        }
        if (record.status !== "PENDING") {
            throw new RuntimeError("ALREADY_DECIDED", `Request ${requestId} is no longer pending (status=${record.status}).`, requestId, record.status);
        }

        transition(record, "APPROVED", { actor, reason: "approved by user" });

        let denial: string | undefined;
        let spendPeriod: DailySpendPeriod | undefined;
        if (!record.intentMac || !record.expiresAt || !pendingIntentMacMatches({
            intent: record.intent, intentMac: record.intentMac, id: record.requestId,
            agent: record.agent, action: record.action, expiresAt: record.expiresAt,
        })) {
            denial = "intent MAC mismatch";
        } else {
            try {
                const mandate = loadCurrentMandate();
                if (record.action === "pay") spendPeriod = dailySpendPeriod(records, new Date(), mandate.timezone ?? "UTC");
                const verdict = evaluateForApproval(record.intent, spendPeriod?.spentEur ?? 0, mandate);
                if (verdict !== "GREEN") denial = `current policy returned ${verdict}`;
            } catch {
                denial = "current mandate unavailable";
            }
            if (!denial && needsReplay(record.intent)
                && (!record.replay || !record.replayMac || !record.expiresAt
                    || !replayMacMatches(record.requestId, record.replay, record.expiresAt, record.replayMac))) {
                denial = "original request integrity check failed";
            }
        }
        if (denial) {
            denyRecord(record, "runtime", `re-evaluation: ${denial}`, `Denied on re-evaluation: ${denial}.`);
            return { kind: "denied" as const, view: toView(record) };
        }
        if (record.action === "pay" && spendPeriod) {
            record.dailySpendDay = spendPeriod.day;
            record.dailySpendTimezone = spendPeriod.timeZone;
        }
        transition(record, "EXECUTING", { actor: "runtime", reason: "re-evaluation GREEN" });
        return { kind: "execute" as const, record: cloneRecord(record), intent: cloneRecord(record.intent), request: record.replay ? cloneRecord(record.replay) : undefined };
    });

    if (outcome.kind === "timeout") {
        throw new RuntimeError("APPROVAL_TIMEOUT", `Request ${requestId} expired before approval.`, requestId, "EXPIRED");
    }
    if (outcome.kind === "denied") return outcome.view;
    return runExecution(requestId, outcome.intent, options, outcome.request, outcome.record);
}

export function denyRequest(requestId: string, options: { actor?: string } = {}): RequestView {
    const outcome = mutateRequests((records) => {
        const record = findRecord(records, requestId);
        if (record.status === "PENDING" && isOverdue(record)) {
            expireRecord(record);
            return { timeout: true, view: toView(record) };
        }
        if (record.status !== "PENDING") {
            throw new RuntimeError("ALREADY_DECIDED", `Request ${requestId} is no longer pending (status=${record.status}).`, requestId, record.status);
        }
        denyRecord(record, options.actor ?? "user", "denied by user", "Denied by the user.");
        return { timeout: false, view: toView(record) };
    });
    if (outcome.timeout) {
        throw new RuntimeError("APPROVAL_TIMEOUT", `Request ${requestId} expired before it was denied.`, requestId, "EXPIRED");
    }
    return outcome.view;
}

function recoverStaleExecution(record: StoredRequest, options: RuntimeOptions): void {
    const staleMs = (options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS) + STALE_EXECUTION_GRACE_MS;
    if (isRequestTombstone(record) || record.status !== "EXECUTING"
        || Date.now() - Date.parse(record.updatedAt) <= staleMs) return;
    transition(record, "UNKNOWN", { actor: "system", reason: "executor did not report an outcome" });
    record.error = errorShape("EXECUTION_UNKNOWN", "Execution outcome is unknown and will not be retried automatically.", record.requestId);
}

/** Estado actual; materializa expiración y recuperación de una ejecución estancada. */
export function getRequestStatus(requestId: string, options: RuntimeOptions = {}): RequestView {
    return mutateRequests((records) => {
        sweepExpired(records);
        const record = findRecord(records, requestId);
        recoverStorageWriteFailure(record);
        recoverStaleExecution(record, options);
        return toView(record);
    });
}

export function listPendingRequests(): RequestView[] {
    return mutateRequests((records) => {
        sweepExpired(records);
        return records.filter((r) => r.status === "PENDING").map(toView);
    });
}

export function countRecentRequests(since: number, until: number): number {
    return readRequests().filter((record) => {
        const createdAt = Date.parse(record.createdAt);
        return Number.isFinite(createdAt) && createdAt > since && createdAt <= until;
    }).length;
}

/** Lo que una persona necesita ver para decidir; el intent ya está saneado en el libro. */
export interface PendingDetail {
    requestId: string;
    agent: string;
    action: string;
    tool: string;
    rule: string | null;
    createdAt: string;
    expiresAt: string;
    amountEur?: number;
    params?: Record<string, unknown>;
    method: string;
    url: string;
}

export function describePending(): PendingDetail[] {
    return mutateRequests((records) => {
        sweepExpired(records);
        return records.filter((r) => r.status === "PENDING" && r.expiresAt).map((r) => ({
            requestId: r.requestId,
            agent: r.agent,
            action: r.action,
            tool: r.intent.tool,
            rule: r.rule,
            createdAt: r.createdAt,
            expiresAt: r.expiresAt as string,
            amountEur: r.intent.amountEur,
            params: r.intent.params,
            method: r.method,
            url: r.url,
        }));
    });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera hasta un estado terminal; un EXECUTING sin noticias del ejecutor pasa a UNKNOWN. */
export async function waitForRequest(requestId: string, options: RuntimeOptions = {}): Promise<RequestView> {
    const pollMs = options.pollMs ?? 500;
    for (; ;) {
        const view = mutateRequests((records) => {
            sweepExpired(records);
            const record = findRecord(records, requestId);
            recoverStorageWriteFailure(record);
            recoverStaleExecution(record, options);
            return toView(record);
        });
        if (isTerminal(view.status)) return view;
        const untilExpiry = view.status === "PENDING" && view.expiresAt ? Date.parse(view.expiresAt) - Date.now() : Infinity;
        await sleep(Math.max(1, Math.min(pollMs, untilExpiry)));
    }
}
