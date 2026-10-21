// meruntime doctor: comprueba el entorno y los archivos de configuración.

import { checkSetup } from "../../engine/src/health.js";

export function runDoctor(): number {
    const { stateDir, checks } = checkSetup();
    let failures = 0;
    for (const check of checks) {
        if (check.level === "fail") failures++;
        console.log(`[${check.level}] ${check.message}`);
        if (check.message.startsWith("Node ")) console.log(`      state directory: ${stateDir}`);
    }
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
    return failures === 0 ? 0 : 1;
}
