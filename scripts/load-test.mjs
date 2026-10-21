import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function makeCase(index) {
    const kind = index % 3;
    const action = kind === 0 ? "read" : kind === 1 ? "write" : "delete";
    const url = `https://load.test/resource/${index}`;
    return {
        expected: kind === 0 ? "GREEN" : kind === 1 ? "YELLOW" : "RED",
        intent: {
            agentId: "load-test-agent",
            action,
            tool: "http.request",
            target: url,
            effects: [{ kind: action, reversible: action === "read" }],
        },
        request: { method: action === "read" ? "GET" : "POST", url },
    };
}

async function runWorker(workerId, requestsPerWorker) {
    const { submitRequest } = await import(pathToFileURL(join(ROOT, "packages", "engine", "src", "requestRuntime.ts")).href);
    let adapterCalls = 0;
    const results = await Promise.all(Array.from({ length: requestsPerWorker }, async (_, localIndex) => {
        const index = workerId * requestsPerWorker + localIndex;
        const testCase = makeCase(index);
        const started = performance.now();
        let adapterCalled = false;
        try {
            const view = await submitRequest(
                { intent: testCase.intent, request: testCase.request, idempotencyKey: `load-${workerId}-${localIndex}` },
                { wait: false, adapter: async () => { adapterCalled = true; adapterCalls++; return { status: 200 }; } },
            );
            return {
                index,
                expected: testCase.expected,
                verdict: view.verdict,
                status: view.status,
                rule: view.rule,
                adapterCalled,
                latencyMs: performance.now() - started,
            };
        } catch (error) {
            return {
                index,
                expected: testCase.expected,
                verdict: null,
                status: null,
                rule: null,
                adapterCalled,
                latencyMs: performance.now() - started,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            };
        }
    }));
    return { workerId, adapterCalls, results };
}

function runWorkerProcess(workerId, requestsPerWorker, env) {
    return new Promise((resolveWorker) => {
        const child = spawn(process.execPath, ["--import", "tsx", SCRIPT_PATH, "--worker", String(workerId), String(requestsPerWorker)], {
            cwd: ROOT,
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill(), 60_000);
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        child.on("error", (error) => {
            clearTimeout(timer);
            resolveWorker({ workerId, code: null, error: String(error), stderr, stdout });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            try {
                resolveWorker({ ...JSON.parse(stdout.trim().split(/\r?\n/).at(-1)), code, stderr });
            } catch (error) {
                resolveWorker({ workerId, code, error: `Invalid worker output: ${String(error)}`, stderr, stdout });
            }
        });
    });
}

export async function runLoadTest({ workerCount = 20, requestsPerWorker = 25 } = {}) {
    const work = mkdtempSync(join(tmpdir(), "meruntime-load-"));
    const home = join(work, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "mandate.json"), JSON.stringify({
        version: "1",
        userId: "load-test",
        default: "deny",
        allowHosts: ["load.test"],
        denyActions: ["delete"],
        rules: [
            { effect: "allow", action: "read", tool: "http.request", host: "load.test" },
            { effect: "confirm", action: "write", tool: "http.request", host: "load.test" },
        ],
        rateLimitPerSecond: 20,
        maxPendingRequests: 50,
        approvalTimeoutMs: 300_000,
    }), "utf8");
    writeFileSync(join(home, "secrets.json"), JSON.stringify({ pendingHmacKey: "ab".repeat(32) }), "utf8");
    writeFileSync(join(home, "kill.json"), JSON.stringify({ on: false }), "utf8");

    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MERUNTIME_")));
    env.MERUNTIME_HOME = home;
    const started = performance.now();
    try {
        const workers = await Promise.all(Array.from({ length: workerCount }, (_, id) => runWorkerProcess(id, requestsPerWorker, env)));
        const results = workers.flatMap((worker) => worker.results ?? []);
        const latencies = results.map((result) => result.latencyMs);
        const errors = results.filter((result) => result.error);
        const unexpectedGreen = results.filter((result) => result.expected !== "GREEN" && result.verdict === "GREEN");
        const nonGreenAdapterCalls = results.filter((result) => result.expected !== "GREEN" && result.adapterCalled);
        const requestsPath = join(home, "requests.json");
        const auditPath = join(home, "audit.jsonl");
        let persistedRequests = null;
        let requestsJsonBytes = 0;
        let auditJsonlBytes = 0;
        try {
            const content = readFileSync(requestsPath, "utf8");
            persistedRequests = JSON.parse(content).length;
            requestsJsonBytes = statSync(requestsPath).size;
        } catch { /* no admitted request reached persistence */ }
        try { auditJsonlBytes = statSync(auditPath).size; } catch { /* best effort: no audit file yet */ }
        return {
            requested: workerCount * requestsPerWorker,
            completed: results.length,
            workerFailures: workers.filter((worker) => worker.code !== 0 || worker.error).map(({ workerId, code, error, stderr }) => ({ workerId, code, error, stderr })),
            expected: {
                GREEN: results.filter((result) => result.expected === "GREEN").length,
                YELLOW: results.filter((result) => result.expected === "YELLOW").length,
                RED: results.filter((result) => result.expected === "RED").length,
            },
            observed: {
                GREEN: results.filter((result) => result.verdict === "GREEN").length,
                YELLOW: results.filter((result) => result.verdict === "YELLOW").length,
                RED: results.filter((result) => result.verdict === "RED").length,
                UNKNOWN: results.filter((result) => result.status === "UNKNOWN").length,
                errors: errors.length,
            },
            meanLatencyMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
            maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
            elapsedMs: performance.now() - started,
            adapterCalls: workers.reduce((sum, worker) => sum + (worker.adapterCalls ?? 0), 0),
            unexpectedGreenCount: unexpectedGreen.length,
            nonGreenAdapterCalls: nonGreenAdapterCalls.length,
            requestsJsonBytes,
            auditJsonlBytes,
            persistedRequests,
            errors: errors.slice(0, 20),
        };
    } finally {
        rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

if (process.argv[2] === "--worker") {
    const report = await runWorker(Number(process.argv[3]), Number(process.argv[4]));
    console.log(JSON.stringify(report));
} else {
    const option = (name, fallback) => {
        const index = process.argv.indexOf(name);
        return index >= 0 ? Number(process.argv[index + 1]) : fallback;
    };
    const report = await runLoadTest({ workerCount: option("--workers", 20), requestsPerWorker: option("--requests-per-worker", 25) });
    console.log(JSON.stringify(report, null, 2));
    if (report.workerFailures.length > 0 || report.completed !== report.requested || report.unexpectedGreenCount > 0 || report.nonGreenAdapterCalls > 0 || report.errors.length > 0) {
        process.exitCode = 1;
    }
}
