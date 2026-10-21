import { join } from "node:path";
import { withFileLock } from "./fsAtomic.js";
import { resolveMeruntimeDir } from "./paths.js";

/** Serializes new requests across /api/check and /api/authorize while they enforce shared limits. */
export function withAdmissionLock<T>(fn: () => T): T {
    return withFileLock(join(resolveMeruntimeDir(), "admission.lock"), fn);
}