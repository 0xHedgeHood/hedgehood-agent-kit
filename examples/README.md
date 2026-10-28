# Examples

- `buy-weekly-call.ts`: an agent picks the nearest open expiry, the first strike at or above the anchor, asks the RFQ
  maker for one call, refuses anything over 10 USDG, and fills from its session key. Dry run unless `SEND=1`.

  ```sh
  pnpm install && pnpm -r build
  HEDGEHOOD_SESSION_KEY_FILE=~/.hedgehood/session.key HEDGEHOOD_ACCOUNT=0x... pnpm tsx examples/buy-weekly-call.ts
  ```

- `mcp-config.json`: the MCP server block for Claude Code / Claude Desktop / Codex / Cursor / OpenClaw. Replace the
  account with the owner address the session key is authorized for.
- `codex-config.toml`: the same for Codex CLI's `~/.codex/config.toml`.
