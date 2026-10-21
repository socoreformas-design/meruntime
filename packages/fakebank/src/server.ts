// Banco de prueba local: solo para la demo y los tests. Ningún dato aquí es real.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

export const FAKEBANK_HOST = "127.0.0.1";
export const FAKEBANK_PORT = 4318;

export interface Transfer {
    transferId: string;
    status: "completed";
    iban: string;
    amountEur: number;
    concept: string;
}

export interface FakeBankOptions {
    token: string;
    /** 0 para un puerto libre (tests). */
    port?: number;
    /** Retraso artificial antes de responder a POST /transfers (tests de timeout). */
    latencyMs?: number;
}

export interface FakeBank {
    url: string;
    transfers(): Transfer[];
    close(): Promise<void>;
}

const MAX_BODY_BYTES = 16 * 1024;

function hasValidToken(authorization: string | undefined, token: string): boolean {
    const provided = Buffer.from(authorization?.startsWith("Bearer ") ? authorization.slice(7) : "", "utf-8");
    const expected = Buffer.from(token, "utf-8");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        request.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("body too large"));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        request.on("error", reject);
    });
}

export async function startFakeBank(options: FakeBankOptions): Promise<FakeBank> {
    const transfers: Transfer[] = [];
    const byKey = new Map<string, { bodyHash: string; transfer: Transfer }>();

    const server: Server = createServer(async (request, response) => {
        const send = (status: number, body: unknown) => {
            response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
        };
        try {
            if (request.method === "GET" && request.url === "/transfers") {
                send(200, { transfers });
                return;
            }
            if (request.method !== "POST" || request.url !== "/transfers") {
                send(404, { error: "not found" });
                return;
            }
            if (!hasValidToken(request.headers.authorization, options.token)) {
                send(401, { error: "unauthorized" });
                return;
            }
            const key = request.headers["idempotency-key"];
            if (typeof key !== "string" || key.length === 0) {
                send(400, { error: "Idempotency-Key header required" });
                return;
            }

            let parsed: { iban?: unknown; amountEur?: unknown; concept?: unknown };
            try {
                parsed = JSON.parse(await readBody(request));
            } catch {
                send(400, { error: "invalid JSON body" });
                return;
            }
            const { iban, amountEur, concept } = parsed;
            if (typeof iban !== "string" || typeof concept !== "string" || typeof amountEur !== "number" || !(amountEur > 0)) {
                send(400, { error: "iban, amountEur and concept are required" });
                return;
            }

            if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));

            const bodyHash = createHash("sha256").update(JSON.stringify({ iban, amountEur, concept })).digest("hex");
            const previous = byKey.get(key);
            if (previous) {
                if (previous.bodyHash !== bodyHash) {
                    send(409, { error: "Idempotency-Key reused with a different body" });
                    return;
                }
                send(200, { transferId: previous.transfer.transferId, status: previous.transfer.status });
                return;
            }

            const transfer: Transfer = { transferId: `tr_${randomBytes(6).toString("hex")}`, status: "completed", iban, amountEur, concept };
            transfers.push(transfer);
            byKey.set(key, { bodyHash, transfer });
            send(201, { transferId: transfer.transferId, status: transfer.status });
        } catch {
            if (!response.headersSent) send(500, { error: "internal error" });
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? FAKEBANK_PORT, FAKEBANK_HOST, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fake bank did not bind to a TCP port.");

    return {
        url: `http://${FAKEBANK_HOST}:${address.port}`,
        transfers: () => [...transfers],
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}
