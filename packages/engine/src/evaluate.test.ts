import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, explainEvaluate } from "./evaluate.js";
import type { Intent, Mandate } from "../../schema/src/index.js";

const baseMandate: Mandate = {
    version: "1",
    userId: "demo",
    default: "deny",
    rules: [],
};

const paymentMandate: Mandate = {
    ...baseMandate,
    ceilings: { perTxEur: 50 },
    knownIbans: ["ES00 DEMO 0000 0000 0000 0001"],
    rules: [{ effect: "allow", action: "pay", tool: "payment.transfer" }],
};

function paymentIntent(iban: string | undefined, amountEur: number): Intent {
    return {
        agentId: "demo-agent",
        action: "pay",
        tool: "payment.transfer",
        amountEur,
        params: iban === undefined ? {} : { iban, concept: "Factura" },
        effects: [{ kind: "pay", reversible: false }],
    };
}

test("pago a IBAN conocido ≤ perTxEur → GREEN (ignora espacios y mayúsculas)", () => {
    assert.equal(explainEvaluate(paymentMandate, paymentIntent("es00demo0000000000000001", 35), new Date()).verdict, "GREEN");
});

test("pago a IBAN desconocido → YELLOW con regla payees.unknownIban", () => {
    const explanation = explainEvaluate(paymentMandate, paymentIntent("ES00 EVIL 0000 0000 0000 0666", 35), new Date());
    assert.equal(explanation.verdict, "YELLOW");
    assert.equal(explanation.rule, "payees.unknownIban");
    assert.equal(evaluate(paymentMandate, paymentIntent(undefined, 35), new Date()), "YELLOW");
});

test("pago > perTxEur → RED aunque el IBAN sea conocido o desconocido", () => {
    assert.equal(evaluate(paymentMandate, paymentIntent("ES00 DEMO 0000 0000 0000 0001", 500), new Date()), "RED");
    assert.equal(explainEvaluate(paymentMandate, paymentIntent("ES00 EVIL 0000 0000 0000 0666", 500), new Date()).rule, "ceilings.perTxEur");
});

test("importes con más de dos decimales → RED antes de aplicar techos", () => {
    for (const amount of [0.004, 49.995, 1e-3]) {
        const result = explainEvaluate(paymentMandate, paymentIntent("ES00 DEMO 0000 0000 0000 0001", amount), new Date());
        assert.equal(result.verdict, "RED", String(amount));
        assert.equal(result.rule, "intent.amountEur", String(amount));
    }
    assert.equal(evaluate(paymentMandate, paymentIntent("ES00 DEMO 0000 0000 0000 0001", 49.99), new Date()), "GREEN");
});

test("sin knownIbans en el mandato la regla de IBAN no se aplica", () => {
    const { knownIbans: _omitted, ...withoutList } = paymentMandate;
    assert.equal(evaluate(withoutList, paymentIntent("ES00 EVIL 0000 0000 0000 0666", 35), new Date()), "GREEN");
});

test("pago de 200 EUR con perTxEur 40 → RED", () => {
    const mandate: Mandate = {
        ...baseMandate,
        ceilings: { perTxEur: 40 },
        rules: [{ effect: "allow", action: "pay", tool: "http.request" }],
    };
    const intent: Intent = {
        agentId: "demo-agent",
        action: "pay",
        tool: "http.request",
        amountEur: 200,
        effects: [{ kind: "pay", reversible: false }],
    };
    assert.equal(evaluate(mandate, intent, new Date()), "RED");
});

test("read a api.github.com con allowHost y regla allow → GREEN", () => {
    const mandate: Mandate = {
        ...baseMandate,
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
    assert.equal(evaluate(mandate, intent, new Date()), "GREEN");
});

test("killSwitch true → RED", () => {
    const mandate: Mandate = {
        ...baseMandate,
        killSwitch: true,
        rules: [{ effect: "allow", action: "read", tool: "http.request" }],
    };
    const intent: Intent = {
        agentId: "demo-agent",
        action: "read",
        tool: "http.request",
        effects: [{ kind: "read", reversible: true }],
    };
    assert.equal(evaluate(mandate, intent, new Date()), "RED");
});

test("sin effects → RED", () => {
    const mandate: Mandate = {
        ...baseMandate,
        rules: [{ effect: "allow", action: "read", tool: "http.request" }],
    };
    const intent: Intent = {
        agentId: "demo-agent",
        action: "read",
        tool: "http.request",
        effects: [],
    };
    assert.equal(evaluate(mandate, intent, new Date()), "RED");
});

test("send en quietHours → YELLOW", () => {
    const mandate: Mandate = {
        ...baseMandate,
        quietHours: { startHour: 22, endHour: 7 },
        rules: [{ effect: "allow", action: "send", tool: "http.request" }],
    };
    const intent: Intent = {
        agentId: "demo-agent",
        action: "send",
        tool: "http.request",
        effects: [{ kind: "send", reversible: true }],
    };
    const now = new Date();
    now.setHours(23, 0, 0, 0);
    assert.equal(evaluate(mandate, intent, now), "YELLOW");
});
