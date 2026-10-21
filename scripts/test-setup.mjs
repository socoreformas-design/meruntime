// Precarga de los tests: aísla el estado de ~/.meruntime y fija un mandato por defecto.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "meruntime-test-home-"));
process.env.MERUNTIME_HOME = home;
process.env.MERUNTIME_MANDATE = fileURLToPath(new URL("../examples/mandates/personal.json", import.meta.url));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
