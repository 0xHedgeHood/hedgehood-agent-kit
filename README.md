# Hedgehood agent kit

[![ci](https://github.com/0xHedgeHood/hedgehood-agent-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/0xHedgeHood/hedgehood-agent-kit/actions/workflows/ci.yml)
[![npm @hedgehood-io/sdk](https://img.shields.io/npm/v/@hedgehood-io/sdk?label=%40hedgehood-io%2Fsdk)](https://www.npmjs.com/package/@hedgehood-io/sdk)
[![npm @hedgehood-io/mcp](https://img.shields.io/npm/v/@hedgehood-io/mcp?label=%40hedgehood-io%2Fmcp)](https://www.npmjs.com/package/@hedgehood-io/mcp)
[![npm @hedgehood-io/cli](https://img.shields.io/npm/v/@hedgehood-io/cli?label=%40hedgehood-io%2Fcli)](https://www.npmjs.com/package/@hedgehood-io/cli)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.0xHedgeHood%2Fhedgehood--options-blue)](https://registry.modelcontextprotocol.io)
[![MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

SDK, local MCP server, CLI, Claude Code plugin and examples for **Hedgehood's AI-agent options market**: USDG
cash-settled weekly calls and puts on tokenized stocks (NVDA first) on Robinhood Chain, traded by agents through an
RFQ maker and filled on chain with a **session key that can never withdraw**.

> **Non-US only.** The market is for agents and operators outside the United States. Testnet (chain 46630) is live for
> integration; the mainnet (4663) listing follows the audit of `CashOptionMarketV2`.

| package | what | install |
|---|---|---|
| [`@hedgehood-io/sdk`](packages/sdk) | viem-based TypeScript SDK: deployments, ABIs, instrument ids, EIP-712 orders, `fillOrderAs` calldata, RFQ client with local quote verification, `closePosition`, P&L and history readers, x402 USDG payer, ERC-8004 helpers | `pnpm add @hedgehood-io/sdk viem` |
| [`@hedgehood-io/mcp`](packages/mcp) | local MCP server (stdio + streamable HTTP) signing with the agent's key; 18 tools, every write needs `confirm: true` and is a dry run by default | `npx -y @hedgehood-io/mcp` |
| [`@hedgehood-io/cli`](packages/cli) | `hedgehood` binary: `join`, `deposit`, `quote`, `fill`, `close`, `positions`, `pnl`, `history`, `redeem`, `withdraw`, `session authorize\|revoke\|status` | `npx @hedgehood-io/cli --help` |
| [`skills/hedgehood-options`](skills/hedgehood-options/SKILL.md) | the skill an agent reads: market model, the loop, key hygiene, troubleshooting | `/plugin marketplace add 0xHedgeHood/hedgehood-agent-kit` |
| [`examples/`](examples) | a 30-line "agent buys a weekly call" script and an MCP config snippet | `pnpm tsx examples/buy-weekly-call.ts` |

## Quickstart (testnet, 5 minutes)

```sh
# 1. a session key for the agent (chmod 600 file; the key never leaves the machine)
npx @hedgehood-io/cli join
#    -> prints the session address and the `authorizeSession` call the OWNER wallet must make

# 2. owner wallet (anywhere): authorize the session and deposit tUSDG
cast send 0xC289617d613C9865a6595B365DaD88277282e0Ac 'authorizeSession(address,uint64,uint256,uint256)' <session> <expiresAt> 3 0 --rpc-url https://rpc.testnet.chain.robinhood.com
cast send 0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d 'approve(address,uint256)' 0xC289617d613C9865a6595B365DaD88277282e0Ac 100000000 --rpc-url ...
cast send 0xC289617d613C9865a6595B365DaD88277282e0Ac 'deposit(address,uint256)' <owner> 100000000 --rpc-url ...
#    (or, once the gateway is up: `hedgehood deposit 100 --x402 --send` from the owner key)

# 3. trade from the agent machine
export HEDGEHOOD_ACCOUNT=<owner address>
hedgehood markets                                   # open expiries, strikes
hedgehood quote NVDA-20261030-220-C --side buy --qty 1                    # firm RFQ quote, verified locally
hedgehood fill --instrument NVDA-20261030-220-C --side buy --qty 1        # dry run: simulates, prints calldata
hedgehood fill --instrument NVDA-20261030-220-C --side buy --qty 1 --send # broadcasts, prints the tx hash
hedgehood positions                                 # open positions: qty, avg price, mark, unrealized P&L, time to expiry
hedgehood pnl                                       # realized / unrealized / fees / total (indexer)
hedgehood history --limit 20                        # past fills, settlements, redeems, newest first
hedgehood close NVDA-20261030-220-C                 # exit before expiry: quotes the opposite side, dry run
hedgehood close NVDA-20261030-220-C --qty 0.5 --send
hedgehood close --all --send                        # flatten every open position
```

Positions are signed and net out on chain, and the maker quotes both sides of every instrument, so closing is a fill of
the opposite side of the same instrument (a long is sold to the bid, a short bought back at the ask). `close` reads the
on-chain position, quotes `min(|position|, --qty)` and fills exactly like `fill`.

Or from an agent host: add the MCP server (below), then say *"quote the NVDA 220 call expiring Friday and fill one if it
costs under 6 USDG"*. The agent calls `get_quote`, shows you the price, then `fill_quote` with `confirm: true`. Later,
*"how am I doing?"* is `positions` / `get_pnl`, *"what did I trade?"* is `get_history`, and *"get out of the 220 call"*
is `close_position` with `confirm: true`.

## MCP server

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

- **Claude Code**: `/plugin marketplace add 0xHedgeHood/hedgehood-agent-kit` then `/plugin install hedgehood-options@hedgehood`
  (bundles the skill and the server), or `claude mcp add hedgehood -e HEDGEHOOD_SESSION_KEY_FILE=~/.hedgehood/session.key -e HEDGEHOOD_ACCOUNT=0x... -- npx -y @hedgehood-io/mcp`.
- **Codex CLI**: `codex mcp add hedgehood --env HEDGEHOOD_SESSION_KEY_FILE=~/.hedgehood/session.key --env HEDGEHOOD_ACCOUNT=0x... -- npx -y @hedgehood-io/mcp`
  (or the same block under `[mcp_servers.hedgehood]` in `~/.codex/config.toml`).
- **Hosted, read-only, no keys** (any MCP host that takes a URL): `https://mcp.hedgehood.io/mcp` serves markets,
  instruments, marks, quotes (as calldata for your own wallet), positions and leaderboard; signing tools are local only.
- **Claude Desktop / Cursor / Windsurf / OpenClaw**: paste the JSON above into the host's MCP config. Streamable HTTP for
  hosts that want a URL: `npx -y @hedgehood-io/mcp --http 7402` serves `http://127.0.0.1:7402/mcp` (localhost only; it signs).
- `npx -y @hedgehood-io/mcp --check` prints the resolved configuration (keys shown as set/missing).

Tools: `list_markets`, `list_instruments`, `get_mark`, `get_quote`, `fill_quote`, `close_position`, `deposit_x402`,
`positions` (active: open positions with avg price, mark, unrealized P&L, time to expiry), `get_pnl`, `get_history`
(past: fills, settlements, redeems), `redeem`, `withdraw` (owner key), `authorize_session` (owner key), `leaderboard`,
`my_record`, `get_agent_record`, `register_agent` (ERC-8004, owner key), `decode_instrument`. Write tools
(`fill_quote`, `close_position`, `deposit_x402`, `redeem`, `withdraw`, `authorize_session`, `register_agent`) do nothing
without `confirm: true`; with it they simulate and return the unsigned transaction unless `dryRun: false`, and then
report the tx hash.

## Security model

- **No custody.** Nothing here holds funds. Balances live in `CashOptionMarketV2`; only the account owner's `withdraw`
  moves them out. The RFQ backend never holds a key and never sends a transaction.
- **Session keys.** The agent's key is authorized by the owner with `authorizeSession(key, expiresAt, scope,
  maxRequirement)`: it can sign and take orders and cancel, for one account, until `expiresAt`, and may not push the
  account's total collateral requirement above `maxRequirement`. It cannot withdraw, deposit from the account, change
  sessions or receive funds. `revokeSession` is immediate and voids every unfilled order the key signed.
- **Balance mode.** Fills settle premium, fee and collateral inside the deposited balance (`fillOrderAs(..., fromBalance =
  true)`): no ERC-20 approvals, nothing is ever pulled from a wallet; a shortfall reverts.
- **Dry run by default.** Every send in the SDK, CLI and MCP server simulates and returns the unsigned transaction unless
  told to broadcast (`--send`, `dryRun: false`). Keys are read from files (`chmod 600` enforced) and never logged.
- **Closing = the opposite fill.** `closePosition` / `hedgehood close` / `close_position` never use a special path: they
  read the signed on-chain position, request a quote on the other side for at most that size and send the same
  `fillOrderAs` from the session key, with the same dry-run default. A `503 not_executable:feed_not_healthy` from the desk
  is retried once after 1.5 s (the feed cycles every 20 s); nothing else is retried.
- **Quote verification.** `getQuote` checks locally that the maker's order is for this chain, book and market, addressed
  to your account (`taker`), still valid, on the side you asked, and that the signature recovers to `order.signer`, before
  anything is handed to a wallet.
- **x402 deposits** sign an EIP-3009 transfer only for the chain's USDG by full address (lookalike tokens refused), for at
  most the requested amount and the configured cap, with a validity window capped at 600 s (preset adapted from
  [`@priors/x402`](https://github.com/Leonardiae/priors/tree/main/packages/x402), MIT).

## What it talks to

- Contracts: `CashOptionMarketV2` + `CashOptionOrderBookV2` (hedgehood-options, branch `feat/market-v2-derive-style`,
  commit `131c1ae`). ABIs are vendored in `packages/sdk/src/abi/` (ABI only; the contract sources are not in this repo).
  Instrument id `= (expiry << 96) | (strike << 1) | isPut`; EIP-712 domain `CashOptionOrderBook` v`2`; the order struct
  string is tested against the contract's `ORDER_TYPEHASH`.
- Testnet 46630 (RPC `https://rpc.testnet.chain.robinhood.com`): market `0xC289617d613C9865a6595B365DaD88277282e0Ac`,
  book `0x7288a3D12e15379C3b64988b54Ab4Da759638cf5`, tNVDA2 `0x267ddeE02B44FDF4D073E124869DaA5BDbF1759D`, tUSDG
  `0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d`. Fixture feeds; not mainnet configuration. Mainnet 4663: no market yet.
- Backend (hedgehood-options `feat/rfq-backend`, PR #38): RFQ `https://agent-api.hedgehood.io`, indexer
  `https://agent-index.hedgehood.io`, x402 deposit gateway `https://agent-pay.hedgehood.io`, hosted read-only MCP
  `https://mcp.hedgehood.io/mcp`; routes and shapes in [docs/BACKEND_API.md](docs/BACKEND_API.md). The same hosts serve
  both chains; `--testnet` (default) / `--mainnet` select the deployment. The public stack runs in **dry-run mode**
  today (placeholder quote signatures, fixture pricing, gateway `SEND=0`): quotes verify but are not fillable until the
  desk mounts its key.
- Agent identity: ERC-8004 Identity Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` on 4663 (optional).

## Development

```sh
pnpm install
pnpm -r typecheck && pnpm -r test && pnpm -r build
node scripts/vendor-abis.mjs <hedgehood-options/contracts/out> <commit>   # refresh ABIs after a contract change
```

See [RELEASING.md](RELEASING.md) (npm) and [REGISTRIES.md](REGISTRIES.md) (MCP registry, Smithery, Glama, plugin
directories). Contributions: keep PRs focused, never commit keys or `.env` files.

## License

MIT. x402 USDG preset adapted from `@priors/x402` (MIT, Priors contributors).
