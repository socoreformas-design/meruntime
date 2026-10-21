import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import type { Intent, Mandate, Verdict } from "../../schema/src/index.js";

interface WebResult {
    verdict: Verdict;
    reason: string;
    rule?: string;
}

interface WebExamples {
    mandates: Array<{ id: string; label: string; mandate: Mandate }>;
    intents: Array<{ id: string; label: string; intent: Intent }>;
}

interface WebRuntime {
    version: string;
    evaluate(mandate: object, intent: object, options?: { now?: string }): WebResult;
    examples: WebExamples;
}

test("browser bundle cumple el contrato, rechaza entradas inválidas y coincide con los golden cases", async () => {
    const result = await build({
        entryPoints: ["packages/web/src/entry.ts"],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: ["es2020"],
        minify: true,
        logLevel: "silent",
    });
    const bundle = result.outputFiles[0].text;

    assert.equal(bundle.includes("secrets"), false);
    assert.equal(bundle.includes("readFileSync"), false);
    assert.equal(bundle.includes("fetch("), false);

    const browserWindow: { MeRuntime?: WebRuntime } = {};
    runInNewContext(bundle, { window: browserWindow, URL });
    const runtime = browserWindow.MeRuntime!;
    assert.deepEqual(Object.keys(runtime).sort(), ["evaluate", "examples", "version"]);
    const packageJson = JSON.parse(readFileSync("package.json", "utf-8")) as { version: string };
    assert.equal(runtime.version, packageJson.version);
    assert.deepEqual(Array.from(runtime.examples.mandates, ({ id, label }) => ({ id, label })), [
        { id: "personal", label: "Personal" },
    ]);
    assert.deepEqual(Array.from(runtime.examples.intents, ({ id, label }) => ({ id, label })), [
        { id: "borrar-archivo", label: "Borrar un archivo" },
        { id: "lectura-github", label: "Leer GitHub" },
        { id: "pago-200", label: "Pagar 200 €" },
    ]);

    const personal = runtime.examples.mandates[0].mandate;
    const deleteFile = runtime.examples.intents[0].intent;
    const githubRead = runtime.examples.intents[1].intent;
    const payment = runtime.examples.intents[2].intent;
    const now = "2026-01-15T12:00:00.000Z";
    const goldenCases: Array<{ mandate: Mandate; intent: Intent; expected: Verdict; now?: string }> = [
        { mandate: personal, intent: payment, expected: "RED" },
        { mandate: personal, intent: githubRead, expected: "GREEN" },
        { mandate: { ...personal, killSwitch: true }, intent: githubRead, expected: "RED" },
        { mandate: personal, intent: { ...githubRead, effects: [] }, expected: "RED" },
        {
            mandate: {
                version: "1",
                userId: "test",
                default: "deny",
                quietHours: { startHour: 22, endHour: 7 },
                rules: [{ effect: "allow", action: "send", tool: "http.request" }],
            },
            intent: { ...githubRead, action: "send" },
            expected: "YELLOW",
            now: new Date(2026, 0, 15, 23, 0, 0).toISOString(),
        },
        { mandate: personal, intent: deleteFile, expected: "RED" },
        {
            mandate: { ...personal, denyHosts: ["blocked.example"] },
            intent: { ...githubRead, target: "https://blocked.example/resource" },
            expected: "RED",
        },
        { mandate: { ...personal, rules: [] }, intent: githubRead, expected: "RED" },
    ];

    for (const goldenCase of goldenCases) {
        const result = runtime.evaluate(goldenCase.mandate, goldenCase.intent, { now: goldenCase.now ?? now });
        assert.equal(result.verdict, goldenCase.expected);
        assert.ok(result.reason.trim().length > 0);
    }

    const paymentResult = runtime.evaluate(personal, payment, { now });
    assert.equal(paymentResult.reason, "Supera perTxEur (40 €)");
    assert.equal(paymentResult.rule, "ceilings.perTxEur");

    const invalidInput = runtime.evaluate(null as unknown as object, null as unknown as object);
    assert.equal(invalidInput.verdict, "RED");
    assert.match(invalidInput.reason, /^Entrada no válida:/);
});