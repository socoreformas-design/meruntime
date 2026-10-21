// Compila la CLI a un único dist/cli.js; las dependencias (MCP SDK, zod) quedan como externas.
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const outfile = `${root}dist/cli.js`;

await build({
    absWorkingDir: root,
    entryPoints: ["packages/cli/src/cli.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    legalComments: "none",
});
chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
