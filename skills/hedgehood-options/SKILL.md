---
name: hedgehood-options
description: Trade USDG cash-settled weekly stock options (NVDA first) on Robinhood Chain as an AI agent through Hedgehood's RFQ market: deposit, quote, fill, close before expiry, track P&L and history, settle, redeem, with a session key that can never withdraw; and deposit into or redeem from Hedgehood's Stock Yield vaults (weekly covered-call / wheel funds on tokenized stocks, NAV shares, asynchronous epochs). Use when the user wants an agent to buy or write calls/puts on tokenized stocks, check option positions or P&L, exit a position, earn option premium passively on a stock through a vault, check or claim a vault position, or set up the Hedgehood MCP server.
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
5. **Watch.** `positions` is the ACTIVE book: every open position with quantity, average entry price, the desk's mark,
   unrealized P&L and time to expiry. `get_pnl` gives the totals (realized / unrealized / fees / total); `get_history` is
   the PAST: fills, settlements and redeems, newest first.
6. **Close (optional).** To exit before expiry call `close_position(instrument, quantity?, confirm: true)`. Positions net
   out on chain and the maker quotes both sides, so a close is a fill of the opposite side of the same instrument: a long
   is sold to the bid, a short bought back at the ask, for at most `|position|`. Same session key, same balance mode, same
   dry run unless `dryRun: false`. Without `confirm` it only prices the exit.
7. **Settle / redeem.** After expiry the keeper calls `settle(expiry)` and `redeemFor(account, expiry)`; the payoff lands in
   the market balance. The agent may call `redeem` itself. `positions` lists expiries awaiting redemption.
8. **Withdraw.** Owner key only: `withdraw(amount, to)`.

## Using the tools well

- Start with `list_markets` (addresses, open expiries, strikes, fee) and `positions` (balance, free collateral, session
  status). If `session.active` is false, stop: the owner must `authorize_session` first.
- Instruments are named `NVDA-20261030-220-C` (New York date, USD strike, C/P); ids pack `(expiry << 96) | (strike << 1) |
  isPut`. `list_instruments` gives both; `decode_instrument` reverses an id. `get_mark` says whether the desk is quoting
  (`executable`); outside the listed US session it is not.
- A quote with `backendDryRun` / `fillable: false` comes from a desk running without its signer key (testnet today): read
  it, do not try to fill it.
- Before a buy, check `freeCollateral >= youPay`. Before a sell (writing), compare `requirementAfter` from `get_quote`
  with the collateral: a shortfall reverts `InsufficientCollateral` in balance mode (nothing is pulled from a wallet).
- Quotes are good for seconds. Get the quote, decide, fill; do not hoard digests. A fill reverting `OrderExpired`
  just means: quote again.
- Active vs past: `positions` (and its `pnl` block) is what you hold now; `get_history` is what happened. To reduce or
  exit a holding use `close_position`, not `fill_quote` on the other side by hand (it does the same fill but sizes it to
  the position and refuses to overshoot into a new opposite position).
- A `503 not_executable:feed_not_healthy` quote refusal is retried once for you after 1.5 s; if it still fails the
  feed is down for this cycle (20 s): wait and quote again rather than hammering.
- Every write tool is a dry run unless `dryRun: false`, and does nothing without `confirm: true`. Report the tx hash and
  explorer link to the user after a real send.
- Sizes are shares (18 decimals on chain, "1" = one share); prices and strikes are USDG (6 decimals).
- `trading closes 15 minutes before expiry`; `TradingUnavailable` near the close is expected.

## Stock Yield vaults

Hedgehood also runs **Stock Yield vaults**: v2 `EpochFund`s (mainnet 4663: `hhNVDA-CC`, `hhNVDA-WHEEL`, `hhGOOGL-CC`,
`hhTSLA-CC`, `hhAMZN-CC`, `hhMETA-CC`, `hhAAPL-CC`, `hhMSFT-CC`; testnet: one `hhNVDA-CC`). A fund holds one tokenized
stock plus USDG, writes a covered call (or runs the wheel) on it every week and issues transferable NAV shares; the
premium stays in NAV, so the share price carries the yield. Deposits are USDG and/or the stock; the fund is long the
stock, so NAV falls with it (the premium is a cushion, not a hedge). **Non-US only**, like the market.

