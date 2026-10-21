import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** MERUNTIME_HOME permite mover todo el estado (tests, instalaciones aisladas). */
export function resolveMeruntimeDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
    return env.MERUNTIME_HOME ? env.MERUNTIME_HOME : join(home, ".meruntime");
}

export const MERUNTIME_DIR = resolveMeruntimeDir();

/** Carpeta examples/ tanto desde el paquete compilado (dist/) como desde el código fuente. */
export function findExamplesDir(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [join(here, "..", "examples"), join(here, "..", "..", "..", "examples")]) {
        if (existsSync(join(candidate, "mandates"))) return candidate;
    }
    throw new Error("Could not locate the bundled examples/ directory.");
}