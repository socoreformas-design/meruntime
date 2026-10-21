import { PROTECTED_RESOURCE_URL, type ProtectedResourceTestServer } from "./protectedResource.js";

export async function withLocalCoreFetch<T>(
    server: ProtectedResourceTestServer,
    run: () => Promise<T>,
): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (requestedUrl === PROTECTED_RESOURCE_URL) return originalFetch(server.url, init);
        if (requestedUrl === "https://api.github.com/user") return originalFetch(server.githubUserUrl, init);
        return originalFetch(input, init);
    }) as typeof fetch;

    try {
        return await run();
    } finally {
        globalThis.fetch = originalFetch;
    }
}