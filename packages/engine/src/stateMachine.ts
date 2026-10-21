// Máquina de estados de una solicitud: única fuente de verdad de las transiciones permitidas.

import { RuntimeError } from "./errors.js";

export const REQUEST_STATUSES = [
    "RECEIVED", "EVALUATING", "PENDING", "APPROVED", "DENIED",
    "EXPIRED", "EXECUTING", "EXECUTED", "FAILED", "UNKNOWN",
] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];

export const ALLOWED_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
    RECEIVED: ["EVALUATING"],
    EVALUATING: ["EXECUTING", "PENDING", "DENIED"],
    PENDING: ["APPROVED", "DENIED", "EXPIRED"],
    APPROVED: ["EXECUTING", "DENIED"],
    EXECUTING: ["EXECUTED", "FAILED", "UNKNOWN"],
    DENIED: [],
    EXPIRED: [],
    EXECUTED: [],
    FAILED: [],
    UNKNOWN: [],
};

export const TERMINAL_STATUSES: readonly RequestStatus[] = ["EXECUTED", "DENIED", "EXPIRED", "FAILED", "UNKNOWN"];

export function isTerminal(status: RequestStatus): boolean {
    return TERMINAL_STATUSES.includes(status);
}

export interface TransitionRecord {
    from: RequestStatus;
    to: RequestStatus;
    actor: string;
    at: string;
    reason: string;
}

export interface Transitionable {
    requestId: string;
    status: RequestStatus;
    updatedAt: string;
    transitions: TransitionRecord[];
}

/** Aplica la transición en memoria; el llamador la persiste antes de actuar. */
export function transition(
    request: Transitionable,
    to: RequestStatus,
    meta: { actor: string; reason: string },
    now: Date = new Date(),
): TransitionRecord {
    const from = request.status;
    if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
        throw new RuntimeError("INVALID_STATE_TRANSITION", `Transition ${from} -> ${to} is not allowed.`, request.requestId, from);
    }
    const entry: TransitionRecord = { from, to, actor: meta.actor, at: now.toISOString(), reason: meta.reason };
    request.status = to;
    request.updatedAt = entry.at;
    request.transitions.push(entry);
    return entry;
}
