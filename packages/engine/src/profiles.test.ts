import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { intentFromPayment } from "../../proxy/src/intentFromTool.js";
import type { Intent, Mandate } from "../../schema/src/index.js";
import { validateMandate } from "../../schema/src/index.js";
import { parseJsonWithUniqueKeys } from "../../schema/src/json.js";
import { evaluate, explainEvaluate } from "./evaluate.js";
import { describeAction, explainRule } from "./explain.js";
import { PROFILE_IDS, buildMandate } from "./profiles.js";

const KNOWN = "ES00 DEMO 0000 0000 0000 0001";
const OTHER = "ES00 EVIL 0000 0000 0000 0666";
const now = new Date("2026-10-02T12:00:00Z");

const pay = (iban: string, amountEur: number) => intentFromPayment({ agentId: "agent", iban, amountEur, concept: "x" });
const http = (action: "read" | "write", host: string): Intent => ({
    agentId: "agent", action, tool: "http.request", target: `https://${host}/path`,
    effects: [{ kind: action, reversible: action === "read" }],
});
const verdict = (mandate: Mandate, intent: Intent) => evaluate(mandate, intent, now);

test("todos los perfiles generan un mandato válido para el schema", () => {
    for (const id of PROFILE_IDS) assert.deepEqual(validateMandate(buildMandate(id)), [], id);
});

test("mandato estricto rechaza claves desconocidas, dailySpendEur inválido y timezone inválido", () => {
    const mandate = buildMandate("payments-known");
    assert.ok(validateMandate({ ...mandate, ceilings: { ...mandate.ceilings, dailySpendEUR: 200 } }).some((error) => error.includes("dailySpendEUR")));
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.ok(validateMandate({ ...mandate, ceilings: { ...mandate.ceilings, dailySpendEur: value } }).some((error) => error.includes("dailySpendEur")));
    }
    assert.ok(validateMandate({ ...mandate, timezone: "Mars/Olympus" }).some((error) => error.includes("timezone")));
    for (const key of ["rateLimitPerSecond", "maxPendingRequests"] as const) {
        for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            assert.ok(validateMandate({ ...mandate, [key]: value }).some((error) => error.includes(key)));
        }
    }
    assert.deepEqual(validateMandate({ ...mandate, rateLimitPerSecond: 20, maxPendingRequests: 50 }), []);
    assert.ok(validateMandate({ ...mandate, extraPolicy: true }).some((error) => error.includes("extraPolicy")));
});

test("mandato exige techos con precisión de céntimos y timeout entero", () => {
    const mandate = buildMandate("payments-known");
    assert.ok(validateMandate({ ...mandate, ceilings: { ...mandate.ceilings, perTxEur: 50.005 } }).some((error) => error.includes("perTxEur")));
    assert.ok(validateMandate({ ...mandate, ceilings: { ...mandate.ceilings, dailySpendEur: 0.004 } }).some((error) => error.includes("dailySpendEur")));
    assert.ok(validateMandate({ ...mandate, approvalTimeoutMs: 1.5 }).some((error) => error.includes("approvalTimeoutMs")));
    assert.deepEqual(validateMandate({ ...mandate, ceilings: { perTxEur: 50, dailySpendEur: 0.01 }, approvalTimeoutMs: 1 }), []);
});

test("parser del mandato rechaza claves duplicadas incluso con escapes", () => {
    assert.throws(() => parseJsonWithUniqueKeys('{"dailySpendEur":200,"dailySpendEur":99999}'), /Duplicate JSON object key.*dailySpendEur/);
    assert.throws(() => parseJsonWithUniqueKeys('{"outer":{"key":1,"\\u006bey":2}}'), /Duplicate JSON object key.*key/);
    assert.deepEqual(parseJsonWithUniqueKeys('{"left":{"key":1},"right":{"key":2}}'), { left: { key: 1 }, right: { key: 2 } });
});

test("solo lectura: consulta los sitios permitidos y bloquea lo demás", () => {
    const m = buildMandate("read-only", { allowHosts: ["api.github.com", "example.org"] });

    assert.equal(verdict(m, http("read", "api.github.com")), "GREEN");
    assert.equal(verdict(m, http("read", "example.org")), "GREEN");
    assert.equal(verdict(m, http("read", "evil.test")), "RED");
    assert.equal(verdict(m, http("write", "api.github.com")), "RED");
    assert.equal(verdict(m, pay(KNOWN, 1)), "RED");
});