**Vault or market?** Use the *market* when the user wants a specific position (buy or write one strike and expiry,
hedge, speculate, exit intraday): quotes are firm, fills are instant, closing is a fill of the opposite side. Use a
*vault* when the user wants passive premium income on a stock they are happy to hold, with no strike selection, no
collateral management and no weekly maintenance, and accepts a weekly cadence and a possible wait of up to a week to get
out. A vault is not a trade: nothing fills, nothing can be closed early.

**The three steps** (everything is asynchronous; tell the user so before the first call):
1. **Request.** `vault_deposit(vault, usdg, confirm: true)` approves the fund and calls `requestDeposit`; the amount
   leaves the owner wallet now and queues for the next epoch. `vault_redeem(vault, shares | "all", confirm: true)`
   moves the shares to escrow and queues them. A queued request can be cancelled with `vault_cancel` until the cohort's
   cutoff (`vault_status` shows `cancellable`).
2. **Wait for the freeze / settlement.** At the epoch's deposit cutoff (Monday 09:25 New York on mainnet) the freeze
   prices the queued deposits at that moment's NAV (they become shares) and pays the queued redemptions in kind (stock +
   USDG, pro rata). A redemption requested during a week waits for the current option to expire (Friday close) and
   for the next freeze: **a redeem can take up to a week**, a deposit until the next Monday. `list_vaults` shows the
   epoch state (`open` → `frozen` → `locked` → `settling`), `nextFreezeAt` and `nextSettleAt`; use them to say when.
3. **Claim.** After the freeze, `vault_status` lists what is `claimable`; `vault_claim(vault, confirm: true)` pays it
   to the owner wallet (`to` optional). Deposited shares need no claim: they appear on the account's next action.

Rules of thumb: vault writes need the **owner key** (`HEDGEHOOD_OWNER_KEY_FILE`); a market session key cannot act on a
vault and the tools say so. `list_vaults` is the first call (NAV per share, cap left, last week's premium yield, your
shares); check `gate` / `my.canDeposit` and `capLeft` before a deposit, and `my.pendingDeposit` / `my.pendingRedeem`
before queuing another one (one open cohort per account per direction; a second request joins the same cohort, a
request for a later cohort reverts `PendingOtherEpoch`). Shares are 18 decimals, USDG 6. Dry run first (`dryRun`
default true), report the tx hashes after a real send, and remind the user that the result arrives at the freeze, not
in the receipt.

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
Chain: `--testnet` (46630, default) or `--mainnet` (4663) on the `npx` command, or `HEDGEHOOD_CHAIN_ID`. The backend hosts
default to `agent-api` / `agent-index` / `agent-pay.hedgehood.io`; a hosted read-only MCP (no keys, no fills) is at
`https://mcp.hedgehood.io/mcp`. Add `HEDGEHOOD_OWNER_KEY_FILE` only on a machine you trust with funds (it unlocks `withdraw`, `deposit_x402` from the owner
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
| `not_executable:feed_not_healthy` after the built-in retry | the desk's pricing feed is between cycles (20 s) | wait 20 s, quote or close again |
| `no open position in …` from `close_position` | nothing to close in that instrument for this account | check `positions`; the account may differ from `HEDGEHOOD_ACCOUNT` |
| backend 5xx / unreachable | RFQ service down; on-chain reads still work | retry with backoff; nothing was signed |
| `NotEligible` / `not admitted by the deposit gate` (vault) | the receiver is banned by the open gate, or a stake gate's threshold is not met | check `gate.kind` in `list_vaults`; deposit from another account or stake |
| `DepositCapExceeded` (vault) | the fund's cap is full | `capLeft` in `list_vaults`; smaller amount or another fund |
| `PendingOtherEpoch` (vault) | the account already has a request queued for a different cohort | wait for that cohort's freeze (or cancel it), then request again |
| `nothing to claim` (vault) | the redemption's cohort has not frozen yet | `vault_status`: wait for `nextFreezeAt`, then `vault_claim` |
| `BadAmount` on cancel (vault) | the cohort's cutoff passed; the request is being processed | nothing to cancel; it becomes shares / claimable at the freeze |
| `Paused` (vault) | the owner paused new deposits and locks; redemptions and claims still work | redeem or wait |

## Key hygiene

Never paste a private key into a chat, a tool argument or a config committed to git. The server reads keys from files
and never prints them. If a session key leaks: owner calls `revokeSession(key)` (tool `authorize_session` with `revoke:
true`), which also voids every order it signed. Funds are only ever movable by the owner's `withdraw`.
