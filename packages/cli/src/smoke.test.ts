import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import packageMetadata from "../../../package.json";

// Prueba de humo del paquete real: npm pack, instalación en un directorio limpio y HOME temporal.
// Necesita red para instalar las dependencias (@modelcontextprotocol/sdk, zod).

const ROOT = join(import.meta.dirname, "..", "..", "..");
const TARBALL_INSTALL_TIMEOUT_MS = 120_000;
let work: string;
let home: string;
let installDir: string;
let cli: string;

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
    for (const key of Object.keys(env)) if (key.startsWith("MERUNTIME_")) delete env[key];
    return env;
}

function npm(args: string[], cwd: string, timeout?: number): string {
    const options = {
        cwd,
        env: cleanEnv(),
        encoding: "utf-8" as const,
        stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
        ...(timeout === undefined ? {} : { timeout }),
    };
    const npmCli = process.env.npm_execpath?.endsWith(".js")
        ? process.env.npm_execpath
        : join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(npmCli)) {
        throw new Error(`Cannot find npm's JavaScript CLI at ${npmCli}; refusing to spawn npm.cmd through Windows shell resolution.`);
    }
    try {
        return execFileSync(process.execPath, [npmCli, ...args], options);
    } catch (error) {
        const failure = error as { code?: string; stdout?: Buffer | string; stderr?: Buffer | string };
        if (failure.code !== "ETIMEDOUT" || timeout === undefined) throw error;
        const output = [failure.stdout, failure.stderr]
            .filter((chunk) => chunk !== undefined)
            .map((chunk) => chunk.toString().trim())
            .filter(Boolean)
            .join("\n");
        throw new Error(
            `npm ${args[0]} timed out after ${Math.round(timeout / 1000)} seconds using ${npmCli}. ` +
            `Check network/proxy access to registry.npmjs.org.${output ? ` npm output: ${output}` : ""}`,
            { cause: error },
        );
    }
}

function run(args: string[]): { code: number; out: string } {
    try {
        const out = execFileSync(process.execPath, [cli, ...args], {
            env: cleanEnv({ HOME: home, USERPROFILE: home }),
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, out };
    } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
}

function listFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]);
}

before(() => {
    work = mkdtempSync(join(tmpdir(), "meruntime-smoke-"));
    home = join(work, "home");
    installDir = join(work, "install");
    mkdirSync(home);
    mkdirSync(installDir);

    npm(["pack", "--pack-destination", work], ROOT);
    const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
    assert.ok(tarball, "npm pack produced a tarball");
    console.log(`tarball: ${tarball} (${statSync(join(work, tarball)).size} bytes)`);

    npm(["init", "-y"], installDir);
    npm(["install", join(work, tarball), "--no-audit", "--no-fund", "--loglevel=error"], installDir, TARBALL_INSTALL_TIMEOUT_MS);
    cli = join(installDir, "node_modules", "meruntime", "dist", "cli.js");
}, { timeout: 300_000 });

