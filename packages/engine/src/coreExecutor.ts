import type { Intent } from "../../schema/src/index.js";
import { PROTECTED_RESOURCE_URL } from "./protectedResource.js";
import { readGithubToken, readProtectedToken } from "./secrets.js";

export function isProtectedIntent(intent: Intent): boolean {
    if (intent.action !== "write" || !intent.target) return false;
    try {
        const target = new URL(intent.target);
        return target.hostname === "protected.local" && target.pathname === "/mark";
    } catch {
        return false;
    }
}

export function isGitHubUserIntent(intent: Intent): boolean {
    if (intent.action !== "read" || !intent.target) return false;
    try {
        const target = new URL(intent.target);
        return target.protocol === "https:" && target.hostname === "api.github.com" && target.pathname === "/user";
    } catch {
        return false;
    }
}

export function isCoreManagedIntent(intent: Intent): boolean {
    return isProtectedIntent(intent) || isGitHubUserIntent(intent);
}

// La idempotencia vive en el almacén de solicitudes, no aquí.
export async function executeCoreIntent(intent: Intent): Promise<{ success: true; status: number }> {
    if (!isCoreManagedIntent(intent)) {
        throw new Error("CORE executor only handles protected.local/mark and api.github.com/user.");
    }

    const isGitHubRequest = isGitHubUserIntent(intent);
    const token = isGitHubRequest ? readGithubToken() : readProtectedToken();
    const response = await fetch(isGitHubRequest ? intent.target! : PROTECTED_RESOURCE_URL, {
        method: isGitHubRequest ? "GET" : "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
        const resource = isGitHubRequest ? "GitHub API" : "Protected resource";
        throw new Error(`${resource} rejected request with status ${response.status}.`);
    }
    return { success: true, status: response.status };
}
