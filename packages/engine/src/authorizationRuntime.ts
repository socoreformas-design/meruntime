import { createHash, randomBytes } from "node:crypto";
import type { ActionClass, Intent, Verdict } from "../../schema/src/index.js";
import { appendAudit } from "./audit.js";
import { withAdmissionLock } from "./admission.js";
import { classifyCommand } from "./commandClassifier.js";
import { RuntimeError } from "./errors.js";
import { explainEvaluate } from "./evaluate.js";
import { createIntentMac, pendingIntentMacMatches } from "./pendingStore.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_MAX_PENDING_REQUESTS, DEFAULT_RATE_LIMIT_PER_SECOND, approvalTimeoutMs, evaluateForApproval, loadCurrentMandate } from "./policy.js";
import { countRecentRequests, listPendingRequests } from "./requestRuntime.js";
import { countPendingAuthorizations, countRecentAuthorizations, isAuthorizationTombstone, mutateAuthorizations, readAuthorizations, type AuthorizationRecord, type AuthorizationStatus, type StoredAuthorization } from "./authorizationStore.js";

export interface AuthorizeCommandInput {
    agentId: string;
    toolName: "Bash" | "PowerShell";
    command: string;
    cwd: string;
    idempotencyKey: string;
}

export interface AuthorizationView {
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
}

function view(record: StoredAuthorization): AuthorizationView {
    return {
        requestId: record.requestId,
        idempotencyKey: record.idempotencyKey,
        payloadHash: record.payloadHash,
        agentId: isAuthorizationTombstone(record) ? "" : record.agentId,
        toolName: isAuthorizationTombstone(record) ? "" : record.toolName,
        command: isAuthorizationTombstone(record) ? "" : record.command,
        cwd: isAuthorizationTombstone(record) ? "" : record.cwd,
        action: isAuthorizationTombstone(record) ? "exec" : record.action,
        status: record.status,
        verdict: record.verdict,
        rule: record.rule,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        expiresAt: isAuthorizationTombstone(record) ? null : record.expiresAt,
    };
}

function requestId(): string { return `mr_${randomBytes(6).toString("hex")}`; }

function createIntent(input: Omit<AuthorizeCommandInput, "idempotencyKey">, action: ActionClass): Intent {
    return {
        agentId: input.agentId,
        action,
        tool: "terminal.command",
        target: input.cwd,
        params: { command: input.command, cwd: input.cwd, toolName: input.toolName },
        effects: [{ kind: action, reversible: action === "read", scope: `terminal:${input.cwd}` }],
    };
}

