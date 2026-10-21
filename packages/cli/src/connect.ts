// meruntime connect: añade o quita Me Runtime en la configuración MCP de un cliente instalado.

import { CLIENT_IDS, ClientError, connectClient, disconnectClient, isClientId, listClients } from "./clients.js";

const USAGE = `Usage: meruntime connect --list | meruntime connect <${CLIENT_IDS.join("|")}> [--remove]`;

export function runConnect(args: string[]): number {
    const remove = args.includes("--remove");
    const ids = args.filter((a) => !a.startsWith("--"));
    const flags = args.filter((a) => a.startsWith("--"));
    if (flags.some((f) => f !== "--remove" && f !== "--list")) {
        console.error(USAGE);
        return 1;
    }

    if (ids.length === 0) {
        if (remove) {
            console.error(USAGE);
            return 1;
        }
        for (const client of listClients()) {
            const state = !client.detected ? "not detected" : client.problem ? `problem: ${client.problem}` : client.connected ? "connected" : "not connected";
            console.log(`${client.id.padEnd(15)} ${state}${client.detected ? `  (${client.path})` : ""}`);
        }
        return 0;
    }

    if (ids.length !== 1 || !isClientId(ids[0])) {
        console.error(USAGE);
        return 1;
    }
    try {
        const result = remove ? disconnectClient(ids[0]) : connectClient(ids[0]);
        if (!result.changed) console.log(`${remove ? "Not connected" : "Already connected"}: ${result.path}`);
        else console.log(`${remove ? "Removed from" : "Connected in"} ${result.path}${result.backupPath ? `\n  backup: ${result.backupPath}` : ""}\nRestart the app to apply it.`);
        return 0;
    } catch (err) {
        console.error(err instanceof ClientError ? err.message : "Could not update the configuration file.");
        return 1;
    }
}