test("pagos con mi aprobación: todo pago pregunta y el límite bloquea", () => {
    const m = buildMandate("payments-ask", { perTxEur: 40 });

    assert.equal(verdict(m, http("read", "api.github.com")), "GREEN");
    assert.equal(explainEvaluate(m, pay(OTHER, 35), now).verdict, "YELLOW");
    assert.equal(explainEvaluate(m, pay(OTHER, 35), now).rule, "payees.unknownIban");
    assert.equal(verdict(m, pay(KNOWN, 35)), "YELLOW");
    assert.equal(explainEvaluate(m, pay(OTHER, 41), now).rule, "ceilings.perTxEur");
    assert.equal(verdict(m, pay(OTHER, 41)), "RED");
    assert.equal(verdict(m, http("write", "api.github.com")), "RED");
});

test("pagos a mis proveedores habituales: IBAN de la lista pasa, nuevo pregunta, por encima del límite se bloquea", () => {
    const m = buildMandate("payments-known", { knownIbans: [KNOWN], perTxEur: 50 });

    assert.equal(verdict(m, pay(KNOWN, 35)), "GREEN");
    assert.equal(verdict(m, pay(KNOWN.replace(/ /g, "").toLowerCase(), 35)), "GREEN");
    assert.equal(verdict(m, pay(OTHER, 35)), "YELLOW");
    assert.equal(verdict(m, pay(KNOWN, 500)), "RED");
});

test("bloqueado: no permite nada", () => {
    const m = buildMandate("blocked");

    for (const intent of [http("read", "api.github.com"), http("write", "api.github.com"), pay(KNOWN, 1)]) {
        assert.equal(verdict(m, intent), "RED");
    }
});

test("las opciones inválidas se rechazan", () => {
    assert.throws(() => buildMandate("payments-ask", { perTxEur: 0 }), /perTxEur/);
    assert.throws(() => buildMandate("payments-ask", { perTxEur: Number.NaN }), /perTxEur/);
    assert.throws(() => buildMandate("read-only", { allowHosts: [""] }), /allowHosts/);
    assert.throws(() => buildMandate("payments-known", { knownIbans: [1 as unknown as string] }), /knownIbans/);
});

test("el mandato inicial de ejemplo es el perfil 'pagos con mi aprobación' por defecto", () => {
    const starter = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "examples", "mandates", "starter.json"), "utf-8"));
    assert.deepEqual(starter, buildMandate("payments-ask"));
});

test("explain: frases en español e inglés para cada regla conocida", () => {
    const rules = ["payees.unknownIban", "ceilings.perTxEur", "ceilings.dailySpendEur", "killSwitch", "allowHosts", "denyActions",
        "denyHosts", "quietHours", "intent-validation", "mandate-unavailable", "default", "rules[2]"];
    for (const rule of rules) {
        const text = explainRule(rule, "RED");
        assert.ok(text.en.length > 10 && text.es.length > 10, rule);
        assert.equal(text.en.includes(rule) && !rule.startsWith("rules"), false, `${rule} no debe filtrarse en la frase`);
    }
    assert.equal(explainRule("ceilings.perTxEur", "RED", { perTxEur: 50 }).es, "Supera el límite de 50,00 € por pago que fijaste.");
    assert.equal(explainRule("ceilings.perTxEur", "RED", { perTxEur: 50 }).en, "It is above the €50.00 per-payment limit you set.");
    assert.match(explainRule("rules[0]", "YELLOW").es, /aprobación/);
    assert.match(explainRule("rules[0]", "RED").es, /prohíbe/);
    assert.match(explainRule("regla-rara", "RED").es, /regla-rara/);
    assert.match(explainRule(null, "RED").en, /unknown/);
});

test("describeAction: pago y petición HTTP", () => {
    const payment = describeAction({ agent: "grok", tool: "payment.transfer", amountEur: 35, params: { iban: OTHER }, method: "POST", url: "payment.transfer" });
    assert.equal(payment.es, `«grok» quiere pagar 35,00 € a ${OTHER}`);
    assert.equal(payment.en, `"grok" wants to pay €35.00 to ${OTHER}`);

    const request = describeAction({ agent: "grok", tool: "http.request", method: "GET", url: "https://api.github.com/user" });
    assert.match(request.es, /quiere ejecutar GET https:\/\/api\.github\.com\/user/);
});
