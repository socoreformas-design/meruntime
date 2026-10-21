// Firma HMAC de la petición original guardada para ejecutarla tras la aprobación humana.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { HttpRequest } from "./adapters.js";
import { readPendingHmacKey } from "./secrets.js";

function compute(requestId: string, replay: HttpRequest, expiresAt: string): Buffer {
    const payload = `replay\0${requestId}\0${replay.method}\0${replay.url}\0${replay.body ?? ""}\0${expiresAt}`;
    return createHmac("sha256", readPendingHmacKey()).update(payload).digest();
}

export function createReplayMac(requestId: string, replay: HttpRequest, expiresAt: string): string {
    return compute(requestId, replay, expiresAt).toString("hex");
}

export function replayMacMatches(requestId: string, replay: HttpRequest, expiresAt: string, mac: string): boolean {
    if (!/^[0-9a-f]{64}$/i.test(mac)) return false;
    const expected = compute(requestId, replay, expiresAt);
    const actual = Buffer.from(mac, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
