// Cómo relanzar esta misma CLI en un subproceso, tanto compilada (dist/cli.js) como desde el código fuente.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const fromSource = here.endsWith(".ts");

export function selfCommand(args: string[]): { command: string; args: string[] } {
    if (fromSource) {
        return { command: process.execPath, args: ["--import", "tsx", join(dirname(here), "cli.ts"), ...args] };
    }
    return { command: process.execPath, args: [here, ...args] };
}
