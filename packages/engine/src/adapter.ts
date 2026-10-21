// Fachada del CORE. executeAuthorized() usa el libro de solicitudes (requestRuntime).
// approvePending() y el almacén pending.json son la API heredada, conservada por compatibilidad.

import { writeFileSync } from "node:fs";
import type { Intent } from "../../schema/src/index.js";
import { appendAudit } from "./audit.js";
import { executeCoreIntent, isCoreManagedIntent } from "./coreExecutor.js";
import { RuntimeError } from "./errors.js";
import { PendingInvalidatedError, PendingNotActionableError, PendingNotFoundError, auditExpired, isOverdue, markExpired, markPath, mutatePending, pendingIntentMacMatches } from "./pendingStore.js";
import { evaluateForApproval } from "./policy.js";
import { submitRequest, type Adapter, type RequestView } from "./requestRuntime.js";
import type { PendingExecution, PendingRecord } from "./pendingStore.js";

export { isCoreManagedIntent, isGitHubUserIntent, isProtectedIntent } from "./coreExecutor.js";

export class CoreAuthorizationError extends RuntimeError {
    constructor(readonly verdict: "YELLOW" | "RED", requestId?: string) {
        super("POLICY_DENY", `CORE execution rejected by current policy: ${verdict}.`, requestId);
        this.name = "CoreAuthorizationError";
    }
}

export interface AuthorizedOptions {
    /** Con YELLOW: false devuelve el pending sin esperar. Por defecto true. */
    wait?: boolean;
    /** Petición original, usada para el hash del payload. Por defecto POST (GET si es read) a intent.target. */
    request?: { method: string; url: string; body?: string };
    idempotencyKey?: string;
    /** Plazo de aprobación; por defecto mandate.approvalTimeoutMs o 5 min. */
    approvalTimeoutMs?: number;
    executionTimeoutMs?: number;
    pollMs?: number;
    adapter?: Adapter;
    onPending?: (pending: { id: string; expiresAt: string }) => void;
}

export interface PendingHandle {
    pending: true;
    id: string;
    expiresAt: string;
}

function resultOrThrow(view: RequestView): { success: true; status: number } {
    const id = view.requestId;
    switch (view.status) {
        case "EXECUTED":
            return { success: true, status: view.result?.status ?? 200 };
        case "DENIED": {
            const byPolicy = view.transitions[view.transitions.length - 1]?.actor === "runtime";
            if (byPolicy) throw new CoreAuthorizationError("RED", id);
            throw new RuntimeError("POLICY_DENY", view.error?.message ?? "Denied by the user.", id, view.status);
        }
        case "EXPIRED":
            throw new RuntimeError("APPROVAL_TIMEOUT", "Approval timed out; the action was not executed.", id, view.status);
        case "FAILED":
            throw new RuntimeError("ADAPTER_ERROR", view.error?.message ?? "Adapter failed.", id, view.status);
        case "UNKNOWN":
            throw new RuntimeError(view.error?.code === "EXECUTION_TIMEOUT" ? "EXECUTION_TIMEOUT" : "EXECUTION_UNKNOWN",
                view.error?.message ?? "Execution outcome is unknown.", id, view.status);
        default:
            throw new RuntimeError("PENDING_CONFIRMATION", `Request ${id} is in progress (status=${view.status}).`, id, view.status);
    }
}

export function executeAuthorized(intent: Intent, options: AuthorizedOptions & { wait: false }): Promise<{ success: true; status: number } | PendingHandle>;
export function executeAuthorized(intent: Intent, options?: AuthorizedOptions): Promise<{ success: true; status: number }>;
export async function executeAuthorized(intent: Intent, options: AuthorizedOptions = {}): Promise<{ success: true; status: number } | PendingHandle> {
    const view = await submitRequest(
        { intent, request: options.request, idempotencyKey: options.idempotencyKey },
        {
            wait: options.wait,
            approvalTimeoutMs: options.approvalTimeoutMs,
            executionTimeoutMs: options.executionTimeoutMs,
            pollMs: options.pollMs,
            adapter: options.adapter,
            onPending: (pending) => options.onPending?.({ id: pending.requestId, expiresAt: pending.expiresAt! }),
        },
    );
    if (options.wait === false && view.status === "PENDING") {
        return { pending: true, id: view.requestId, expiresAt: view.expiresAt! };
    }
    return resultOrThrow(view);
}

async function executeApprovedIntent(record: PendingRecord): Promise<PendingExecution> {
    try {
        if (isCoreManagedIntent(record.intent)) {
            const result = await executeCoreIntent(record.intent);
            return { success: true, executed_at: new Date().toISOString(), status: result.status };
        }
        writeFileSync(markPath(record.id), new Date().toISOString(), "utf-8");
        return { success: true, executed_at: new Date().toISOString() };
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { success: false, executed_at: new Date().toISOString(), detail };
    }
}

type ApprovalOutcome =
    | { kind: "approved"; record: PendingRecord }
    | { kind: "expired"; record: PendingRecord }
    | { kind: "invalidated"; record: PendingRecord; reason: string };

function invalidateRecord(record: PendingRecord, reason: string): ApprovalOutcome {
    record.status = "invalidated";
    record.decision = "invalidated";
    record.decision_at = new Date().toISOString();
    return { kind: "invalidated", record: { ...record }, reason };
}

export async function approvePending(id: string): Promise<PendingRecord> {
    // Todo el chequeo y la transición a approved/expired/invalidated ocurre bajo lock.
    const outcome = mutatePending((records): ApprovalOutcome => {
        const record = records.find((item) => item.id === id);
        if (!record) throw new PendingNotFoundError(`Request ${id} not found.`);
        if (record.status === "pending" && isOverdue(record)) {
            markExpired(record);
            return { kind: "expired", record: { ...record } };
        }
        if (record.status === "approved") {
            throw new PendingNotActionableError(`Request ${id} is already approved/executed.`, record.status);
        }
        if (record.status === "denied") {
            throw new PendingNotActionableError(`Request ${id} was already denied and cannot be approved.`, record.status);
        }
        if (record.status === "invalidated") {
            throw new PendingNotActionableError(`Request ${id} was invalidated and cannot be approved.`, record.status);
        }
        if (record.status === "expired") {
            throw new PendingNotActionableError(`Request ${id} has expired and cannot be approved.`, record.status);
        }
        if (!pendingIntentMacMatches(record)) return invalidateRecord(record, "intent MAC mismatch");

        let verdict;
        try {
            verdict = evaluateForApproval(record.intent);
        } catch {
            return invalidateRecord(record, "current mandate unavailable");
        }
        if (verdict !== "GREEN") return invalidateRecord(record, `current policy returned ${verdict}`);

        record.status = "approved";
        record.decision = "approved";
        record.decision_at = new Date().toISOString();
        return { kind: "approved", record: { ...record } };
    });

    if (outcome.kind === "expired") {
        auditExpired(outcome.record);
        throw new PendingNotActionableError(`Request ${id} has expired and cannot be approved.`, "expired");
    }
    if (outcome.kind === "invalidated") {
        appendAudit({
            event: "invalidate",
            request_id: outcome.record.id,
            agent: outcome.record.agent,
            action: outcome.record.action,
            decision: "invalidated",
            reason: `pending invalidated: ${outcome.reason}`,
        });
        throw new PendingInvalidatedError(`Request ${id} was invalidated: ${outcome.reason}.`);
    }

    const execution = await executeApprovedIntent(outcome.record);
    return mutatePending((records) => {
        const stored = records.find((item) => item.id === id)!;
        stored.execution = execution;
        return { ...stored };
    });
}