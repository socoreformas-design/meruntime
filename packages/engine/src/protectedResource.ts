import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface ProtectedResourceOptions {
    expectedToken: string;
    port?: number;
}

export const PROTECTED_RESOURCE_URL = "http://127.0.0.1:9876/mark";

export interface ProtectedResourceTestServer {
    url: string;
    githubUserUrl: string;
    executionCount(): number;
    close(): Promise<void>;
}

function hasValidToken(authorization: string | undefined, expectedToken: string): boolean {
    const provided = Buffer.from(authorization?.startsWith("Bearer ") ? authorization.slice(7) : "", "utf-8");
    const expected = Buffer.from(expectedToken, "utf-8");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function startProtectedResourceTestServer(
    options: ProtectedResourceOptions,
): Promise<ProtectedResourceTestServer> {
    return startProtectedResourceServer({ ...options, port: 0 });
}

export async function startProtectedResourceServer(
    options: ProtectedResourceOptions,
): Promise<ProtectedResourceTestServer> {
    let count = 0;
    const server: Server = createServer((request, response) => {
        const isProtectedRequest = request.method === "POST" && request.url === "/mark";
        const isGitHubUserRequest = request.method === "GET" && request.url === "/user";
        if (!isProtectedRequest && !isGitHubUserRequest) {
            response.writeHead(404).end();
            return;
        }
        if (!hasValidToken(request.headers.authorization, options.expectedToken)) {
            response.writeHead(401).end();
            return;
        }
        count += 1;
        response.writeHead(200).end();
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 9876, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw new Error("Protected resource test server did not bind to a TCP port.");
    }

    return {
        url: `http://127.0.0.1:${address.port}/mark`,
        githubUserUrl: `http://127.0.0.1:${address.port}/user`,
        executionCount: () => count,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}