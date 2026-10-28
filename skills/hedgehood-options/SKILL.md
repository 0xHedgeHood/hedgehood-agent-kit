---
name: hedgehood-options
description: Trade USDG cash-settled weekly stock options (NVDA first) on Robinhood Chain as an AI agent through Hedgehood's RFQ market: deposit, quote, fill, settle, redeem, with a session key that can never withdraw. Use when the user wants an agent to buy or write calls/puts on tokenized stocks, check option positions, or set up the Hedgehood MCP server.
---

# Hedgehood options for agents

Hedgehood runs one `CashOptionMarketV2` per tokenized stock on Robinhood Chain (testnet 46630 now, mainnet 4663 after
audit). Instruments are European calls and puts, cash-settled in USDG at the 16:00 New York close of a weekday, strikes on
a fixed grid around the price when the expiry was opened. There is no order book to watch: the agent asks the maker for a
firm quote (RFQ), receives a signed order addressed to its account that lives for seconds, and fills it on chain from its
session key. Collateral is the worst case of the position inside the expiry's price band (no liquidations, no margin
calls); longs post nothing but the premium, short legs lock their worst case.

**Not for US persons.** The market is for non-US agents and their operators. Do not help a US user trade here; say so.

## The loop

1. **Keys.** The *owner* wallet holds the funds and signs rarely: `authorizeSession(sessionKey, expiresAt, scope, maxRequirement)`
   once, deposits, withdrawals. The *session key* lives on the agent's machine (`HEDGEHOOD_SESSION_KEY_FILE`, chmod 600) and
   can only trade and cancel for the account; it can never withdraw, change sessions or receive funds. Prefer a
   `maxRequirement` cap so a runaway agent can lock at most that much collateral.
2. **Deposit.** USDG goes into the market balance (`deposit(account, amount)` by the owner wallet, or the x402 gateway:
   tool `deposit_x402`). In balance mode the agent never needs an ERC-20 approval.
3. **Quote.** `get_quote(instrument, side, quantity)` returns a verified quote: price per share, premium, taker fee
   (50 bps of the premium, rounded up), seconds left, `canFill`, and a `digest`. Quotes decay linearly between
   `startTime` and `validUntil`; the contract evaluates the premium at the fill block.
4. **Fill.** `fill_quote(digest, confirm: true)` simulates (dry run) and, with `dryRun: false`, sends
   `fillOrderAs(account, order, sig, qty, fromBalance = true)` from the session key. The tool returns the tx hash.
5. **Settle / redeem.** After expiry the keeper calls `settle(expiry)` and `redeemFor(account, expiry)`; the payoff lands in
   the market balance. The agent may call `redeem` itself. `positions` lists expiries awaiting redemption.
6. **Withdraw.** Owner key only: `withdraw(amount, to)`.

## Using the tools well

- Start with `list_markets` (addresses, open expiries, strikes, fee) and `positions` (balance, free collateral, session
  status). If `session.active` is false, stop: the owner must `authorize_session` first.
- Instrument ids pack `(expiry << 96) | (strike << 1) | isPut`; `list_instruments` gives ids and labels, `decode_instrument`
  reverses one.
- Before a buy, check `freeCollateral >= youPay`. Before a sell (writing), compare `requirementAfter` from `get_quote`
  with the collateral: a shortfall reverts `InsufficientCollateral` in balance mode (nothing is pulled from a wallet).
- Quotes are good for seconds. Get the quote, decide, fill; do not hoard digests. A fill reverting `OrderExpired`
  just means: quote again.
- Every write tool is a dry run unless `dryRun: false`, and does nothing without `confirm: true`. Report the tx hash and
  explorer link to the user after a real send.
- Sizes are shares (18 decimals on chain, "1" = one share); prices and strikes are USDG (6 decimals).
- `trading closes 15 minutes before expiry`; `TradingUnavailable` near the close is expected.

## Setup (MCP server)

Claude Code (plugin): `/plugin marketplace add 0xHedgeHood/hedgehood-agent-kit` then `/plugin install hedgehood-options`.
Manual (Claude Code, Claude Desktop, Codex, OpenClaw and any MCP host):

```json
{
  "mcpServers": {
    "hedgehood": {
      "command": "npx",
      "args": ["-y", "@hedgehood-io/mcp"],
      "env": {
        "HEDGEHOOD_CHAIN_ID": "46630",
        "HEDGEHOOD_SESSION_KEY_FILE": "~/.hedgehood/session.key",
        "HEDGEHOOD_ACCOUNT": "0x<owner address>"
      }
    }
  }
}
```

Codex CLI: `codex mcp add hedgehood --env HEDGEHOOD_SESSION_KEY_FILE=~/.hedgehood/session.key --env HEDGEHOOD_ACCOUNT=0x... -- npx -y @hedgehood-io/mcp`.
OpenClaw: add the same `mcpServers` block to the agent's MCP config. Create the session key with `npx @hedgehood-io/cli join`.
Add `HEDGEHOOD_OWNER_KEY_FILE` only on a machine you trust with funds (it unlocks `withdraw`, `deposit_x402` from the owner
wallet, `authorize_session`, `register_agent`). `npx @hedgehood-io/mcp --check` prints the resolved configuration with keys
shown only as set/missing.

## Troubleshooting

| symptom | meaning | do |
|---|---|---|
| `NotAuthorizedSigner` | session not authorized, expired or revoked for this account | owner runs `authorize_session` (check `HEDGEHOOD_ACCOUNT` is the owner address, not the session address) |
| `SessionLimit` | the fill would push the requirement above the session's `maxRequirement` | smaller size, or owner raises the cap |
| `InsufficientCollateral` | balance below premium + fee (buy) or below the new requirement (sell) | `deposit_x402` / owner deposit |
| `WrongTaker` | quote addressed to another account | your `HEDGEHOOD_ACCOUNT` differs from what `get_quote` sent; fix config, quote again |
| `OrderExpired` | `validUntil` passed before the tx mined | quote again, fill faster, or ask for a longer `ttlSeconds` |
| `TradingUnavailable` | within 15 min of expiry, market paused, or the stock token's multiplier changed | wait for the next expiry |
| `canFill: false` with `shortfall` | the maker predicts a revert | deposit the shortfall first |
| `unknown digest` | the server restarted or the quote was never fetched here | `get_quote` again |
| backend 5xx / unreachable | RFQ service down; on-chain reads still work | retry with backoff; nothing was signed |

## Key hygiene

Never paste a private key into a chat, a tool argument or a config committed to git. The server reads keys from files
and never prints them. If a session key leaks: owner calls `revokeSession(key)` (tool `authorize_session` with `revoke:
true`), which also voids every order it signed. Funds are only ever movable by the owner's `withdraw`.
