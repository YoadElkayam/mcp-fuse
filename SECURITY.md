# Security Policy

## Supported versions

Only the latest published versions of `mcp-fuse` and `mcp-fuse-core` receive security fixes.

## Reporting a vulnerability

Please do NOT open a public issue for security problems. Instead use
[GitHub private vulnerability reporting](https://github.com/YoadElkayam/mcp-fuse/security/advisories/new)
or email yoad.elkayam@gmail.com.

You can expect an acknowledgment within a few days. Please include a reproduction
if you can.

## Scope notes for this project

mcp-fuse sits between an MCP host and servers, so the interesting surface is:

- The audit log (`--log-file`) intentionally records raw upstream error text. Treat
  that file as sensitive; it may contain data the model was never shown.
- The proxy passes the full parent environment to the wrapped server (API keys
  included, by design). A malicious "server command" in a config is equivalent to
  arbitrary code execution, same as running the server unwrapped.
- `mcp-fuse init` rewrites host config files. It writes backups, but treat configs
  as trusted input only.
