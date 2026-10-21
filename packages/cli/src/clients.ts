// Conecta Me Runtime a clientes MCP (Claude Desktop, Cursor, VS Code) editando su configuración con cuidado.

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../engine/src/fsAtomic.js";
import { selfCommand } from "./selfCommand.js";

export const CLIENT_IDS = ["claude-desktop", "cursor", "vscode"] as const;
export type ClientId = typeof CLIENT_IDS[number];

export function isClientId(value: string): value is ClientId {
    return (CLIENT_IDS as readonly string[]).includes(value);
}

export interface ClientContext {
    home: string;
    appData?: string;
    platform: NodeJS.Platform;
}

export function defaultContext(): ClientContext {
    return { home: homedir(), appData: process.env.APPDATA, platform: process.platform };
}

export class ClientError extends Error { }

interface ClientSpec {
    name: string;
    path(ctx: ClientContext): string;
    /** Clave del archivo que contiene los servidores. */
    container: "mcpServers" | "servers";
    withType: boolean;
}

function appSupport(ctx: ClientContext, app: string): string {
    if (ctx.platform === "win32") return join(ctx.appData ?? join(ctx.home, "AppData", "Roaming"), app);
    if (ctx.platform === "darwin") return join(ctx.home, "Library", "Application Support", app);
    return join(ctx.home, ".config", app);
}

const SPECS: Record<ClientId, ClientSpec> = {
    "claude-desktop": { name: "Claude Desktop", path: (ctx) => join(appSupport(ctx, "Claude"), "claude_desktop_config.json"), container: "mcpServers", withType: false },
    cursor: { name: "Cursor", path: (ctx) => join(ctx.home, ".cursor", "mcp.json"), container: "mcpServers", withType: false },
    vscode: { name: "VS Code", path: (ctx) => join(appSupport(ctx, "Code"), "User", "mcp.json"), container: "servers", withType: true },
};

export interface ClientStatus {
    id: ClientId;
    name: string;
    path: string;
    /** La carpeta de la aplicación existe; si no, no se escribe nada. */
    detected: boolean;
    connected: boolean;
    /** Motivo por el que no se puede editar el archivo, si lo hay. */
    problem?: string;
}

export interface ConnectResult {
    path: string;
    changed: boolean;
    backupPath?: string;
}

function serverEntry(spec: ClientSpec): Record<string, unknown> {
    // La ruta absoluta de node evita depender del PATH de una aplicación de escritorio.
    return { ...(spec.withType ? { type: "stdio" } : {}), command: process.execPath, args: selfCommand(["mcp"]).args };
}

function readConfig(path: string): { data: Record<string, unknown>; existed: boolean } {
    if (!existsSync(path)) return { data: {}, existed: false };
    const text = readFileSync(path, "utf-8");
    if (text.trim() === "") return { data: {}, existed: true };
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new ClientError("The configuration file is not plain JSON (it may contain comments), so it was not touched. Add the entry by hand.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ClientError("The configuration file is not a JSON object, so it was not touched.");
    return { data: parsed as Record<string, unknown>, existed: true };
}

function serversOf(data: Record<string, unknown>, spec: ClientSpec): Record<string, unknown> {
    const value = data[spec.container];
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ClientError(`"${spec.container}" in the configuration file is not an object, so it was not touched.`);
    }
    return { ...(value as Record<string, unknown>) };
}

function writeWithBackup(path: string, existed: boolean, data: Record<string, unknown>): string | undefined {
    const backupPath = existed ? `${path}.meruntime-backup-${Date.now()}` : undefined;
    if (backupPath) copyFileSync(path, backupPath);
    writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
    return backupPath;
}

export function listClients(ctx: ClientContext = defaultContext()): ClientStatus[] {
    return CLIENT_IDS.map((id) => {
        const spec = SPECS[id];
        const path = spec.path(ctx);
        const status: ClientStatus = { id, name: spec.name, path, detected: existsSync(dirname(path)), connected: false };
        if (!status.detected) return status;
        try {
            status.connected = serversOf(readConfig(path).data, spec).meruntime !== undefined;
        } catch (err) {
            status.problem = err instanceof ClientError ? err.message : "The configuration file could not be read.";
        }
        return status;
    });
}

export function connectClient(id: ClientId, ctx: ClientContext = defaultContext()): ConnectResult {
    const spec = SPECS[id];
    const path = spec.path(ctx);
    if (!existsSync(dirname(path))) throw new ClientError(`${spec.name} was not detected on this computer.`);

    const { data, existed } = readConfig(path);
    const servers = serversOf(data, spec);
    const entry = serverEntry(spec);
    if (JSON.stringify(servers.meruntime) === JSON.stringify(entry)) return { path, changed: false };

    servers.meruntime = entry;
    return { path, changed: true, backupPath: writeWithBackup(path, existed, { ...data, [spec.container]: servers }) };
}

export function disconnectClient(id: ClientId, ctx: ClientContext = defaultContext()): ConnectResult {
    const spec = SPECS[id];
    const path = spec.path(ctx);
    if (!existsSync(path)) return { path, changed: false };

    const { data } = readConfig(path);
    const servers = serversOf(data, spec);
    if (servers.meruntime === undefined) return { path, changed: false };

    delete servers.meruntime;
    return { path, changed: true, backupPath: writeWithBackup(path, true, { ...data, [spec.container]: servers }) };
}