function hashPayload(intent: Intent): string {
    return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

function auditDecision(record: AuthorizationRecord | ReturnType<typeof view>, decision: "GREEN" | "YELLOW" | "RED", reason: string): void {
    appendAudit({
        event: "request",
        request_id: record.requestId,
        agent: record.agentId || null,
        action: record.action,
        decision,
        reason,
        rule: record.rule,
        params_hash: record.payloadHash,
    });
}

function terminalRecord(input: AuthorizeCommandInput, intent: Intent, hash: string, action: ActionClass, verdict: Verdict, rule: string, timeoutMs?: number): AuthorizationRecord {
    const now = new Date();
    const id = requestId();
    const expiresAt = verdict === "YELLOW" ? new Date(now.getTime() + (timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS)).toISOString() : null;
    const record: AuthorizationRecord = {
        requestId: id,
        idempotencyKey: input.idempotencyKey,
        payloadHash: hash,
        agentId: input.agentId,
        toolName: input.toolName,
        command: input.command,
        cwd: input.cwd,
        action,
        status: verdict === "GREEN" ? "AUTHORIZED" : verdict === "YELLOW" ? "PENDING" : "DENIED",
        verdict,
        rule,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt,
        intent,
        intentMac: expiresAt && verdict === "YELLOW" ? createIntentMac(intent, id, input.agentId, action, expiresAt) : null,
        transitions: [{ from: "RECEIVED", to: verdict === "GREEN" ? "AUTHORIZED" : verdict === "YELLOW" ? "PENDING" : "DENIED", actor: "runtime", at: now.toISOString(), reason: `terminal policy decision (${rule})` }],
    };
    return record;
}

function isExpired(record: AuthorizationRecord, now = Date.now()): boolean {
    return record.status === "PENDING" && record.expiresAt !== null && now >= Date.parse(record.expiresAt);
}

function expire(record: AuthorizationRecord): void {
    const now = new Date().toISOString();
    record.status = "EXPIRED";
    record.verdict = "RED";
    record.rule = "approval.timeout";
    record.updatedAt = now;
    record.transitions.push({ from: "PENDING", to: "EXPIRED", actor: "system", at: now, reason: "approval timeout elapsed; command not authorized" });
    appendAudit({ event: "expire", request_id: record.requestId, agent: record.agentId, action: record.action, decision: "expired", reason: "approval timeout elapsed; command not authorized", rule: record.rule, params_hash: record.payloadHash });
}

/** Creates or reuses an authorization decision. This function never invokes an adapter or shell. */
export function authorizeCommand(input: AuthorizeCommandInput): AuthorizationView {
    if (!input || typeof input.agentId !== "string" || input.agentId.length < 1 || input.agentId.length > 128
        || !["Bash", "PowerShell"].includes(input.toolName)
        || typeof input.command !== "string" || input.command.length < 1 || input.command.length > 4096
        || typeof input.cwd !== "string" || input.cwd.length < 1 || input.cwd.length > 1024
        || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 256) {
        throw new RuntimeError("INVALID_REQUEST", "Invalid terminal authorization fields.");
    }
    const action = classifyCommand(input.command);
    const intent = createIntent(input, action);
    const payloadHash = hashPayload(intent);

    return withAdmissionLock(() => {
        const record = mutateAuthorizations((records) => {
            const existing = records.find((item) => item.idempotencyKey === input.idempotencyKey);
            if (existing) {
                if (existing.payloadHash !== payloadHash) throw new RuntimeError("IDEMPOTENCY_KEY_REUSED", "idempotency_key was already used with a different command.", existing.requestId);
                if (!isAuthorizationTombstone(existing) && isExpired(existing)) expire(existing);
                return existing;
            }

            for (const authorization of records) {
                if (!isAuthorizationTombstone(authorization) && isExpired(authorization, Date.now())) expire(authorization);
            }

            const nowMs = Date.now();
            let verdict: Verdict = "RED";
            let rule = "mandate-unavailable";
            let timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS;
            let mandate;
            try {
                mandate = loadCurrentMandate();
                timeoutMs = approvalTimeoutMs(mandate);
                const currentRate = mandate.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT_PER_SECOND;
                const recent = countRecentAuthorizations(nowMs - 1_000, nowMs) + countRecentRequests(nowMs - 1_000, nowMs);
                if (recent >= currentRate) {
                    rule = "rateLimit.exceeded";
                } else {
                    const currentPending = listPendingRequests().length + countPendingAuthorizations(records, nowMs);
                    if (currentPending >= (mandate.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS)) {
                        rule = "pending.limitReached";
                    } else {
                        const explanation = explainEvaluate(mandate, intent, new Date());
                        verdict = explanation.verdict;
                        rule = explanation.rule ?? "unknown";
                    }
                }
            } catch {
                verdict = "RED";
                rule = "mandate-unavailable";
            }
            const next = terminalRecord(input, intent, payloadHash, action, verdict, rule, timeoutMs);
            records.push(next);
            return next;
        });
        return view(record);
    });
}

function findAuthorization(records: StoredAuthorization[], id: string): StoredAuthorization {
    const record = records.find((item) => item.requestId === id);
    if (!record) throw new RuntimeError("REQUEST_NOT_FOUND", `Authorization ${id} not found.`, id);
    return record;
}

export function getAuthorization(id: string): AuthorizationView | undefined {
    return mutateAuthorizations((records) => {
        const record = records.find((item) => item.requestId === id);
        if (!record) return undefined;
        if (!isAuthorizationTombstone(record) && isExpired(record)) expire(record);
        return view(record);
    });
}

export function listPendingAuthorizations(): AuthorizationView[] {
    return mutateAuthorizations((records) => {
        for (const record of records) if (!isAuthorizationTombstone(record) && isExpired(record)) expire(record);
        return records.filter((item) => !isAuthorizationTombstone(item) && item.status === "PENDING").map(view);
    });
}

export function approveAuthorization(id: string, actor = "user"): AuthorizationView {
    const outcome = mutateAuthorizations((records) => {
        const stored = findAuthorization(records, id);
        if (isAuthorizationTombstone(stored)) throw new RuntimeError("ALREADY_DECIDED", `Authorization ${id} is no longer pending.`, id, stored.status as never);
        if (isExpired(stored)) {
            expire(stored);
            return { expired: true as const };
        }
        if (stored.status !== "PENDING") throw new RuntimeError("ALREADY_DECIDED", `Authorization ${id} is no longer pending (status=${stored.status}).`, id);
        const now = new Date().toISOString();
        const approvedIntent = createIntent({ agentId: stored.agentId, toolName: stored.toolName as "Bash" | "PowerShell", command: stored.command, cwd: stored.cwd }, stored.action);
        let denial: string | undefined;
        if (!stored.expiresAt || !stored.intentMac || !pendingIntentMacMatches({
            intent: stored.intent,
            intentMac: stored.intentMac,
            id: stored.requestId,
            agent: stored.agentId,
            action: stored.action,
            expiresAt: stored.expiresAt,
        }) || hashPayload(approvedIntent) !== stored.payloadHash) {
            denial = "authorization integrity check failed";
        } else {
            try {
                const mandate = loadCurrentMandate();
                if (evaluateForApproval(approvedIntent, 0, mandate) !== "GREEN") denial = "current policy is not GREEN";
            } catch {
                denial = "current mandate unavailable";
            }
        }
        stored.updatedAt = now;
        stored.transitions.push({ from: "PENDING", to: denial ? "DENIED" : "AUTHORIZED", actor, at: now, reason: denial ?? "approved after policy re-evaluation" });
        stored.status = denial ? "DENIED" : "AUTHORIZED";
        stored.verdict = denial ? "RED" : "GREEN";
        stored.rule = denial ? "approval.reevaluation" : stored.rule;
        return { expired: false as const, authorization: view(stored) };
    });
    if (outcome.expired) throw new RuntimeError("APPROVAL_TIMEOUT", `Authorization ${id} expired before approval.`, id);
    return outcome.authorization;
}

export function denyAuthorization(id: string, actor = "user"): AuthorizationView {
    const outcome = mutateAuthorizations((records) => {
        const stored = findAuthorization(records, id);
        if (isAuthorizationTombstone(stored)) throw new RuntimeError("ALREADY_DECIDED", `Authorization ${id} is no longer pending.`, id);
        if (isExpired(stored)) {
            expire(stored);
            return { expired: true as const };
        }
        if (stored.status !== "PENDING") throw new RuntimeError("ALREADY_DECIDED", `Authorization ${id} is no longer pending (status=${stored.status}).`, id);
        const now = new Date().toISOString();
        stored.status = "DENIED";
        stored.verdict = "RED";
        stored.rule = "approval.denied";
        stored.updatedAt = now;
        stored.transitions.push({ from: "PENDING", to: "DENIED", actor, at: now, reason: "denied by user" });
        return { expired: false as const, authorization: view(stored) };
    });
    if (outcome.expired) throw new RuntimeError("APPROVAL_TIMEOUT", `Authorization ${id} expired before it was denied.`, id);
    return outcome.authorization;
}

export function evaluateTerminalCommand(input: Omit<AuthorizeCommandInput, "idempotencyKey">): { action: ActionClass; verdict: Verdict; rule: string } {
    const action = classifyCommand(input.command);
    try {
        const explanation = explainEvaluate(loadCurrentMandate(), createIntent({ ...input, idempotencyKey: "preview" }, action), new Date());
        return { action, verdict: explanation.verdict, rule: explanation.rule ?? "unknown" };
    } catch {
        return { action, verdict: "RED", rule: "mandate-unavailable" };
    }
}
