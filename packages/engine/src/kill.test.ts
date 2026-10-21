import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { evaluate } from "./evaluate.js";
import { applyKillSwitch, writeKillSwitch, KILL_PATH } from "./kill.js";
import type { Intent, Mandate } from "../../schema/src/index.js";

const mandate: Mandate = {
    version: "1",
    userId: "demo",
    default: "deny",
    allowHosts: ["api.github.com"],
    rules: [{ effect: "allow", action: "read", tool: "http.request" }],
};

const intent: Intent = {
    agentId: "demo-agent",
    action: "read",
    tool: "http.request",
    target: "https://api.github.com",
    effects: [{ kind: "read", reversible: true }],
};

afterEach(() => {
    if (existsSync(KILL_PATH)) unlinkSync(KILL_PATH);
});

test("kill off + lectura github → GREEN", () => {
    writeKillSwitch(false);
    assert.equal(evaluate(applyKillSwitch(mandate), intent, new Date()), "GREEN");
});

test("kill on + misma lectura → RED y no ejecuta", () => {
    writeKillSwitch(true);
    assert.equal(evaluate(applyKillSwitch(mandate), intent, new Date()), "RED");
});

test("kill.json ausente o inválido bloquea por defecto", () => {
    if (existsSync(KILL_PATH)) unlinkSync(KILL_PATH);
    assert.equal(applyKillSwitch(mandate).killSwitch, true);

    for (const contents of ['{"on": tru', '{"on":"true"}', '{}', '[]']) {
        writeFileSync(KILL_PATH, contents, "utf-8");
        assert.equal(applyKillSwitch(mandate).killSwitch, true, contents);
    }
});
