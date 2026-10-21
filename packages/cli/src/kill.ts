// Consulta o cambia el interruptor de emergencia (~/.meruntime/kill.json).

import { readKillSwitch, setKillSwitch } from "../../engine/src/kill.js";

export function runKill(args: string[]): number {
    const arg = args[0] ?? "status";
    if (arg === "on" || arg === "off") {
        setKillSwitch(arg === "on");
        console.log(`kill: ${arg}`);
    } else if (arg === "status") {
        console.log(`kill: ${readKillSwitch().on ? "on" : "off"}`);
    } else {
        console.error("Usage: meruntime kill on|off|status");
        return 1;
    }
    return 0;
}
