// Muestra el estado de una solicitud.

import { RuntimeError } from "../../engine/src/errors.js";
import { getRequestStatus } from "../../engine/src/requestRuntime.js";

export function runRequestStatus(args: string[]): number {
    const id = args[0];
    if (!id) {
        console.error("Usage: meruntime request-status <requestId>");
        return 1;
    }
    try {
        const v = getRequestStatus(id);
        console.log(JSON.stringify({
            requestId: v.requestId,
            status: v.status,
            verdict: v.verdict,
            rule: v.rule,
            expiresAt: v.expiresAt,
            result: v.result,
            error: v.error,
            transitions: v.transitions,
        }, null, 2));
        return 0;
    } catch (err) {
        console.error(err instanceof RuntimeError ? `${err.code} ${err.message}` : "INTERNAL_ERROR Internal error.");
        return 1;
    }
}
