# @hedgehood-io/cli

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
hedgehood deposit 100 --x402 [--send]        # or --wallet (owner key: approve + deposit)
hedgehood redeem <expiry> [--send]
hedgehood withdraw 50 [--to 0x..] [--send]   # owner key
hedgehood session authorize|revoke|status
hedgehood register --name "my-agent"         # ERC-8004, mainnet, owner key
```

Instruments: a backend name (`NVDA-20261030-220-C`), a packed id, or `expiry:strike:call|put`.
Global options: `--testnet` (default) | `--mainnet` | `--chain <id>`, `--rpc`, `--rfq-url`, `--indexer-url`, `--gateway-url`,
`--account <owner>`, `--underlying NVDA`, `--session-key-file`, `--owner-key-file`, `--json`. Environment variables of
`@hedgehood-io/mcp` are honoured too.

https://github.com/0xHedgeHood/hedgehood-agent-kit. MIT.
