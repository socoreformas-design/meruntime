import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MERUNTIME_DIR } from "../../engine/src/paths.js";
import { setMandatePathForTests } from "../../engine/src/policy.js";
import { checkSetup } from "../../engine/src/health.js";
import { buildMandate } from "../../engine/src/profiles.js";
import { runDoctor } from "./doctor.js";
import { mcpConfigs, runInit } from "./init.js";

const mandatePath = join(MERUNTIME_DIR, "mandate.json");
const originalLog = console.log;
const originalError = console.error;
let errors: string[];

beforeEach(() => {
    errors = [];
    console.log = () => undefined;
    console.error = (message: string) => { errors.push(String(message)); };
    for (const name of ["mandate.json", "secrets.json", "kill.json"]) rmSync(join(MERUNTIME_DIR, name), { force: true });
});

afterEach(() => {
    setMandatePathForTests(undefined);
    console.log = originalLog;
    console.error = originalError;
});

test("init usa el perfil elegido y sus opciones", () => {
    const code = runInit(["--profile", "payments-known", "--limit", "30", "--iban", "ES00 DEMO 0000 0000 0000 0001", "--host", "example.org"]);

    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(readFileSync(mandatePath, "utf-8")), buildMandate("payments-known", {
        perTxEur: 30, knownIbans: ["ES00 DEMO 0000 0000 0000 0001"], allowHosts: ["example.org"],
    }));
});

test("init sin opciones crea el perfil 'pagos con mi aprobación'", () => {
    assert.equal(runInit([]), 0);
    assert.deepEqual(JSON.parse(readFileSync(mandatePath, "utf-8")), buildMandate("payments-ask"));
    assert.deepEqual(mcpConfigs().claudeAndCursor, { mcpServers: { meruntime: { command: "meruntime", args: ["mcp"] } } });
    assert.deepEqual(mcpConfigs().vscode, { servers: { meruntime: { type: "stdio", command: "meruntime", args: ["mcp"] } } });
});

test("init rechaza perfiles u opciones que no encajan y no escribe nada", () => {
    for (const args of [
        ["--profile", "nope"],
        ["--profile", "read-only", "--limit", "10"],
        ["--profile", "payments-ask", "--iban", "ES00"],
        ["--profile", "blocked", "--host", "example.org"],
        ["--profile", "payments-ask", "--limit", "-5"],
        ["--unknown"],
    ]) {
        assert.equal(runInit(args), 1, args.join(" "));
    }
    assert.equal(errors.length, 6);
    assert.throws(() => readFileSync(mandatePath, "utf-8"), /ENOENT/);
});

test("doctor falla ante una clave desconocida en mandate.json", () => {
    runInit([]);
    setMandatePathForTests(mandatePath);
    const mandate = JSON.parse(readFileSync(mandatePath, "utf-8")) as Record<string, unknown>;
    (mandate.ceilings as Record<string, unknown>).dailySpendEUR = 200;
    writeFileSync(mandatePath, JSON.stringify(mandate), "utf-8");

    assert.equal(runDoctor(), 1);
});

test("doctor falla ante claves duplicadas en mandate.json", () => {
    runInit([]);
    setMandatePathForTests(mandatePath);
    writeFileSync(mandatePath, '{"version":"1","userId":"me","default":"deny","rules":[],"rules":[]}', "utf-8");

    assert.equal(runDoctor(), 1);
});

test("doctor falla ante techos y timeout con precisión fraccionaria", () => {
    runInit([]);
    setMandatePathForTests(mandatePath);
    const mandate = JSON.parse(readFileSync(mandatePath, "utf-8")) as Record<string, unknown>;
    (mandate.ceilings as Record<string, unknown>).dailySpendEur = 0.004;
    mandate.approvalTimeoutMs = 1.5;
    writeFileSync(mandatePath, JSON.stringify(mandate), "utf-8");

    assert.equal(runDoctor(), 1);
});

test("doctor advierte cuando MERUNTIME_MANDATE redirige la configuración", () => {
    const previousMandateEnv = process.env.MERUNTIME_MANDATE;
    try {
        runInit([]);
        setMandatePathForTests(mandatePath);
        process.env.MERUNTIME_MANDATE = mandatePath;
        assert.ok(checkSetup().checks.some((check) => check.level === "warn" && check.message.includes("MERUNTIME_MANDATE override active")));
    } finally {
        if (previousMandateEnv === undefined) delete process.env.MERUNTIME_MANDATE;
        else process.env.MERUNTIME_MANDATE = previousMandateEnv;
    }
});
