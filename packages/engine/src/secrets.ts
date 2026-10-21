import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic, withFileLock } from "./fsAtomic.js";
import { MERUNTIME_DIR } from "./paths.js";

const DEFAULT_SECRETS_PATH = join(MERUNTIME_DIR, "secrets.json");

interface SecretsFile {
    protectedToken?: string;
    githubToken?: string;
    pendingHmacKey?: string;
    [key: string]: unknown;
}

export function getDefaultSecretsPath(): string {
    return DEFAULT_SECRETS_PATH;
}

export function getSecretsPath(): string {
    return process.env.MERUNTIME_SECRETS ?? DEFAULT_SECRETS_PATH;
}

export function readProtectedToken(secretsPath = process.env.MERUNTIME_SECRETS ?? DEFAULT_SECRETS_PATH): string {
    if (!existsSync(secretsPath)) {
        throw new Error(`Protected resource credentials not found at ${secretsPath}.`);
    }

    const secrets = JSON.parse(readFileSync(secretsPath, "utf-8")) as SecretsFile;
    if (typeof secrets.protectedToken !== "string" || secrets.protectedToken.length === 0) {
        throw new Error("secrets.json must contain a non-empty protectedToken.");
    }
    return secrets.protectedToken;
}

export function readGithubToken(secretsPath = process.env.MERUNTIME_SECRETS ?? DEFAULT_SECRETS_PATH): string | undefined {
    if (!existsSync(secretsPath)) return undefined;

    const secrets = JSON.parse(readFileSync(secretsPath, "utf-8")) as SecretsFile;
    return typeof secrets.githubToken === "string" && secrets.githubToken.length > 0
        ? secrets.githubToken
        : undefined;
}

export function readPendingHmacKey(secretsPath = process.env.MERUNTIME_SECRETS ?? DEFAULT_SECRETS_PATH): Buffer {
    const hex = getOrCreateSecret(
        secretsPath,
        "pendingHmacKey",
        () => randomBytes(32).toString("hex"),
        (value) => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value),
    );
    return Buffer.from(hex, "hex");
}

/** Token del banco de prueba; solo lo leen el CORE y el propio banco. Se crea si no existe. */
export function readFakeBankToken(secretsPath = process.env.MERUNTIME_SECRETS ?? DEFAULT_SECRETS_PATH): string {
    return getOrCreateSecret(
        secretsPath,
        "fakeBankToken",
        () => randomBytes(24).toString("hex"),
        (value) => typeof value === "string" && value.length > 0,
    );
}

function readSecretsObject(secretsPath: string): SecretsFile {
    if (!existsSync(secretsPath)) return {};
    const parsed: unknown = JSON.parse(readFileSync(secretsPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("secrets.json must contain a JSON object.");
    }
    return parsed as SecretsFile;
}

function getOrCreateSecret(secretsPath: string, field: string, make: () => string, isValid: (value: unknown) => boolean): string {
    const fromFile = (secrets: SecretsFile): string | undefined => {
        const value = secrets[field];
        if (value === undefined) return undefined;
        if (!isValid(value)) throw new Error(`secrets.json contains an invalid ${field}.`);
        return value as string;
    };

    const existing = fromFile(readSecretsObject(secretsPath));
    if (existing !== undefined) return existing;

    // El lock evita que dos procesos que crean secretos distintos se pisen la escritura.
    return withFileLock(`${secretsPath}.lock`, () => {
        const secrets = readSecretsObject(secretsPath);
        const current = fromFile(secrets);
        if (current !== undefined) return current;
        const created = make();
        secrets[field] = created;
        writeFileAtomic(secretsPath, JSON.stringify(secrets, null, 2), 0o600);
        return created;
    });
}
