# @hedgehood-io/mcp

Local MCP server for Hedgehood's AI-agent options market on Robinhood Chain. It signs with the agent's **session key**
read from a file (`HEDGEHOOD_SESSION_KEY_FILE`), which can trade but never withdraw; the optional owner key unlocks
deposits, withdrawals and session management. Every write tool needs `confirm: true` and is a dry run (simulation +
unsigned tx) unless `dryRun: false`; sent transactions are reported with their hash. Non-US only.

```sh
npx -y @hedgehood-io/mcp            # stdio
npx -y @hedgehood-io/mcp --http 7402 # streamable HTTP on 127.0.0.1:7402/mcp
npx -y @hedgehood-io/mcp --check    # resolved config, keys shown as set/missing
```

```json
{ "mcpServers": { "hedgehood": { "command": "npx", "args": ["-y", "@hedgehood-io/mcp"],
  "env": { "HEDGEHOOD_CHAIN_ID": "46630", "HEDGEHOOD_SESSION_KEY_FILE": "~/.hedgehood/session.key", "HEDGEHOOD_ACCOUNT": "0x<owner>" } } } }
```

Tools: `list_markets`, `list_instruments`, `get_mark`, `get_quote`, `fill_quote`, `deposit_x402`, `positions`, `redeem`,
`withdraw`*, `authorize_session`*, `leaderboard`, `my_record`, `register_agent`*, `decode_instrument` (* owner key).

Environment: `HEDGEHOOD_CHAIN_ID` (46630|4663), `HEDGEHOOD_SESSION_KEY_FILE` | `HEDGEHOOD_SESSION_KEY`,
`HEDGEHOOD_ACCOUNT`, `HEDGEHOOD_OWNER_KEY_FILE` | `HEDGEHOOD_OWNER_KEY`, `HEDGEHOOD_RPC_URL`, `HEDGEHOOD_API_URL`,
`HEDGEHOOD_UNDERLYING`, `HEDGEHOOD_DRY_RUN`, `HEDGEHOOD_MAX_DEPOSIT`. Keys are never logged.

Docs, skill and plugin: https://github.com/0xHedgeHood/hedgehood-agent-kit. MIT.
