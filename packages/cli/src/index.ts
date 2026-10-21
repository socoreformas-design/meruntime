// CLI mínimo: lee un mandato y un intent desde JSON y muestra el veredicto.
// Uso: npm run eval -- --mandate <ruta.json> --intent <ruta.json>

import { readFileSync } from "node:fs";
import { evaluate } from "../../engine/src/evaluate.js";
import type { Intent, Mandate } from "../../schema/src/index.js";

function parseArgs(argv: string[]): { mandate?: string; intent?: string } {
    const args: { mandate?: string; intent?: string } = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--mandate") args.mandate = argv[++i];
        if (argv[i] === "--intent") args.intent = argv[++i];
    }
    return args;
}

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
}

const { mandate: mandatePath, intent: intentPath } = parseArgs(process.argv.slice(2));

if (!mandatePath || !intentPath) {
    console.error("Uso: --mandate <ruta.json> --intent <ruta.json>");
    process.exit(1);
}

const mandate = readJson<Mandate>(mandatePath);
const intent = readJson<Intent>(intentPath);

console.log(evaluate(mandate, intent, new Date()));
