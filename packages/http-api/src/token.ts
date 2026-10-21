import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { resolveMeruntimeDir } from "../../engine/src/paths.js";
import { withFileLock } from "../../engine/src/fsAtomic.js";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function getApiTokenPath(): string {
    return join(resolveMeruntimeDir(), "api-token");
}

function currentWindowsSid(): string {
    const whoami = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
    const output = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf-8",
        windowsHide: true,
    });
    const sid = output.match(/S-1-(?:\d+-)+\d+/)?.[0];
    if (!sid) throw new Error("Could not determine the current Windows user SID.");
    return sid;
}

function applyWindowsDacl(path: string): void {
    const sid = currentWindowsSid();
    try {
        for (const args of [[path, "/reset"], [path, "/inheritance:r"], [path, "/grant:r", `*${sid}:(F)`]]) {
            execFileSync("icacls.exe", args, {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        }
    } catch (error) {
        const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
        throw new Error(`Could not secure the API token with a Windows DACL.${stderr ? ` ${stderr}` : ""}`);
    }
}

function secureFile(path: string): void {
    if (process.platform === "win32") applyWindowsDacl(path);
    else chmodSync(path, 0o600);
}

function assertRegularFile(path: string): void {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("API token path must be a regular file, not a symlink.");
}

function readExistingToken(path: string): string {
    assertRegularFile(path);
    secureFile(path);
    const token = readFileSync(path, "utf-8");
    if (!TOKEN_PATTERN.test(token)) throw new Error("API token file is invalid; use `meruntime token rotate` to replace it.");
    return token;
}

function writeTokenAtomically(path: string, token: string): void {
    const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    let descriptor: number | undefined;
    try {
        descriptor = openSync(temporaryPath, "wx", 0o600);
        // On Windows, secure the empty file before writing any token bytes.
        secureFile(temporaryPath);
        writeSync(descriptor, token, undefined, "utf-8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporaryPath, path);
    } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        try { unlinkSync(temporaryPath); } catch { /* temporary file may not exist */ }
        throw error;
    }
}

function withTokenLock<T>(fn: (path: string) => T): T {
    const directory = resolveMeruntimeDir();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    const path = join(directory, "api-token");
    return withFileLock(`${path}.lock`, () => fn(path));
}

export function ensureApiToken(): string {
    return withTokenLock((path) => {
        if (existsSync(path)) return readExistingToken(path);
        const token = randomBytes(32).toString("hex");
        writeTokenAtomically(path, token);
        return token;
    });
}

export function readApiToken(): string {
    const path = getApiTokenPath();
    try {
        assertRegularFile(path);
        const token = readFileSync(path, "utf-8");
        if (!TOKEN_PATTERN.test(token)) throw new Error("API token file is invalid.");
        return token;
    } catch (error) {
        if (error instanceof Error && error.message === "API token file is invalid.") throw error;
        throw new Error("API token file is unavailable.");
    }
}

export function rotateApiToken(): void {
    withTokenLock((path) => {
        if (existsSync(path)) assertRegularFile(path);
        writeTokenAtomically(path, randomBytes(32).toString("hex"));
    });
}