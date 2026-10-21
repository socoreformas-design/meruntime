import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

interface LoadReport {
    requested: number;
    completed: number;
    workerFailures: Array<{ workerId: number; code: number | null; error?: string }>;
    expected: { GREEN: number; YELLOW: number; RED: number };
    observed: { GREEN: number; YELLOW: number; RED: number; UNKNOWN: number; errors: number };
    elapsedMs: number;
    adapterCalls: number;
    unexpectedGreenCount: number;
    nonGreenAdapterCalls: number;
    persistedRequests: number | null;
    errors: unknown[];
}

test("carga multiproceso: no hay GREEN inesperados ni workers caídos", () => {
    const script = join(import.meta.dirname, "..", "..", "..", "scripts", "load-test.mjs");
    const output = execFileSync(process.execPath, [script, "--workers", "5", "--requests-per-worker", "20"], {
        cwd: join(import.meta.dirname, "..", "..", ".."),
        encoding: "utf-8",
        timeout: 60_000,
    });
    const report = JSON.parse(output) as LoadReport;

    assert.equal(report.requested, 100);
    assert.equal(report.completed, 100);
    assert.deepEqual(report.expected, { GREEN: 34, YELLOW: 33, RED: 33 });
    assert.deepEqual(report.workerFailures, []);
    assert.equal(report.errors.length, 0);
    assert.equal(report.unexpectedGreenCount, 0);
    assert.equal(report.nonGreenAdapterCalls, 0);
    assert.ok(report.elapsedMs < 60_000);
});
