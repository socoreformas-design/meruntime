# Security Policy

Me Runtime is a security tool, so we take reports seriously.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security problems.
Email **contact@meruntime.com** with:

- the version (`meruntime --version`) and operating system,
- steps to reproduce, or a proof of concept,
- the impact you observed (for example: an action executed without approval, a RED rule bypassed, credentials exposed to the agent).

You should get an acknowledgement within 3 business days. We will keep you updated, agree on a disclosure date with you, and credit you if you wish.

## Supported versions

Only the latest beta release (currently 0.0.5) receives security fixes.

## Scope

In scope: the policy engine, the MCP server, the CLI, the local console (`meruntime ui`), the local HTTP API (`meruntime serve`) and the Claude Code hook in this repository.

Known limitations, documented in the README, are not vulnerabilities by themselves:
- Me Runtime only protects actions that are routed through it.
- An agent with terminal or file access under the same operating-system account can read `~/.meruntime/secrets.json`, edit the mandate or run `meruntime approve`.
- The Windows installer is not code-signed yet.
