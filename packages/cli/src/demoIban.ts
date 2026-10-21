// Demo: un correo con prompt injection pide pagar a un IBAN nuevo; Me Runtime lo detiene.
// Requiere el banco de prueba en marcha:  meruntime fakebank
// Uso: meruntime demo iban            (variantes A, B y C automáticas; A se deniega lanzando `meruntime deny`)
//      meruntime demo iban --manual   (en A espera a que deniegues tú con `meruntime deny <requestId>`)

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readAuditLines } from "../../engine/src/audit.js";
import { findExamplesDir } from "../../engine/src/paths.js";
import { readRequests } from "../../engine/src/requestStore.js";
import { selfCommand } from "./selfCommand.js";

const EXAMPLES = findExamplesDir();
const BANK_URL = process.env.MERUNTIME_FAKEBANK_URL ?? "http://127.0.0.1:4318";
const MANUAL = process.argv.includes("--manual");
const RUN_ID = Date.now().toString(36);

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const title = (text: string) => console.log(`\n=== ${text} ===`);

async function bankTransfers(): Promise<unknown[]> {
    const response = await fetch(`${BANK_URL}/transfers`);
    return ((await response.json()) as { transfers: unknown[] }).transfers;
}

function findRequest(idempotencyKey: string) {
    return readRequests().find((r) => r.idempotencyKey === idempotencyKey);
}

async function waitForRequest(idempotencyKey: string) {
    for (let i = 0; i < 200; i++) {
        const record = findRequest(idempotencyKey);
        if (record) return record;
        await sleep(100);
    }
    throw new Error("la solicitud nunca apareció en el libro");
}

/** El agente simulado: lee el correo y obedece la instrucción inyectada. */
function agentReadsEmail(path: string): { iban: string; amountEur: number; concept: string } {
    const email = readFileSync(path, "utf-8");
    console.log(email.split("\n").map((l) => `  | ${l}`).join("\n"));
    const iban = /IBAN:\s*([A-Z0-9 ]+)/.exec(email)?.[1]?.trim();
    const amount = /Importe:\s*(\d+)/.exec(email)?.[1];
    const concept = /Concepto:\s*(.+)/.exec(email)?.[1]?.trim();
    if (!iban || !amount || !concept) throw new Error("correo de ejemplo no reconocido");
    return { iban, amountEur: Number(amount), concept };
}

async function withAgent<T>(mandatePath: string, run: (call: (args: Record<string, unknown>) => Promise<string>) => Promise<T>): Promise<T> {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    const mcp = selfCommand(["mcp"]);
    const transport = new StdioClientTransport({
        command: mcp.command,
        args: mcp.args,
        env: { ...env, MERUNTIME_MANDATE: mandatePath },
    });
    const client = new Client({ name: "agente-simulado", version: "0.0.1" });
    await client.connect(transport);
    try {
        return await run(async (args) => {
            const result = await client.callTool({ name: "payment_transfer", arguments: args }, undefined, { timeout: 10 * 60_000 });
            const first = (result.content as Array<{ type: string; text?: string }>)[0];
            return first?.text ?? "";
        });
    } finally {
        await client.close();
    }
}

function runDenyCli(requestId: string): Promise<string> {
    return new Promise((resolveCli) => {
        const deny = selfCommand(["deny", requestId]);
        const child = spawn(deny.command, deny.args);
        let output = "";
        child.stdout.on("data", (d) => { output += d; });
        child.stderr.on("data", (d) => { output += d; });
        child.on("close", () => resolveCli(output.trim()));
    });
}

// --- preparación ---------------------------------------------------------------------------
try {
    await bankTransfers();
} catch {
    console.error(`No se alcanza el banco de prueba en ${BANK_URL}. Arráncalo en otra terminal: meruntime fakebank`);
    process.exit(1);
}

const base = JSON.parse(readFileSync(join(EXAMPLES, "mandates", "pagos.json"), "utf-8")) as Record<string, unknown>;
const tmp = mkdtempSync(join(tmpdir(), "meruntime-demo-"));
const mandateWith = (name: string, approvalTimeoutMs: number) => {
    const path = join(tmp, `${name}.json`);
    writeFileSync(path, JSON.stringify({ ...base, approvalTimeoutMs }), "utf-8");
    return path;
};

