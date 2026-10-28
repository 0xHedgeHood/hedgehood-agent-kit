# Changelog

## 0.2.0 (unreleased)

Close, P&L, active positions and past activity as first-class agent features.

- `@hedgehood-io/sdk`: `RfqClient.getPnl(account)` and `getHistory(account, { limit, since })` for the indexer's new
  `GET /v1/pnl` and `GET /v1/history`; `planClose` / `closePosition` (read the signed on-chain position, quote the
  opposite side for `min(|position|, qty)`, fill via the same `fillOrderAs` path, dry run by default); `positionPnl`,
  `formatTimeToExpiry`, `formatSignedUsdg`. `requestQuote` retries a `503 not_executable:feed_not_healthy` once after
  1.5 s (`feedRetryMs`). 10 new unit tests (58 total).
- `@hedgehood-io/cli`: `close <instrument> [--qty] [--send]`, `close --all [--send]`, `pnl [--json]`,
  `history [--limit n] [--since <iso|unix>] [--json]`; `positions` rows gain average price, mark, unrealized P&L and
  time to expiry (existing fields kept). Tests run the commands against a fake node / maker / indexer (9 tests).
- `@hedgehood-io/mcp`: tools `close_position` (write: `confirm` + `dryRun` like `fill_quote`), `get_pnl`, `get_history`;
  `positions` is enriched with the P&L fields and the tool descriptions explain active (`positions`) vs past
  (`get_history`) and that `close_position` exits before expiry. 18 tools (11 tests).
- Docs: README command and tool lists, `docs/BACKEND_API.md` (the two endpoints and the retry), the skill.
- Versions are not bumped in this change (0.2.0 material; see RELEASING.md for the files to bump).

## 0.1.0 (unreleased)

First scaffold of the public agent kit for Hedgehood's AI-agent options market (CashOptionMarketV2 on Robinhood Chain).

- `@hedgehood-io/sdk`: deployment registry (testnet 46630 NVDA market; mainnet 4663 placeholders), vendored ABIs
  (hedgehood-options `feat/market-v2-derive-style` @ `131c1ae`), instrument id encode/decode and `gridFor`, EIP-712 V2
  orders (`signOrder`, `orderDigest`, decay math `currentPremiumRaw`/`premiumFor`/`takerFeeFor`), calldata builders
  (`fillOrderAs`, `deposit`, `withdraw`, `authorizeSession`, `redeem`, `settle`, nonce masks), `MarketClient`
  (reads + dry-run-first sends), `RfqClient` (`getQuote` with local verification; markets/instruments/mark/leaderboard/
  agent), x402 USDG payer for the deposit gateway (`depositViaGateway`, `pickUsdgRequirement`, `registerUsdg`, adapted
  from `@priors/x402`), ERC-8004 helpers. 43 unit tests; the order typehash and a fixture digest are checked against
  values computed from the Solidity source with `cast`.
- `@hedgehood-io/mcp`: local MCP server (stdio, streamable HTTP on localhost) reading the session/owner keys from files;
  14 tools; every write needs `confirm: true` and is a dry run by default; `--check` prints config without secrets;
  `server.json` for the MCP Registry.
- `@hedgehood-io/cli` (`hedgehood`): `join`, `markets`, `instruments`, `quote`, `fill`, `positions`, `deposit`
  (`--x402` or `--wallet`), `redeem`, `withdraw`, `session authorize|revoke|status`, `register`, `decode`; sends are
  dry run unless `--send`.
- Claude Code plugin + marketplace (`.claude-plugin/`), skill `skills/hedgehood-options/SKILL.md`, `AGENTS.md`,
  Smithery/Glama manifests, examples, CI (typecheck + tests + build + binary smoke).
- Backend client reconciled with hedgehood-options `feat/rfq-backend` (PR #38 @ 0cd8d23) and verified against the live
  public testnet stack (agent-api / agent-index / agent-pay.hedgehood.io, mcp.hedgehood.io/mcp): instrument names,
  REST + JSON-RPC quotes, digest/calldata cross-checks, dry-run quotes marked unfillable, indexer positions/leaderboard/
  agents, gateway instructions + 402 flow. Known backend mismatch documented (gateway names eip155:4663 on testnet).
- Nothing is published to npm or any registry yet.
