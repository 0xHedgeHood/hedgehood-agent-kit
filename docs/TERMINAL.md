# User portfolio in a terminal or Claude Code

`hedgehood dashboard` and the local MCP tool `get_dashboard` use the same ASCII renderer: account-wide P&L,
active option positions, and signed bars comparing unrealized P&L by position. No terminal colour support is needed.
Claude Code can show the returned display in a fenced `text` block. This is the user's on-chain portfolio; it does
not include the market maker's brokerage account.

These additions are unreleased. Build this checkout to try them; installing the current npm release does not add
`dashboard` or `get_dashboard`. No release or deployment is required to test the local build.

## Terminal

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm -r build
export HEDGEHOOD_ACCOUNT=0xYOUR_WALLET_ADDRESS
node packages/cli/dist/bin.js --testnet dashboard
node packages/cli/dist/bin.js --testnet list --ascii
node packages/cli/dist/bin.js --testnet positions --ascii
node packages/cli/dist/bin.js --testnet pnl --ascii
node packages/cli/dist/bin.js --testnet history --limit 10
node packages/cli/dist/bin.js --testnet dashboard --json
```

Replace the placeholder with the owner's public address. `dashboard` deliberately ignores trading-key settings;
it only reads `/v1/pnl`. The other commands keep their existing account/key configuration behaviour. Once released,
the installed executable is `hedgehood`. `list` is an alias for `markets`, which lists expiries and strikes for the
selected underlying (`--underlying NVDA`); the dashboard covers all markets in the account's indexer response.

`--json` returns structured values with their original precision and takes precedence over ASCII formatting.
Existing `pnl --json` output is unchanged; `dashboard --json` adds the selected `chainId`. A failed query exits with
an error instead of displaying an empty portfolio. The dashboard is a snapshot; rerun to refresh it.

## Claude Code

Register the locally built stdio server with an address, without key configuration. Replace both placeholders:

```sh
claude mcp add --transport stdio --scope user \
  --env HEDGEHOOD_CHAIN_ID=46630 \
  --env HEDGEHOOD_ACCOUNT=0xYOUR_WALLET_ADDRESS \
  --env HEDGEHOOD_SESSION_KEY= --env HEDGEHOOD_SESSION_KEY_FILE= \
  --env HEDGEHOOD_OWNER_KEY= --env HEDGEHOOD_OWNER_KEY_FILE= \
  hedgehood-portfolio -- node /absolute/path/to/hedgehood-agent-kit/packages/mcp/dist/bin.js
```

The empty key settings keep this connection address-only even if the parent shell has trading credentials. The
server still advertises its normal tools, but actions needing a signer have no key available. The dashboard tool
has a read-only annotation and never quotes, simulates or sends a trade. The registration syntax follows the
[official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server).

In Claude Code, check the connection using `/mcp`, then ask:

> Show my Hedgehood option portfolio with get_dashboard. Reproduce its display verbatim in a text code block.
> Explain missing marks separately. Do not make a trade.

Or: "List the available NVDA contracts", "Show my open positions", or "Show my last ten fills". These map to
`list_markets` / `list_instruments`, `positions`, and `get_history`. `get_pnl` remains available for raw P&L analysis.
`get_dashboard` returns the ASCII display in text content and the original data plus `chainId` and `display` in
`structuredContent`; clients that only consume text also receive a JSON text block. It is available in this local
TypeScript MCP server; the separately deployed Python hosted MCP has not been changed by this work.

## Read the numbers correctly

- Testnet shows **TestUSD (test funds)**; mainnet uses USDG. The network label is the configured chain; custom API
  overrides must point to the matching deployment.
- Totals come from the indexer. Fees are shown separately and are not subtracted again by the renderer.
- A missing open-position mark produces `N/A` and an incomplete total, even if an older backend supplies a partial
  numeric total. Raw JSON remains the original backend response; inspect its nulls and note before using totals.
- Closed and settled rows are excluded from the active table; they can still contribute to lifetime totals.
- Bars compare current unrealized P&L, with one common scale and signs around zero. They are **not an equity curve**,
  a return percentage, or today's profit. Historical performance needs historical valuation snapshots.
- Report time, oldest available mark time, and time to expiry at the report time are shown. A report timestamp does
  not prove the underlying indexer or prices are fresh. Mid valuation is not an executable close price.
- Amounts and quantities retain backend precision. Quantities use raw token-share units converted from 1e18;
  dividend multipliers can make these differ from listed-share quantities.

For a reproducible display using synthetic data and no network or keys:

```sh
pnpm exec tsx examples/portfolio-dashboard.ts
```
