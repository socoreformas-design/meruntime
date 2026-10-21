// Imprime las últimas líneas del log de auditoría (~/.meruntime/audit.jsonl).

import { readAuditLines } from "../../engine/src/audit.js";

export function runAudit(args: string[]): number {
    let last = 20;
    const flag = args.indexOf("--last");
    if (flag >= 0) {
        last = Number(args[flag + 1]);
        if (!Number.isInteger(last) || last <= 0) {
            console.error("Usage: meruntime audit [--last N]");
            return 1;
        }
    }
    const lines = readAuditLines(last);
    if (lines.length === 0) {
        console.log("no events");
        return 0;
    }
    for (const l of lines) {
        const transition = l.event === "transition" ? `  ${l.from}->${l.to}  actor=${l.actor}` : "";
        console.log(`${l.at}  ${l.event}  ${l.decision}  id=${l.request_id ?? "-"}${transition}`);
    }
    return 0;
}
