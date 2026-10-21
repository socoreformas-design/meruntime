#!/usr/bin/env node
// Entrada unificada: meruntime <comando>.

import packageMetadata from "../../../package.json";
import { runApprove } from "./approve.js";
import { runAudit } from "./audit.js";
import { runConnect } from "./connect.js";
import { runDeny } from "./deny.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { runHookClaude } from "./hook.js";
import { runKill } from "./kill.js";
import { runPending } from "./pendingList.js";
import { runRequestStatus } from "./requestStatus.js";
import { runServe } from "./serve.js";
import { runToken } from "./token.js";
import { runUi } from "./ui.js";

const HELP = `meruntime ${packageMetadata.version}: a local gatekeeper for AI agents (GREEN / YELLOW / RED).

Usage: meruntime <command> [options]

Commands:
  init [--force]            Create ~/.meruntime (mandate.json, secrets.json, kill.json) and print MCP config
  ui [--no-open] [--port N] Open the desktop interface: status, pending requests, approve/deny, audit, kill switch
    serve [--port N]          Start the local HTTP evaluation API on 127.0.0.1 (default port 4319)
    token rotate              Rotate the local HTTP API token
  connect --list | <client> [--remove]  Add or remove Me Runtime in Claude Desktop, Cursor or VS Code (with a backup)
  doctor                    Check Node, mandate.json, secrets.json and kill.json
  mcp                       Start the MCP server on stdio
    hook claude               Gate Claude Code terminal commands through local Me Runtime
  pending                   List requests waiting for approval
  approve <requestId>       Approve a pending request (re-evaluated, executed at most once)
  deny <requestId>          Deny a pending request
  request-status <id>       Show the state and transitions of a request
  kill on|off|status        Emergency switch: while on, every request is denied
  audit [--last N]          Show the last audit events (default 20)
  fakebank                  Start the local test bank (127.0.0.1:4318)
  demo iban                 Run the "email with a new IBAN" demo (needs fakebank; --manual to deny yourself)

Options:
  --version, -v             Print the version
  --help, -h                Print this help`;

const KEEP_RUNNING = Symbol("keep-running");

async function main(argv: string[]): Promise<number | typeof KEEP_RUNNING> {
    const [command, ...rest] = argv;
    switch (command) {
        case "--version":
        case "-v":
            console.log(packageMetadata.version);
            return 0;
        case undefined:
        case "--help":
        case "-h":
        case "help":
            console.log(HELP);
            return 0;
        case "init": return runInit(rest);
        case "doctor": return runDoctor();
        case "pending": return runPending();
        case "approve": return runApprove(rest);
        case "deny": return runDeny(rest);
        case "request-status": return runRequestStatus(rest);
        case "kill": return runKill(rest);
        case "audit": return runAudit(rest);
        case "connect": return runConnect(rest);
        case "hook":
            if (rest[0] === "claude") return runHookClaude(rest.slice(1));
            console.error("Usage: meruntime hook claude");
            return 1;
        case "token": return runToken(rest);
        case "serve": {
            const failed = await runServe(rest);
            return failed ?? KEEP_RUNNING;
        }
        case "ui": {
            const failed = await runUi(rest);
            return failed ?? KEEP_RUNNING;
        }
        case "mcp":
            await import("../../proxy/src/server.js");
            return KEEP_RUNNING;
        case "fakebank":
            await import("../../fakebank/src/main.js");
            return KEEP_RUNNING;
        case "demo":
            if (rest[0] !== "iban") {
                console.error("Usage: meruntime demo iban [--manual]");
                return 1;
            }
            await import("./demoIban.js");
            return KEEP_RUNNING;
        default:
            console.error(`Unknown command: ${command}\n\n${HELP}`);
            return 1;
    }
}

try {
    const code = await main(process.argv.slice(2));
    if (code !== KEEP_RUNNING) process.exitCode = code;
} catch (err) {
    console.error(err instanceof Error ? err.message : "Unexpected error.");
    process.exitCode = 1;
}