after(() => {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("el paquete instalado solo contiene lo publicable y no necesita tsx", () => {
    const packageDir = join(installDir, "node_modules", "meruntime");
    const files = listFiles(packageDir).map((f) => relative(packageDir, f).split("\\").join("/"));

    assert.ok(files.includes("dist/cli.js"));
    assert.ok(files.includes("examples/mandates/starter.json"));
    for (const file of files) {
        assert.equal(/\.test\.|secrets|\.meruntime|\.ts$|\.map$/.test(file), false, `unexpected file in package: ${file}`);
    }
    assert.equal(existsSync(join(installDir, "node_modules", "tsx")), false);
    assert.equal(existsSync(join(installDir, "node_modules", "typescript")), false);
});

test("--version y --help", () => {
    assert.deepEqual(run(["--version"]), { code: 0, out: `${packageMetadata.version}\n` });
    const help = run(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.out, /Commands:/);
    assert.match(help.out, /serve \[--port N\]/);
    assert.match(help.out, /token rotate/);
    assert.match(help.out, /hook claude/);
    assert.equal(run(["nope"]).code, 1);
});

test("init crea ~/.meruntime, no sobrescribe y doctor pasa", () => {
    const dir = join(home, ".meruntime");
    const first = run(["init"]);
    assert.equal(first.code, 0, first.out);
    for (const name of ["mandate.json", "secrets.json", "kill.json"]) assert.ok(existsSync(join(dir, name)), name);
    assert.match(first.out, /"command": "meruntime"/);
    assert.doesNotMatch(first.out, /npx/);
    assert.match(first.out, /mcpServers/);

    const mandate = JSON.parse(readFileSync(join(dir, "mandate.json"), "utf-8")) as { default: string };
    assert.equal(mandate.default, "deny");
    const secrets = JSON.parse(readFileSync(join(dir, "secrets.json"), "utf-8")) as { pendingHmacKey: string; protectedToken: string };
    assert.match(secrets.pendingHmacKey, /^[0-9a-f]{64}$/);
    assert.equal(secrets.protectedToken, "");

    const before = readFileSync(join(dir, "secrets.json"), "utf-8");
    const second = run(["init"]);
    assert.equal(second.code, 0);
    assert.match(second.out, /skipped/);
    assert.equal(readFileSync(join(dir, "secrets.json"), "utf-8"), before);

    const doctor = run(["doctor"]);
    assert.equal(doctor.code, 0, doctor.out);
    assert.match(doctor.out, /All checks passed/);
});

test("kill status / on / off y audit", () => {
    assert.match(run(["kill", "status"]).out, /kill: off/);
    assert.match(run(["kill", "on"]).out, /kill: on/);
    assert.match(run(["kill", "status"]).out, /kill: on/);
    assert.match(run(["kill", "off"]).out, /kill: off/);
    const audit = run(["audit", "--last", "5"]);
    assert.equal(audit.code, 0);
    assert.match(audit.out, /kill-on/);
});

test("doctor falla con un mandato inválido", () => {
    const mandatePath = join(home, ".meruntime", "mandate.json");
    const original = readFileSync(mandatePath, "utf-8");
    rmSync(mandatePath);
    const missing = run(["doctor"]);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /mandate\.json not found/);
    run(["init", "--force"]);
    assert.equal(readFileSync(mandatePath, "utf-8").trim(), original.trim());
});

test("mcp arranca desde el paquete instalado y responde a initialize", async () => {
    const child = spawn(process.execPath, [cli, "mcp"], {
        env: cleanEnv({ HOME: home, USERPROFILE: home }),
        stdio: ["pipe", "pipe", "inherit"],
    });
    try {
        const reply = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("mcp did not answer initialize")), 20_000);
            let buffer = "";
            child.stdout.on("data", (chunk: Buffer) => {
                buffer += chunk.toString("utf-8");
                if (buffer.includes("\n")) { clearTimeout(timer); resolve(buffer); }
            });
            child.on("error", reject);
            child.stdin.write(`${JSON.stringify({
                jsonrpc: "2.0", id: 1, method: "initialize",
                params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
            })}\n`);
        });
        const initialized = JSON.parse(reply) as { result?: { serverInfo?: { name?: string; version?: string } } };
        assert.equal(initialized.result?.serverInfo?.name, "meruntime-proxy");
        assert.equal(initialized.result?.serverInfo?.version, packageMetadata.version);
    } finally {
        child.kill();
    }
});

test("ui arranca desde el paquete instalado y sirve el estado con su token", async () => {
    const child = spawn(process.execPath, [cli, "ui", "--no-open"], {
        env: cleanEnv({ HOME: home, USERPROFILE: home }),
        stdio: ["ignore", "pipe", "inherit"],
    });
    try {
        const url = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("ui did not print its URL")), 20_000);
            let buffer = "";
            child.stdout.on("data", (chunk: Buffer) => {
                buffer += chunk.toString("utf-8");
                const match = /Open this URL in a browser: (\S+)/.exec(buffer);
                if (match) { clearTimeout(timer); resolve(match[1]); }
            });
            child.on("error", reject);
        });
        const [base, token] = url.split("#t=");

        const page = await fetch(base);
        assert.equal(page.status, 200);
        assert.equal((await fetch(`${base}api/status`)).status, 401);
        const status = await (await fetch(`${base}api/status`, { headers: { "x-meruntime-token": token } })).json() as { state: string; killOn: boolean };
        assert.equal(status.state, "protected");
        assert.equal(status.killOn, false);
    } finally {
        child.kill();
    }
});
