// meruntime init: crea ~/.meruntime con mandato, secretos y kill switch, sin sobrescribir nada salvo con --force.

import { MERUNTIME_DIR } from "../../engine/src/paths.js";
import { PROFILE_IDS, isProfileId, type ProfileId } from "../../engine/src/profiles.js";
import { initializeState } from "../../engine/src/setup.js";
import { selfCommand } from "./selfCommand.js";

const USAGE = `Usage: meruntime init [--force] [--profile ${PROFILE_IDS.join("|")}] [--limit EUR] [--host HOST]... [--iban IBAN]...`;

const PROFILE_SUMMARY: Record<ProfileId, string> = {
    "read-only": "the agent can read the allowed sites; everything else is blocked",
    "payments-ask": "reads allowed; every payment asks for your approval; payments above the limit are blocked",
    "payments-known": "payments to your trusted IBANs pass up to the limit; a new IBAN asks you; above the limit is blocked",
    "blocked": "nothing is allowed",
};

interface InitArgs {
    force: boolean;
    profile: ProfileId;
    limit?: number;
    hosts: string[];
    ibans: string[];
}

function parseInitArgs(args: string[]): InitArgs | undefined {
    const parsed: InitArgs = { force: false, profile: "payments-ask", hosts: [], ibans: [] };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const value = args[i + 1];
        if (arg === "--force") parsed.force = true;
        else if (arg === "--profile" && value !== undefined && isProfileId(value)) { parsed.profile = value; i++; }
        else if (arg === "--limit" && value !== undefined) { parsed.limit = Number(value); i++; }
        else if (arg === "--host" && value !== undefined) { parsed.hosts.push(value); i++; }
        else if (arg === "--iban" && value !== undefined) { parsed.ibans.push(value); i++; }
        else return undefined;
    }
    return parsed;
}

function snippet(value: unknown): string {
    return JSON.stringify(value, null, 2).split("\n").map((l) => `  ${l}`).join("\n");
}

export interface McpConfigs {
    /** Claude Desktop (claude_desktop_config.json) y Cursor (~/.cursor/mcp.json). */
    claudeAndCursor: unknown;
    /** VS Code (.vscode/mcp.json). */
    vscode: unknown;
    /** Entrada alternativa con la ruta local de esta instalación, para quien no publica. */
    local: unknown;
}

export function mcpConfigs(): McpConfigs {
    const installed = { command: "meruntime", args: ["mcp"] };
    const local = selfCommand(["mcp"]);
    return {
        claudeAndCursor: { mcpServers: { meruntime: installed } },
        vscode: { servers: { meruntime: { type: "stdio", ...installed } } },
        local: { meruntime: { command: "node", args: local.args } },
    };
}

export function mcpSnippets(): string {
    const configs = mcpConfigs();
    return [
        "MCP configuration (paste into your client, then restart it):",
        "",
        "Claude Desktop (claude_desktop_config.json) and Cursor (~/.cursor/mcp.json):",
        snippet(configs.claudeAndCursor),
        "",
        "VS Code (.vscode/mcp.json):",
        snippet(configs.vscode),
        "",
        "Without publishing (local path to this installation): same files, replace the meruntime entry with:",
        snippet(configs.local),
        "",
        "On Windows, if the client cannot launch meruntime, use \"command\": \"cmd\" with \"args\": [\"/c\", \"meruntime\", \"mcp\"].",
    ].join("\n");
}

export function runInit(args: string[]): number {
    const options = parseInitArgs(args);
    if (!options) {
        console.error(USAGE);
        return 1;
    }
    const { force } = options;
    const paymentProfile = options.profile === "payments-ask" || options.profile === "payments-known";
    if ((options.limit !== undefined && !paymentProfile) || (options.ibans.length > 0 && options.profile !== "payments-known")
        || (options.hosts.length > 0 && options.profile === "blocked")) {
        console.error(`These options do not apply to the ${options.profile} profile.\n${USAGE}`);
        return 1;
    }
    let results;
    try {
        results = initializeState(options.profile, {
            perTxEur: options.limit,
            allowHosts: options.hosts.length > 0 ? options.hosts : undefined,
            knownIbans: options.ibans,
        }, force);
    } catch (err) {
        console.error(err instanceof Error ? err.message : "Invalid options.");
        return 1;
    }

    console.log(`meruntime home: ${MERUNTIME_DIR}`);
    console.log(`  profile: ${options.profile} (${PROFILE_SUMMARY[options.profile]})`);
    for (const file of results) {
        if (file.status === "skipped") console.log(`  skipped  ${file.path} (already exists; use --force to overwrite)`);
        else console.log(`  ${file.status}  ${file.path}`);
    }
    if (force) console.log("  warning: --force regenerates the HMAC key and clears tokens in secrets.json; old pending requests become invalid.");

    console.log("\nNext: run `meruntime doctor`, then add your MCP configuration.\n");
    console.log(mcpSnippets());
    return 0;
}
