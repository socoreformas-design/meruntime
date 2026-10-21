import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../../engine/src/fsAtomic.js";
import { resolveMeruntimeDir } from "../../engine/src/paths.js";
import { DEFAULT_HTTP_API_PORT, startHttpApiServer } from "../../http-api/src/server.js";
import { ensureApiToken, readApiToken } from "../../http-api/src/token.js";

function parsePort(args: string[]): number | undefined {
    if (args.length === 0) return DEFAULT_HTTP_API_PORT;
    if (args.length !== 2 || args[0] !== "--port") return undefined;
    const port = Number(args[1]);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function lockPath(): string {
    return join(resolveMeruntimeDir(), "serve.lock");
}

function processIsAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

function acquireServeLock(path: string): void {
    mkdirSync(resolveMeruntimeDir(), { recursive: true, mode: 0o700 });
    withFileLock(`${path}.mutex`, () => {
        if (existsSync(path)) {
            let pid: number;
            try {
                pid = Number(readFileSync(path, "utf-8"));
            } catch {
                throw new Error(`Cannot read ${path}; verify no meruntime serve process is running before removing this lock.`);
            }
            if (!Number.isSafeInteger(pid) || pid <= 0) {
                throw new Error(`The meruntime serve lock at ${path} is invalid; verify no service is running before removing it.`);
            }
            if (processIsAlive(pid)) throw new Error(`Another meruntime serve instance is already running (PID ${pid}).`);
            unlinkSync(path);
        }
        writeFileSync(path, String(process.pid), { encoding: "utf-8", flag: "wx", mode: 0o600 });
    });
}

function releaseServeLock(path: string): void {
    try {
        if (Number(readFileSync(path, "utf-8")) === process.pid) unlinkSync(path);
    } catch {
        // The lock may have been removed during shutdown.
    }
}

export async function runServe(args: string[]): Promise<number | undefined> {
    const port = parsePort(args);
    if (port === undefined) {
        console.error("Usage: meruntime serve [--port N] (N must be 1-65535)");
        return 1;
    }

    const path = lockPath();
    let api: Awaited<ReturnType<typeof startHttpApiServer>> | undefined;
    try {
        ensureApiToken();
        acquireServeLock(path);
        api = await startHttpApiServer({ port, token: readApiToken });
    } catch (error) {
        releaseServeLock(path);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE") {
            console.error(`Cannot start meruntime serve: 127.0.0.1:${port} is already in use.`);
        } else {
            console.error(error instanceof Error ? error.message : "Could not start meruntime serve.");
        }
        return 1;
    }

    let closing = false;
    const shutdown = (signal: NodeJS.Signals) => {
        if (closing) return;
        closing = true;
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        void api!.close().finally(() => {
            releaseServeLock(path);
            process.exitCode = signal === "SIGINT" ? 130 : 143;
        });
    };
    const onSigint = () => shutdown("SIGINT");
    const onSigterm = () => shutdown("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    console.log(`Me Runtime HTTP API listening at http://127.0.0.1:${port} (Ctrl+C to stop)`);
    return undefined;
}