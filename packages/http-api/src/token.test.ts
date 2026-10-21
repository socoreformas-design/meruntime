import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureApiToken, getApiTokenPath, readApiToken, rotateApiToken } from "./token.js";

let dir: string;
let previousHome: string | undefined;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meruntime-api-token-"));
    previousHome = process.env.MERUNTIME_HOME;
    process.env.MERUNTIME_HOME = dir;
});

afterEach(() => {
    if (previousHome === undefined) delete process.env.MERUNTIME_HOME;
    else process.env.MERUNTIME_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
});

test("el token es estable, se guarda fuera de secrets.json y rota bajo demanda", () => {
    const first = ensureApiToken();
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(ensureApiToken(), first);
    assert.equal(readApiToken(), first);
    assert.equal(readFileSync(getApiTokenPath(), "utf-8"), first);

    rotateApiToken();
    const rotated = readApiToken();
    assert.match(rotated, /^[0-9a-f]{64}$/);
    assert.notEqual(rotated, first);
    assert.equal(ensureApiToken(), rotated);
});

test("el archivo tiene permisos solo para el usuario actual", () => {
    ensureApiToken();
    if (process.platform !== "win32") {
        assert.equal(statSync(getApiTokenPath()).mode & 0o777, 0o600);
        return;
    }

    const whoami = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
    const who = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf-8", windowsHide: true });
    const sid = who.match(/S-1-(?:\d+-)+\d+/)?.[0];
    assert.ok(sid);
    const script = "(Get-Acl -LiteralPath $env:MERUNTIME_TEST_TOKEN_PATH).Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique";
    const accessSids = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf-8",
        env: { ...process.env, MERUNTIME_TEST_TOKEN_PATH: getApiTokenPath() },
        windowsHide: true,
    }).trim().split(/\r?\n/).filter(Boolean);
    assert.deepEqual(accessSids, [sid]);
});