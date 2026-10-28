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
| [`@hedgehood-io/sdk`](packages/sdk) | viem-based TypeScript SDK: deployments, ABIs, instrument ids, EIP-712 orders, `fillOrderAs` calldata, RFQ client with local quote verification, x402 USDG payer, ERC-8004 helpers | `pnpm add @hedgehood-io/sdk viem` |
| [`@hedgehood-io/mcp`](packages/mcp) | local MCP server (stdio + streamable HTTP) signing with the agent's key; 14 tools, every write needs `confirm: true` and is a dry run by default | `npx -y @hedgehood-io/mcp` |
| [`@hedgehood-io/cli`](packages/cli) | `hedgehood` binary: `join`, `deposit`, `quote`, `fill`, `positions`, `redeem`, `withdraw`, `session authorize\|revoke\|status` | `npx @hedgehood-io/cli --help` |
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
hedgehood quote <expiry>:220:call --side buy --qty 1
hedgehood fill --instrument <expiry>:220:call --side buy --qty 1          # dry run: simulates, prints calldata
hedgehood fill --instrument <expiry>:220:call --side buy --qty 1 --send   # broadcasts, prints the tx hash
hedgehood positions
```

Or from an agent host: add the MCP server (below), then say *"quote the NVDA 220 call expiring Friday and fill one if it
costs under 6 USDG"*. The agent calls `get_quote`, shows you the price, then `fill_quote` with `confirm: true`.

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
- **Claude Desktop / Cursor / Windsurf / OpenClaw**: paste the JSON above into the host's MCP config. Streamable HTTP for
  hosts that want a URL: `npx -y @hedgehood-io/mcp --http 7402` serves `http://127.0.0.1:7402/mcp` (localhost only; it signs).
- `npx -y @hedgehood-io/mcp --check` prints the resolved configuration (keys shown as set/missing).

Tools: `list_markets`, `list_instruments`, `get_mark`, `get_quote`, `fill_quote`, `deposit_x402`, `positions`, `redeem`,
`withdraw` (owner key), `authorize_session` (owner key), `leaderboard`, `my_record`, `register_agent` (ERC-8004, owner
key), `decode_instrument`. Write tools do nothing without `confirm: true`; with it they simulate and return the unsigned
transaction unless `dryRun: false`, and then report the tx hash.

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
- Backend (RFQ, x402 deposit gateway, indexer): the API is **assumed**, see [docs/BACKEND_API.md](docs/BACKEND_API.md);
  `RfqPaths` in the SDK is the one place to adjust when the real contract lands.
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
