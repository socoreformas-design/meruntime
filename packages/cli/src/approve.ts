// Aprueba una solicitud PENDING; el CORE reevalúa y ejecuta como máximo una vez.

import { RuntimeError } from "../../engine/src/errors.js";
import { approveAuthorization, getAuthorization } from "../../engine/src/authorizationRuntime.js";
import { approveRequest } from "../../engine/src/requestRuntime.js";

export async function runApprove(args: string[]): Promise<number> {
    const id = args[0];
    if (!id) {
        console.error("Usage: meruntime approve <requestId>");
        return 1;
    }
    try {
        const authorization = getAuthorization(id);
        if (authorization) {
            const view = approveAuthorization(id);
            console.log(`Authorization ${id} status=${view.status} verdict=${view.verdict} (command not executed by Me Runtime)`);
            return view.status === "AUTHORIZED" ? 0 : 1;
        }
        const view = await approveRequest(id);
        console.log(`Request ${id} status=${view.status}${view.error ? ` error=${view.error.code}: ${view.error.message}` : ""}`);
        return view.status === "EXECUTED" ? 0 : 1;
    } catch (err) {
        if (err instanceof RuntimeError) {
            console.error(`${err.code}${err.status ? ` status=${err.status}` : ""} ${err.message}`);
        } else {
            console.error("INTERNAL_ERROR Internal error.");
        }
        return 1;
    }
}
