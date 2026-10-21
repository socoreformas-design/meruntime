// Crea el estado inicial (~/.meruntime): lo comparten `meruntime init` y el asistente de la interfaz.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fsAtomic.js";
import { getKillPath } from "./kill.js";
import { MERUNTIME_DIR } from "./paths.js";
import { buildMandate, type ProfileId, type ProfileOptions } from "./profiles.js";
import { getSecretsPath } from "./secrets.js";

export interface SetupFileResult {
    name: string;
    path: string;
    status: "created" | "replaced" | "skipped";
}

/** Sin `force`, nunca sobrescribe un archivo existente. Lanza si las opciones del perfil no son válidas. */
export function initializeState(profile: ProfileId, options: ProfileOptions = {}, force = false): SetupFileResult[] {
    const mandate = buildMandate(profile, options);

    mkdirSync(MERUNTIME_DIR, { recursive: true, mode: 0o700 });
    const files = [
        { name: "mandate.json", path: join(MERUNTIME_DIR, "mandate.json"), data: JSON.stringify(mandate, null, 4) },
        {
            name: "secrets.json",
            path: getSecretsPath(),
            data: JSON.stringify({ protectedToken: "", githubToken: "", pendingHmacKey: randomBytes(32).toString("hex") }, null, 2),
        },
        { name: "kill.json", path: getKillPath(), data: JSON.stringify({ on: false }, null, 2) },
    ];

    return files.map((file): SetupFileResult => {
        const existed = existsSync(file.path);
        if (existed && !force) return { name: file.name, path: file.path, status: "skipped" };
        // 0o600 se ignora en Windows; allí la protección es la ACL del perfil de usuario.
        writeFileAtomic(file.path, `${file.data}\n`, 0o600);
        return { name: file.name, path: file.path, status: existed ? "replaced" : "created" };
    });
}
