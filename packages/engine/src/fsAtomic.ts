import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

const RETRYABLE_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
export const LOCK_WAIT_MS = 1_000;

export class FileLockTimeoutError extends Error {
    constructor(readonly lockPath: string) {
        super(`Timed out waiting for lock ${lockPath}.`);
        this.name = "FileLockTimeoutError";
    }
}

export function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Escribe en un temporal del mismo directorio y hace rename: un lector nunca ve un archivo a medias. */
export function writeFileAtomic(path: string, data: string, mode?: number): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, data, { encoding: "utf-8", mode });
    try {
        for (let attempt = 0; ; attempt++) {
            try {
                renameSync(tmp, path);
                return;
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                // En Windows el rename puede fallar si un lector tiene el destino abierto un instante.
                if (attempt >= 100 || !code || !RETRYABLE_RENAME.has(code)) throw err;
                sleepSync(5);
            }
        }
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* ya no existe */ }
        throw err;
    }
}

interface LockOwner {
    pid: number;
    createdAt: string;
}

function processExists(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

function createLock(lockPath: string): boolean {
    const temporaryPath = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const owner: LockOwner = { pid: process.pid, createdAt: new Date().toISOString() };
    writeFileSync(temporaryPath, JSON.stringify(owner), { encoding: "utf-8", flag: "wx", mode: 0o600 });
    try {
        linkSync(temporaryPath, lockPath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return false;
    } finally {
        try { unlinkSync(temporaryPath); } catch { /* the temporary lock may already be gone */ }
    }
}

/** A lock is reclaimed only when its recorded owner process no longer exists. */
function removeDeadOwnerLock(lockPath: string): boolean {
    try {
        const contents = readFileSync(lockPath, "utf-8");
        const owner = JSON.parse(contents) as Partial<LockOwner>;
        if (typeof owner.pid !== "number" || typeof owner.createdAt !== "string" || processExists(owner.pid)) return false;
        const stats = statSync(lockPath);
        if (readFileSync(lockPath, "utf-8") !== contents) return false;
        const currentStats = statSync(lockPath);
        if (stats.dev !== currentStats.dev || stats.ino !== currentStats.ino) return false;
        unlinkSync(lockPath);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
}

/** Exclusión mutua entre procesos mediante un lock file con propietario PID. */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
    mkdirSync(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (; ;) {
        try {
            if (createLock(lockPath)) break;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
        removeDeadOwnerLock(lockPath);
        if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath);
        sleepSync(5);
    }
    try {
        return fn();
    } finally {
        try { unlinkSync(lockPath); } catch { /* ya liberado */ }
    }
}
