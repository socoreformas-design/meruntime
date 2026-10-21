// Errores del runtime con código estable. Los mensajes pasan por la redacción de secretos.

import { redactAuditText } from "./audit.js";
import type { RequestStatus } from "./stateMachine.js";

export const ERROR_CODES = [
    "INVALID_REQUEST", "INVALID_ACTION", "POLICY_DENY", "PENDING_CONFIRMATION", "REQUEST_NOT_FOUND",
    "INVALID_STATE_TRANSITION", "ALREADY_DECIDED", "IDEMPOTENCY_KEY_REUSED", "APPROVAL_TIMEOUT",
    "EXECUTION_TIMEOUT", "ADAPTER_ERROR", "EXECUTION_UNKNOWN", "STORAGE_BUSY", "STORAGE_ERROR", "UNAUTHORIZED", "INTERNAL_ERROR",
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

export interface ErrorShape {
    code: ErrorCode;
    message: string;
    requestId?: string;
    retryable: boolean;
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["PENDING_CONFIRMATION", "STORAGE_ERROR", "ADAPTER_ERROR"]);

export class RuntimeError extends Error {
    readonly retryable: boolean;

    /** `status` es el estado observado de la solicitud, si aplica. */
    constructor(readonly code: ErrorCode, message: string, readonly requestId?: string, readonly status?: RequestStatus) {
        super(redactAuditText(message));
        this.name = "RuntimeError";
        this.retryable = RETRYABLE.has(code);
    }

    toShape(): ErrorShape {
        return { code: this.code, message: this.message, requestId: this.requestId, retryable: this.retryable };
    }
}

export function toErrorShape(err: unknown, requestId?: string): ErrorShape {
    if (err instanceof RuntimeError) return err.toShape();
    return { code: "INTERNAL_ERROR", message: "Internal error.", requestId, retryable: false };
}
