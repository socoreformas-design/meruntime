// Deniega una solicitud PENDING. No se ejecuta ninguna acción.

import { RuntimeError } from "../../engine/src/errors.js";
import { denyAuthorization, getAuthorization } from "../../engine/src/authorizationRuntime.js";
import { denyRequest } from "../../engine/src/requestRuntime.js";

export function runDeny(args: string[]): number {
    const id = args[0];
    if (!id) {
        console.error("Usage: meruntime deny <requestId>");
        return 1;
    }
    try {
        if (getAuthorization(id)) {
            const view = denyAuthorization(id);
            console.log(`Authorization ${id} status=${view.status} verdict=${view.verdict}`);
            return 0;
        }
        const view = denyRequest(id);
        console.log(`Request ${id} status=${view.status}`);
        return 0;
    } catch (err) {
        if (err instanceof RuntimeError) {
            console.error(`${err.code}${err.status ? ` status=${err.status}` : ""} ${err.message}`);
        } else {
            console.error("INTERNAL_ERROR Internal error.");
        }
        return 1;
    }
}
