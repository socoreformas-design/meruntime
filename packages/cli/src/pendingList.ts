// Lista las solicitudes PENDING de aprobación humana.

import { describePending } from "../../engine/src/requestRuntime.js";
import { listPendingAuthorizations } from "../../engine/src/authorizationRuntime.js";

export function runPending(): number {
    const requests = describePending();
    const authorizations = listPendingAuthorizations();
    if (requests.length === 0 && authorizations.length === 0) {
        console.log("No pending requests.");
        return 0;
    }
    const amountFormat = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    for (const request of requests) {
        const amount = typeof request.amountEur === "number" ? ` amount=${amountFormat.format(request.amountEur)}` : "";
        const iban = typeof request.params?.iban === "string" ? ` iban=${JSON.stringify(request.params.iban)}` : "";
        const concept = typeof request.params?.concept === "string"
            ? ` concept=${JSON.stringify(request.params.concept.slice(0, 240))}`
            : "";
        const target = request.action === "pay" ? `${amount}${iban}${concept}` : ` ${request.method} ${JSON.stringify(request.url)}`;
        console.log(`${request.requestId}  agent=${JSON.stringify(request.agent)}  action=${request.action}${target}  expiresAt=${request.expiresAt}  rule=${request.rule}`);
    }
    for (const authorization of authorizations) {
        console.log(`${authorization.requestId}  agent_id=${JSON.stringify(authorization.agentId)}  action=${authorization.action}  tool=${authorization.toolName}  command=${JSON.stringify(authorization.command)}  cwd=${JSON.stringify(authorization.cwd)}  expiresAt=${authorization.expiresAt}  rule=${authorization.rule}`);
    }
    return 0;
}
