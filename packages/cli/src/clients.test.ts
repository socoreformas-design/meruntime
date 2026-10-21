import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClientError, connectClient, disconnectClient, listClients, type ClientContext } from "./clients.js";
import { runConnect } from "./connect.js";

let root: string;
let ctx: ClientContext;

const claudeDir = () => join(root, ".config", "Claude");
const claudeFile = () => join(claudeDir(), "claude_desktop_config.json");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
const backups = (dir: string) => readdirSync(dir).filter((f) => f.includes(".meruntime-backup-"));

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "meruntime-clients-"));
    ctx = { home: root, platform: "linux" };
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

test("rutas de configuración por sistema operativo", () => {
    const paths = (c: ClientContext) => Object.fromEntries(listClients(c).map((x) => [x.id, x.path]));

    assert.deepEqual(paths({ home: "H", platform: "linux" }), {
        "claude-desktop": join("H", ".config", "Claude", "claude_desktop_config.json"),
        cursor: join("H", ".cursor", "mcp.json"),
        vscode: join("H", ".config", "Code", "User", "mcp.json"),
    });
    assert.equal(paths({ home: "H", platform: "darwin" })["claude-desktop"], join("H", "Library", "Application Support", "Claude", "claude_desktop_config.json"));
    assert.equal(paths({ home: "H", appData: "A", platform: "win32" }).vscode, join("A", "Code", "User", "mcp.json"));
    assert.equal(paths({ home: "H", platform: "win32" })["claude-desktop"], join("H", "AppData", "Roaming", "Claude", "claude_desktop_config.json"));
});

test("sin la aplicación instalada no escribe nada", () => {
    assert.equal(listClients(ctx).every((c) => !c.detected && !c.connected), true);
    assert.throws(() => connectClient("claude-desktop", ctx), ClientError);
    assert.equal(existsSync(claudeDir()), false);
});

test("conecta creando el archivo si no existe, sin copia de seguridad", () => {
    mkdirSync(claudeDir(), { recursive: true });

    const result = connectClient("claude-desktop", ctx);

    assert.equal(result.changed, true);
    assert.equal(result.backupPath, undefined);
    const entry = readJson(claudeFile()).mcpServers.meruntime;
    assert.equal(entry.command, process.execPath);
    assert.ok(entry.args.includes("mcp"));
    assert.equal(entry.type, undefined);
    assert.equal(listClients(ctx).find((c) => c.id === "claude-desktop")?.connected, true);
});

test("conserva los demás servidores y claves, hace copia exacta y es idempotente", () => {
    mkdirSync(claudeDir(), { recursive: true });
    const original = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x", args: ["1"] } } }, null, 2);
    writeFileSync(claudeFile(), original, "utf-8");

    const first = connectClient("claude-desktop", ctx);
    const config = readJson(claudeFile());

    assert.equal(first.changed, true);
    assert.deepEqual(config.mcpServers.other, { command: "x", args: ["1"] });
    assert.equal(config.theme, "dark");
    assert.ok(config.mcpServers.meruntime);
    assert.equal(readFileSync(first.backupPath!, "utf-8"), original);

    const second = connectClient("claude-desktop", ctx);
    assert.equal(second.changed, false);
    assert.equal(backups(claudeDir()).length, 1);
});

test("VS Code usa 'servers' con type stdio", () => {
    mkdirSync(join(root, ".config", "Code", "User"), { recursive: true });

    connectClient("vscode", ctx);

    const entry = readJson(join(root, ".config", "Code", "User", "mcp.json")).servers.meruntime;
    assert.equal(entry.type, "stdio");
    assert.equal(entry.command, process.execPath);
});

test("un archivo que no es JSON simple o con estructura rara no se toca", () => {
    mkdirSync(claudeDir(), { recursive: true });
    const withComments = "{\n  // comment\n  \"mcpServers\": {}\n}";
    writeFileSync(claudeFile(), withComments, "utf-8");

    assert.throws(() => connectClient("claude-desktop", ctx), /not plain JSON/);
    assert.equal(readFileSync(claudeFile(), "utf-8"), withComments);
    assert.match(listClients(ctx).find((c) => c.id === "claude-desktop")?.problem ?? "", /not plain JSON/);

    writeFileSync(claudeFile(), JSON.stringify({ mcpServers: ["nope"] }), "utf-8");
    assert.throws(() => connectClient("claude-desktop", ctx), /not an object/);
    assert.equal(backups(claudeDir()).length, 0);
});

test("desconecta solo su entrada, con copia de seguridad", () => {
    mkdirSync(claudeDir(), { recursive: true });
    writeFileSync(claudeFile(), JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf-8");
    connectClient("claude-desktop", ctx);

    const result = disconnectClient("claude-desktop", ctx);

    assert.equal(result.changed, true);
    assert.deepEqual(readJson(claudeFile()).mcpServers, { other: { command: "x" } });
    assert.ok(result.backupPath && existsSync(result.backupPath));
    assert.equal(disconnectClient("claude-desktop", ctx).changed, false);
    assert.equal(dirname(result.path), claudeDir());
});

test("meruntime connect valida sus argumentos", () => {
    const log = console.log;
    const error = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
        assert.equal(runConnect(["--bogus"]), 1);
        assert.equal(runConnect(["nope"]), 1);
        assert.equal(runConnect(["--remove"]), 1);
        assert.equal(runConnect(["cursor", "vscode"]), 1);
        assert.equal(runConnect(["--list"]), 0);
    } finally {
        console.log = log;
        console.error = error;
    }
});