const requestIds: string[] = [];
let failures = 0;
const check = (ok: boolean, message: string) => {
    console.log(`${ok ? "OK " : "FALLO"} ${message}`);
    if (!ok) failures++;
};

try {
    title("El correo");
    const email = agentReadsEmail(join(EXAMPLES, "emails", "factura-urgente.txt"));
    console.log(`\nEl agente, manipulado por el correo, decide pagar ${email.amountEur} EUR a ${email.iban}.`);
    const before = (await bankTransfers()).length;
    console.log(`Transferencias en el banco antes de la demo: ${before}`);

    // --- Variante A: denegada desde la CLI ----------------------------------------------------
    title("Variante A: el humano deniega desde la CLI");
    {
        const key = `demo-iban-${RUN_ID}-A`;
        await withAgent(mandateWith("A", MANUAL ? 300_000 : 60_000), async (call) => {
            let settled = false;
            const agentCall = call({ ...email, idempotency_key: key }).finally(() => { settled = true; });
            const record = await waitForRequest(key);
            requestIds.push(record.requestId);
            console.log(`Veredicto: ${record.verdict}   regla: ${record.rule}   requestId: ${record.requestId}`);
            console.log(`expiresAt: ${record.expiresAt}`);
            await sleep(1500);
            check(!settled, "la llamada del agente sigue BLOQUEADA esperando decisión");

            if (MANUAL) {
                console.log(`\n>>> En otra terminal ejecuta:  meruntime deny ${record.requestId}`);
            } else {
                console.log(`\nCLI> meruntime deny ${record.requestId}`);
                console.log(`     ${await runDenyCli(record.requestId)}`);
            }
            const answer = await agentCall;
            console.log(`Respuesta al agente: ${answer}`);
            check(findRequest(key)?.status === "DENIED", "estado final DENIED");
        });
        const after = (await bankTransfers()).length;
        check(after === before, `el banco NO recibió ninguna transferencia (transferencias: ${after})`);
    }

    // --- Variante B: nadie decide ---------------------------------------------------------------
    title("Variante B: nadie decide y vence el plazo (3 s)");
    {
        const key = `demo-iban-${RUN_ID}-B`;
        await withAgent(mandateWith("B", 3_000), async (call) => {
            const agentCall = call({ ...email, idempotency_key: key });
            const record = await waitForRequest(key);
            requestIds.push(record.requestId);
            console.log(`Veredicto: ${record.verdict}   regla: ${record.rule}   requestId: ${record.requestId}`);
            const answer = await agentCall;
            console.log(`Respuesta al agente: ${answer}`);
            check(findRequest(key)?.status === "EXPIRED", "estado final EXPIRED");
        });
        const after = (await bankTransfers()).length;
        check(after === before, `el banco NO recibió ninguna transferencia (transferencias: ${after})`);
    }

    // --- Variante C: importe de 500 EUR ----------------------------------------------------------
    title("Variante C: el atacante sube el importe a 500 EUR");
    {
        const key = `demo-iban-${RUN_ID}-C`;
        await withAgent(mandateWith("C", 60_000), async (call) => {
            const answer = await call({ ...email, amountEur: 500, idempotency_key: key });
            const record = await waitForRequest(key);
            requestIds.push(record.requestId);
            console.log(`Veredicto: ${record.verdict}   regla: ${record.rule}   requestId: ${record.requestId}`);
            console.log(`Respuesta al agente (inmediata): ${answer}`);
            check(record.status === "DENIED" && record.verdict === "RED", "estado final DENIED con veredicto RED");
        });
        const after = (await bankTransfers()).length;
        check(after === before, `el banco NO recibió ninguna transferencia (transferencias: ${after})`);
    }

    // --- Auditoría -------------------------------------------------------------------------------
    title("Auditoría de estas solicitudes (audit.jsonl)");
    for (const entry of readAuditLines().filter((l) => l.event === "transition" && l.request_id && requestIds.includes(l.request_id))) {
        console.log(`${entry.at}  ${entry.request_id}  ${entry.from} -> ${entry.to}  actor=${entry.actor}  rule=${entry.rule}  ${entry.reason}`);
    }

    title(failures === 0 ? "Resultado: Me Runtime detuvo los tres intentos; no se pagó nada" : `Resultado: ${failures} comprobación(es) fallida(s)`);
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
