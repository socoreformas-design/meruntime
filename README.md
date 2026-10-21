# Me Runtime

**Your agent can ask; you decide what runs.**

> Free beta 0.0.5 · source-available under [FSL-1.1-MIT](LICENSE.md) (not OSI open source) · Español: [README.es.md](./README.es.md)

Me Runtime is a local gatekeeper for AI agent actions, written in Node/TypeScript. Every action your agent requests through it is checked against deterministic rules evaluated on your machine, with no LLM judging the action:

- 🟢 **GREEN**: executes
- 🟡 **YELLOW**: waits for your approval (`meruntime approve` / `meruntime deny`)
- 🔴 **RED**: blocked

It includes a kill switch, per-transaction and daily spend limits, quiet hours, idempotency (a request executes at most once) and an audit log. The MCP interface never returns credentials to the agent (see [Security](#security-where-the-secrets-live) for the limits of that). You can connect it as an MCP stdio server (VS Code/Copilot, Claude, Cursor), use the CLI or the local console (`meruntime ui`), or turn on the optional local HTTP API (`meruntime serve`, 127.0.0.1 only, token required).

> Demo: Copilot fell for a phishing email and tried to pay €35 to an unknown IBAN.
> Me Runtime held it YELLOW (`payees.unknownIban`) and it was denied with `meruntime deny`.

## Beta status

- Free beta **0.0.5** for Windows, macOS and Linux.
- Downloads: https://meruntime.com/es/developers.html (Windows `.exe`, plus an npm `.tgz` for all platforms; it is not published on the npm registry).
- The Windows installer is **not code-signed** yet, so SmartScreen will warn you.
- Expect breaking changes before 1.0.

## Version 0.0.5

- Enforces the configured request rate limit and maximum number of pending YELLOW requests.
- Times out while acquiring the request-store lock. If saving the outcome fails after execution, the request is marked `UNKNOWN` and is not retried automatically.
- Compacts old terminal requests while retaining their idempotency records.
- Includes a multiprocess load test for concurrent requests.
- Adds a local HTTP API through `meruntime serve` and `meruntime token rotate`.

Me Runtime only protects actions that pass through it; it does not control actions performed through other tools or routes.

## What it does today

- **Policy engine**: a *mandate* (`mandate.json`) with rules, host and action deny lists, per-transaction ceilings and a list of known IBANs. Default deny.
- **MCP server** (`meruntime mcp`) with two tools: `http_request` and `payment_transfer`.
- **Local HTTP API** (`meruntime serve`) for those same two tools, with the Node runtime as the only evaluator.
- **Claude Code terminal hook** (`meruntime hook claude`) sends terminal commands to the authorization-only `POST /api/authorize` route before Claude runs them. The hook does not execute commands; see [the example mandate](./docs/claude-hooks.mandate.example.json).
- **Human approval**: a YELLOW call *blocks* until you run `meruntime approve <id>`, `meruntime deny <id>`, or the timeout expires (default 5 minutes). Approval re-evaluates the mandate and the kill switch before anything runs.
- **Request state machine** with idempotency keys: each request executes at most once; an unanswered adapter ends in `UNKNOWN` and is never retried.
- **Audit log** (`meruntime audit`) with every state transition, and a **kill switch** (`meruntime kill on`).

## What it does NOT do yet

- The core has three execution adapters: **GitHub `GET /user`**, the **local test bank** (`fakebank`), and generic HTTP; the HTTP adapter executes requests only to hosts in the mandate's `allowHosts`. There is no real bank, email, shell-execution or file adapter. The Claude Code terminal hook authorizes a command but never executes or sandboxes it.
- Generic `http_request` is executed by the core: redirects are not followed and only `http(s)` URLs are allowed. The response body (first 2,000 characters) is returned only to the call that executed it and is never stored, so a repeated call with the same `idempotency_key` gets the status but not the body. For an approved YELLOW request, the body goes to nobody, because the approver's process runs it.
- `GET` requests are not deduplicated unless you pass an `idempotency_key`; writes are deduplicated by their payload.
- `ceilings.dailySpendEur` limits accumulated spend per day in `timezone` (UTC by default). Executed payments and in-flight or uncertain outcomes count toward the limit; amounts are summed in cents and may have no more than two decimal places. When the first payment starts in a period, its bucket stays anchored to that timezone until its midnight; changing `timezone` does not reset the current limit.
- No mobile app and no remote access: the desktop interface (`meruntime ui`) runs only on your computer. You can also approve from the CLI.
- Me Runtime only protects actions that pass through its MCP server, CLI, local HTTP API or the configured Claude Code terminal hook. It cannot stop an agent from using other tools, network clients, direct shell access or routes it was given; users can disable or change hooks.
- `MERUNTIME_MANDATE` can select another mandate file; `meruntime doctor` warns while this override is active.
- No team roles/RBAC, certifications or SLA.

## Install

There are two installation options:

### Windows installer

The installer includes its own Node.js runtime; you do not need to install Node.js first. Run `MeRuntime-Setup-<version>-win-x64.exe` for your Windows account. It installs under `%LOCALAPPDATA%\Programs\MeRuntime`, creates Start menu and desktop shortcuts, and opens the local UI. On first launch, the UI guides you through creating a policy and connecting an MCP client. The installer does not add the CLI to `PATH`; use the `.tgz` option below if you need CLI commands.

The beta installer is not digitally signed, so Windows may show a warning before it runs. Verify its SHA-256 against the value supplied with the download. Updating with a newer installer replaces the app files; your policy and audit data under `%USERPROFILE%\.meruntime` are separate and are not overwritten.

### `.tgz` package

Requires Node.js 20 or newer and works on Windows, macOS and Linux. Install the file you received and configure your local policy and MCP client:

```sh
npm i -g <file>.tgz
meruntime init
meruntime doctor
meruntime connect vscode
```

Use `meruntime connect claude` or `meruntime connect cursor` for those clients. Restart the client after connecting. In PowerShell, use `meruntime.cmd` for each command (for example, `meruntime.cmd init` and `meruntime.cmd connect vscode`).

`init` creates a local policy, `doctor` checks the setup, and `connect` configures the selected MCP client. The policy decides which actions run, require human approval, or are blocked. Run `meruntime ui` to open the local approval interface.

## IBAN demo

The demo uses a simulated email containing a prompt injection and a deliberately fictitious IBAN (`ES00 EVIL 0000 0000 0000 0666`) for a 35 EUR invoice. It demonstrates that an unknown IBAN requires approval, an unanswered request expires, and a 500 EUR request is blocked. The demo verifies that no transfer reaches the local fake bank; it never moves real money.

Start the test bank in one terminal, then run the demo in another:

```sh
meruntime fakebank
meruntime demo iban
```

Use `meruntime demo iban --manual` to deny the pending request yourself in a third terminal with `meruntime deny <requestId>`. The demo does not read or act on real email and does not connect to a real bank. Me Runtime only protects actions routed through its MCP server, CLI or local HTTP API; it cannot stop an agent from using other tools it has been given.

## Desktop interface

```
meruntime ui
```

Opens a window (Edge or Chrome in app mode, or your default browser) with five things and nothing else: the protection status, pending requests, Authorize / Deny buttons, the audit history and the Kill Switch. It talks to the same core as the CLI, so approving there re-evaluates the mandate and the kill switch exactly like `meruntime approve`. Use `--no-open` to print the URL instead, and `--port N` to pick a port. On a fresh install (no `mandate.json`) it starts with a 3-step setup assistant instead of the terminal: choose a profile, copy the MCP configuration for your agent, and see what an approval card looks like. It never overwrites existing files.

While a request is being authorized or denied, both buttons are disabled in Summary and Requests. A six-second notice confirms approval in green or denial in red, including the request id; the card is removed and the count updates. Errors show a plain-language reason and re-enable the buttons. If the connection is lost or the outcome is uncertain, check Activity before retrying.

The session survives a page reload: the token received in `#t=…` is kept in `sessionStorage`, scoped to the local origin and tab session, and removed from the URL. No `localStorage` or cookies are used. If the browser blocks storage, the console warns that reloading requires the full access link. During an outage it shows a reconnecting message and retries read-only queries every two seconds, without overlapping refreshes and with a five-second deadline per refresh. It never automatically resends approvals or denials. If access expires or you restart `meruntime ui`, use the new window or its full link; an old tab cannot discover the new process's port or token.

The interface is a local server on `127.0.0.1` protected by a random session token (passed in the URL fragment, so it is never sent to the server or logged), a strict Content-Security-Policy and Host/Origin checks. It protects against web pages and remote attackers; it does not protect against a process running as your user that can read your files or see your process list, such as an agent with a shell.

## Local HTTP API

`meruntime serve` starts a separate local API on `127.0.0.1:4319` by default. Choose another port with `meruntime serve --port N`. Only one `serve` instance may run at a time. `POST /api/check` is unchanged and accepts only `http_request` and `payment_transfer`; `POST /api/authorize` is a separate terminal-only authorization endpoint and never executes an adapter or command. `GET /api/requests/<request_id>` returns `/api/check` state; `GET /api/authorizations/<request_id>` returns terminal authorization state. Both entry points apply the kill switch and share rate and pending limits.

Every API request requires `x-meruntime-token`. On first start, the service creates a stable token at `~/.meruntime/api-token` (or `%USERPROFILE%\.meruntime\api-token`; `MERUNTIME_HOME` can move the directory). macOS/Linux use mode `0600`; Windows uses a DACL for the current user. Rotate it with `meruntime token rotate`; the new token is active immediately. Scripts should read the file directly rather than put the token in source code or command-line arguments. A process running as your Windows user can still read it.

`POST /api/check` requires an `idempotency_key` for every request, including GET requests. Reuse the same key if a connection fails and the outcome is uncertain. A YELLOW response is `202` with a `request_id`; poll `GET /api/requests/<request_id>`. RED decisions are returned as decisions, not transport errors. A `FAILED` or `UNKNOWN` execution is reported as `UNKNOWN`, never as GREEN. Authentication and malformed-request errors are HTTP 4xx responses without a verdict and must be treated as failures.

`POST /api/authorize` accepts `{ "agent_id", "tool_name", "command", "cwd", "idempotency_key" }` for Claude Code `Bash` or `PowerShell` calls. GREEN returns `AUTHORIZED`; YELLOW returns `202` and stays blocked while the hook polls every second for approval until `approvalTimeoutMs`; RED and expiry deny. HTTP 4xx errors have no verdict and must be treated as failures. Human approval re-evaluates the current mandate and only authorizes the described command; CLI/UI approval never executes it. Authorizations use a separate locked store, share rate and pending limits with `/api/check`, and retain terminal idempotency tombstones for 30 days.

Me Runtime only protects actions that pass through its MCP server, CLI, local HTTP API or the configured Claude Code terminal hook. It does not intercept other tools, direct network calls or actions performed outside those paths.

## Claude Code terminal hook

The first hook integration supports Claude Code `PreToolUse` for terminal tools only. It requires `meruntime serve`, the local API token, and Claude Code `v2.1.295` or later for `onFailure: "block"`. Configure a hook timeout longer than the mandate's `approvalTimeoutMs`; the example uses 330 seconds for the default 5-minute approval window. The Windows form launches `meruntime.cmd` through `cmd.exe` so it works with the npm Windows shim.

POSIX `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "meruntime",
            "args": ["hook", "claude"],
            "timeout": 330,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

Windows `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "cmd.exe",
            "args": ["/d", "/s", "/c", "meruntime.cmd hook claude"],
            "timeout": 330,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

Start `meruntime serve` before using the hook. The hook reads only the approved event fields from stdin; stdout is reserved for Claude's decision JSON, and diagnostics go to stderr.

The example mandate is [docs/claude-hooks.mandate.example.json](./docs/claude-hooks.mandate.example.json). Without a valid mandate, evaluation is RED by default. The classifier is conservative but incomplete: unknown commands are `exec`; compound commands inherit the riskiest segment; redirections are `write`; command substitution, backticks, expression evaluation and script execution are never `read`. Allowing `exec` permits any command classified as `exec`, not one specific command.

Cursor, Copilot, file tools and tools outside Claude Code's configured terminal hook are not covered. For a future Copilot integration, a host-enforced pre-tool hook timeout can fail open even when the command hook denies errors; that integration cannot promise fail-closed behavior for that host timeout. Users can disable or edit hooks, and a classifier cannot understand every shell construct. Me Runtime records an authorization decision; it does not execute or sandbox the command.

## Editing your mandate

`meruntime init` copies a safe starter to `~/.meruntime/mandate.json`. Edit it and run `meruntime doctor` to validate it. JSON has no comments, so the annotated version below is only for reading:

```jsonc
{
  "version": "1",
  "userId": "me",
  "default": "deny",              // anything no rule allows is blocked
  "allowHosts": ["api.github.com"], // hosts a GREEN http_request may reach (a human can still approve others)
  "denyActions": ["delete", "exec", "grant"], // always RED
  "ceilings": { "perTxEur": 50 },   // a payment above this is RED
  "rules": [
    // GET requests to GitHub run without asking
    { "effect": "allow", "action": "read", "tool": "http.request", "host": "api.github.com" },
    // payments are allowed, but see knownIbans
    { "effect": "allow", "action": "pay", "tool": "payment.transfer" }
  ],
  "knownIbans": ["ES00 DEMO 0000 0000 0000 0001"], // other IBANs are YELLOW (human approval)
  "approvalTimeoutMs": 300000,    // how long a YELLOW call waits for you (5 min)
  "rateLimitPerSecond": 20,       // new requests per second; excess is RED
  "maxPendingRequests": 50,       // concurrent YELLOW requests; excess is RED
  "killSwitch": false             // use `meruntime kill on` instead of editing this
}
```

Rule effects are `allow` (GREEN), `confirm` (YELLOW) and `deny` (RED). The first matching rule of each effect wins; `deny` is checked before `confirm`, and `confirm` before `allow`.

## Security: where the secrets live

- Everything lives in `~/.meruntime/` (`%USERPROFILE%\.meruntime` on Windows; set `MERUNTIME_HOME` to move it): `mandate.json`, `secrets.json`, `kill.json`, `api-token`, plus the request ledger and audit log.
- `secrets.json` holds the API tokens (`githubToken`, `protectedToken`, `fakeBankToken`) and the HMAC key that signs pending approvals. Files are written atomically; on Linux and macOS they get mode `600` and the folder `700`. On Windows the protection is the ACL of your user profile.
- **The MCP interface does not return credentials.** The core process reads tokens and adds them to outgoing requests. However, an agent with terminal access under the same operating-system account can read `secrets.json`, including the HMAC key.
- **Known limitation:** an agent with terminal access under the same account can run `meruntime approve`, edit `mandate.json`, or read the HMAC key. Do not grant the agent terminal access; for stronger separation, run the agent and Me Runtime under different operating-system accounts. A broker running under a separate identity is not included in this release.
- Limits: any process running as your user can read these files, and an agent that also has a shell or file tool could read them too. Me Runtime protects the tools that go through it, not the whole machine.
- While a YELLOW `http_request` waits for approval, its original URL and body (which may carry credentials the agent put there) are kept in `requests.json`, signed with the HMAC key, and deleted as soon as the request ends. Everything else stored or logged is redacted.

## License

Me Runtime is **source-available** under the [Functional Source License, Version 1.1, MIT Future License (FSL-1.1-MIT)](LICENSE.md).

In plain terms:
- ✅ Use it for free, including inside your company; study it, modify it, fork it and send improvements.
- ❌ Don't use it to offer a commercial product or service that competes with Me Runtime.
- ⏳ Each release becomes available under the **MIT** license two years after it is published.

This is not an OSI-approved open source license. The license grants no rights to the "Me Runtime" name or logo.
Full terms: [LICENSE.md](LICENSE.md) · About FSL: https://fsl.software/

## Feedback

This is an early beta, and honest feedback, especially about what breaks, is the most useful thing you can give.
- Bugs and ideas: GitHub Issues on this repository
- Become a tester: https://meruntime.com/es/
- Email: contact@meruntime.com
- Security issues: please email contact@meruntime.com instead of opening a public issue (see [SECURITY.md](SECURITY.md)).
- Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md) (a CLA is required).
