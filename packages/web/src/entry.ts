import packageMetadata from "../../../package.json";
import personalMandate from "../../../examples/mandates/personal.json";
import deleteFileIntent from "../../../examples/intents/borrar-archivo.json";
import githubReadIntent from "../../../examples/intents/lectura-github.json";
import paymentIntent from "../../../examples/intents/pago-200.json";
import { explainEvaluate } from "../../engine/src/evaluate.js";
import type { ActionClass, Decision, Effect, Intent, Mandate, Rule, Verdict } from "../../schema/src/index.js";

export type { ActionClass, Decision, Effect, Intent, Mandate, Rule, Verdict };

export interface WebEvaluationOptions {
    now?: string;
}

export interface WebEvaluationResult {
    verdict: Verdict;
    reason: string;
    rule?: string;
}

export function evaluateForWeb(mandate: object, intent: object, options?: WebEvaluationOptions): WebEvaluationResult {
    try {
        const now = options?.now ? new Date(options.now) : new Date();
        if (!Number.isFinite(now.getTime())) throw new Error("now debe ser una fecha ISO 8601 válida");
        return explainEvaluate(mandate as Mandate, intent as Intent, now);
    } catch (error) {
        const detail = error instanceof Error && error.message ? error.message : "datos inválidos";
        return { verdict: "RED", reason: `Entrada no válida: ${detail}` };
    }
}

export const examples = {
    mandates: [{ id: "personal", label: "Personal", mandate: personalMandate }],
    intents: [
        { id: "borrar-archivo", label: "Borrar un archivo", intent: deleteFileIntent },
        { id: "lectura-github", label: "Leer GitHub", intent: githubReadIntent },
        { id: "pago-200", label: "Pagar 200 €", intent: paymentIntent },
    ],
};

const webRuntime = {
    version: packageMetadata.version,
    evaluate: evaluateForWeb,
    examples,
};

declare global {
    interface Window {
        MeRuntime: typeof webRuntime;
    }
}

window.MeRuntime = webRuntime;