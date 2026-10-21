import type { ActionClass } from "../../schema/src/index.js";

const RANK: Record<ActionClass, number> = {
    read: 0,
    exec: 1,
    write: 2,
    delete: 3,
    send: 4,
    pay: 4,
    grant: 4,
};

const READ_COMMANDS = new Set([
    "cat", "dir", "find", "get-childitem", "get-content", "grep", "head", "ls", "pwd", "rg", "stat", "tail", "type", "whoami",
]);
const DELETE_COMMANDS = new Set([
    "del", "erase", "find-delete", "git-clean", "git-reset-hard", "remove-item", "rm", "rmdir", "shred", "srm", "unlink",
]);
const WRITE_COMMANDS = new Set([
    "add-content", "chmod", "copy", "cp", "mkdir", "move", "mv", "new-item", "out-file", "sed-i", "set-content",
    "tee", "tee-object", "touch",
]);
const SEND_COMMANDS = new Set([
    "docker-push", "ftp", "rsync", "scp", "send-mailmessage", "sftp",
    "ssh", "terraform-apply", "kubectl-apply",
]);
const EXECUTABLES = new Set(["bash", "node", "node.exe", "powershell", "pwsh", "python", "python.exe", "python3", "sh"]);
const SCRIPT_EXTENSIONS = /\.(?:bat|cmd|js|mjs|ps1|py|sh|ts)$/i;

interface ParsedCommand {
    words: string[];
    redirection: boolean;
    dynamic: boolean;
    nested: ActionClass[];
}

function splitCommand(command: string): ParsedCommand[] {
    const result: ParsedCommand[] = [];
    let words: string[] = [];
    let word = "";
    let quote: "'" | '"' | undefined;
    let redirection = false;
    let dynamic = false;
    const nested: ActionClass[] = [];

    const finishWord = () => {
        if (word) words.push(word);
        word = "";
    };
    const finishSegment = () => {
        finishWord();
        if (words.length || redirection || dynamic || nested.length) result.push({ words, redirection, dynamic, nested: [...nested] });
        words = [];
        redirection = false;
        dynamic = false;
        nested.length = 0;
    };

    for (let index = 0; index < command.length; index++) {
        const char = command[index];
        if (char === "`" && quote !== "'") {
            dynamic = true;
            const closing = command.indexOf("`", index + 1);
            if (closing >= 0) {
                const nestedCommand = command.slice(index + 1, closing);
                if (nestedCommand.trim()) nested.push(classifyCommand(nestedCommand));
                index = closing;
            }
            word += "`";
            continue;
        }
        if (char === "$" && command[index + 1] === "(" && quote !== "'") {
            dynamic = true;
            let depth = 1;
            let closing = index + 2;
            for (; closing < command.length && depth > 0; closing++) {
                if (command[closing] === "(") depth++;
                else if (command[closing] === ")") depth--;
            }
            const nestedCommand = command.slice(index + 2, Math.max(index + 2, closing - 1));
            if (nestedCommand.trim()) nested.push(classifyCommand(nestedCommand));
            word += "$()";
            index = closing - 1;
            continue;
        }
        if (quote) {
            word += char;
            if (char === quote) quote = undefined;
            else if (char === "\\" && quote === '"' && index + 1 < command.length) word += command[++index];
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            word += char;
            continue;
        }
        if (char === ">") {
            redirection = true;
            finishWord();
            while (command[index + 1] === ">") index++;
            continue;
        }
        if (char === "\\" && index + 1 < command.length) {
            word += command[++index];
            continue;
        }
        if (char === ";" || char === "\n" || char === "|" || char === "&") {
            finishSegment();
            if (char === "|" && command[index + 1] === "|") index++;
            else if (char === "&" && command[index + 1] === "&") index++;
            continue;
        }
        if (/\s/.test(char)) {
            finishWord();
            continue;
        }
        word += char;
    }
    finishSegment();
    return result;
}

function normalizeWord(value: string): string {
    return value.replace(/^["']|["']$/g, "").toLowerCase();
}

function segmentAction(segment: ParsedCommand): ActionClass {
    const words = segment.words.map(normalizeWord);
    const commandIndex = words.findIndex((value) => value.length > 0 && !/^[a-z_][\w]*=.*/i.test(value));
    const executable = commandIndex < 0 ? "" : words[commandIndex].replace(/^.*[\\/]/, "");
    const args = words.slice(commandIndex + 1);
    const flags = args.filter((word) => word.startsWith("-"));
    let action: ActionClass = "exec";

    if (DELETE_COMMANDS.has(executable)) action = "delete";
    else if (SEND_COMMANDS.has(executable)) action = "send";
    else if (["curl", "curl.exe", "invoke-restmethod", "invoke-webrequest", "wget", "wget.exe"].includes(executable)) {
        const methodIndex = flags.findIndex((flag) => ["-x", "--request", "-method"].includes(flag));
        const explicitMethod = methodIndex >= 0 ? args[args.indexOf(flags[methodIndex]) + 1]?.toUpperCase() : undefined;
        const hasBody = flags.some((flag) => ["-d", "--data", "--data-raw", "--post-data", "-body"].includes(flag));
        action = (hasBody || (explicitMethod && !["GET", "HEAD"].includes(explicitMethod))) ? "send" : "exec";
    } else if (WRITE_COMMANDS.has(executable)) action = "write";
    else if (executable === "git" && args[0] === "push") action = "send";
    else if (executable === "git" && args[0] === "clean") action = "delete";
    else if (executable === "git" && args[0] === "reset" && args.includes("--hard")) action = "delete";
    else if (executable === "gh" && args[0] === "release" && args[1] === "create") action = "send";
    else if (executable === "kubectl" && ["apply", "delete"].includes(args[0])) action = args[0] === "delete" ? "delete" : "send";
    else if (executable === "terraform" && args[0] === "apply") action = "send";
    else if (words.some((word) => ["eval", "iex", "invoke-expression"].includes(word))) action = "exec";
    else if (EXECUTABLES.has(executable) && (flags.includes("-file") || args.some((arg) => SCRIPT_EXTENSIONS.test(arg)))) action = "exec";
    else if (SCRIPT_EXTENSIONS.test(executable) || executable.startsWith("./") || executable.startsWith("../")) action = "exec";
    else if (executable === "git" && ["status", "log", "diff", "show"].includes(args[0])) action = "read";
    else if (executable === "npm" && args[0] === "publish") action = "send";
    else if (executable === "docker" && args[0] === "push") action = "send";
    else if (executable === "gh" && args[0] === "api" && args.some((arg) => /^-X(?:POST|PUT|PATCH|DELETE)$/i.test(arg))) action = "send";
    else if (READ_COMMANDS.has(executable)) action = "read";

    if (segment.redirection && RANK[action] < RANK.write) action = "write";
    if (segment.dynamic && RANK[action] < RANK.exec) action = "exec";
    for (const nested of segment.nested) if (RANK[nested] > RANK[action]) action = nested;
    return action;
}

/** Conservative terminal classifier; compound commands inherit their riskiest segment. */
export function classifyCommand(command: string): ActionClass {
    if (typeof command !== "string" || command.trim().length === 0) return "exec";
    const segments = splitCommand(command);
    if (segments.length === 0) return "exec";
    return segments.reduce<ActionClass>((risk, segment) => {
        const action = segmentAction(segment);
        return RANK[action] > RANK[risk] ? action : risk;
    }, "read");
}