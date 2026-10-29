# @hedgehood-io/cli

For the ASCII portfolio dashboard added in 0.4.0, `--ascii` tables and matching Claude Code view, see the
[terminal guide](../../docs/TERMINAL.md). Build this checkout to use `hedgehood dashboard`; it needs only an address.

`hedgehood`: command line for Hedgehood's AI-agent options market on Robinhood Chain. Sends are **dry run** (simulated,
calldata printed) unless `--send` is given. Non-US only.

```sh
npx @hedgehood-io/cli join                                   # create ~/.hedgehood/session.key, print the authorize call
hedgehood markets                                            # expiries and strikes (no key needed)
hedgehood quote <expiry>:220:call --side buy --qty 1
hedgehood fill --instrument <expiry>:220:call --side buy --qty 1 --send
hedgehood positions                          # qty, avg price, mark, unrealized P&L, time to expiry per row
hedgehood pnl [--json]                       # positions marked at mid + realized / unrealized / fees / total
hedgehood history [--limit n] [--since <iso|unix>] [--json]   # fills, settlements, redeems, newest first
hedgehood close <instrument> [--qty <shares>] [--send]        # exit before expiry: fills the opposite side
hedgehood close --all [--send]               # flatten every open position
hedgehood account [--key 0x..] [--json]      # the account in EVERY market: collateral, locked, free, allowance, positions, session
hedgehood deposit 100 [--market GOOGL] --x402 [--send]   # or --wallet (owner key: approve if short + deposit)
hedgehood redeem <expiry> [--send]
hedgehood withdraw 50 [--market GOOGL] [--to 0x..] [--send]   # owner key
hedgehood withdraw --all [--send]            # owner key: every market's free balance, one tx per market
hedgehood rebalance --from NVDA --to GOOGL --amount 25 [--send]   # owner key: withdraw, approve if short, deposit
hedgehood session authorize --max-spend 100 [--max-short-risk 0|<usdg>|unlimited] [--send]   # owner key; --max-spend required
hedgehood session status                     # expiry, authorizedAt, riskLeft, spendLeft
hedgehood session revoke <key> [--send]
hedgehood register --name "my-agent"         # ERC-8004 (the chain's registry), owner key
hedgehood faucet --send                      # testnet: 1,000 hUSD-test (no value) per 24 h to the sending wallet

# Stock Yield vaults (owner key; requests queue until the next epoch freeze, a redeem can take up to a week)
hedgehood --mainnet vaults                                   # NAV/share, epoch state, next freeze, cap, last week's yield
hedgehood --mainnet vault status [--vault hhNVDA-CC]         # shares, queued requests (cancellable?), claimable
hedgehood --mainnet vault deposit 100 --vault hhNVDA-CC [--stock 0.5] [--send]   # approve + requestDeposit
hedgehood --mainnet vault redeem all --vault hhNVDA-CC [--send]                  # paid in kind at the next freeze
hedgehood --mainnet vault claim --vault hhNVDA-CC [--to 0x..] [--send]
hedgehood --mainnet vault cancel deposit|redeem --vault hhNVDA-CC [--send]
```

Instruments: a backend name (`NVDA-20261030-220-C`), a packed id, or `expiry:strike:call|put`; strikes are the listed
per-share strikes (mapped to the per-token strike in the id with the expiry's `uiMultiplier`). Markets are separate (each
has its own balance and session grant): `fill` / `close` trade in the quote's market (the instrument name's ticker, a
quote file's `market`, else `--underlying`). `--signer session|owner` picks the key (default: the session key when
configured). The account's own key fills in **wallet mode** by default (approve the market if the allowance is short,
then fill; nothing to deposit; `--approve max` for unlimited), or `--from-balance [--auto-deposit]`. A session key fills in
balance mode only (a fill its market's balance cannot pay is refused with the owner's `rebalance` / `deposit --market`
command), within two cumulative budgets: a sell that opens a short draws `riskLeft` (`--max-short-risk`, default
0 = it cannot sell to open) by the short's worst case, a buy draws `spendLeft` (`--max-spend`) by premium + fee beyond
the worst case of the shorts it closes. `quote`, `fill` and `close` print the leg's `session charge` and say when it
would revert `SessionLimit`. `--max-requirement` was removed and errors with a pointer to `--max-short-risk`. Vaults: an address, a
share symbol (`hhNVDA-CC`, `NVDA-CC`) or a ticker that names one fund (`GOOGL`).
Global options: `--testnet` (default) | `--mainnet` | `--chain <id>`, `--rpc`, `--rfq-url`, `--indexer-url`, `--gateway-url`,
`--vault-api-url <url|off>`, `--account <owner>`, `--underlying NVDA`, `--session-key-file`, `--owner-key-file`, `--json`.
Environment variables of `@hedgehood-io/mcp` are honoured too.

https://github.com/0xHedgeHood/hedgehood-agent-kit. MIT.
