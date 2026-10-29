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
| [`@hedgehood-io/sdk`](packages/sdk) | viem-based TypeScript SDK: deployments, ABIs, instrument ids, EIP-712 orders, `fillOrderAs` calldata, RFQ client with local quote verification, `closePosition`, P&L and history readers, x402 USDG payer, ERC-8004 helpers, `VaultClient` for the Stock Yield vaults, `LendingClient` for share lending (lend USDG / borrow against fund shares) | `pnpm add @hedgehood-io/sdk viem` |
| [`@hedgehood-io/mcp`](packages/mcp) | local MCP server (stdio + streamable HTTP) signing with the agent's key; 32 tools (18 market + 6 vault + 8 lending), every write needs `confirm: true` and is a dry run by default | `npx -y @hedgehood-io/mcp` |
| [`@hedgehood-io/cli`](packages/cli) | `hedgehood` binary: `join`, `deposit`, `quote`, `fill`, `close`, `positions`, `pnl`, `history`, `redeem`, `withdraw`, `session authorize\|revoke\|status`, `vaults`, `vault status\|deposit\|redeem\|claim\|cancel`, `lend status\|deposit\|withdraw`, `borrow status\|collateral\|take\|repay\|withdraw-collateral` | `npx @hedgehood-io/cli --help` |
| [`skills/hedgehood-options`](skills/hedgehood-options/SKILL.md) | the skill an agent reads: market model, the loop, the Stock Yield vaults, share lending, key hygiene, troubleshooting | `/plugin marketplace add 0xHedgeHood/hedgehood-agent-kit` |
| [`examples/`](examples) | a 30-line "agent buys a weekly call" script and an MCP config snippet | `pnpm tsx examples/buy-weekly-call.ts` |

## Quickstart (testnet, 5 minutes)

```sh
# 1. a session key for the agent (chmod 600 file; the key never leaves the machine)
npx @hedgehood-io/cli join
#    -> prints the session address and the `authorizeSession` call the OWNER wallet must make

# 2. owner wallet (anywhere): authorize the session with a spend budget (here 100 USDG of premium + fees) and deposit tUSDG
cast send <market> 'authorizeSession(address,uint64,uint256,uint256,uint256)' <session> <expiresAt> 3 0 100000000 --rpc-url https://rpc.testnet.chain.robinhood.com
#    (scope 3 = trade + cancel; maxShortRisk 0 = the key cannot sell to open; maxSpend 100 USDG raw; or, with the
#    owner key on this machine: `hedgehood session authorize --max-spend 100 [--max-short-risk 60] --send`)
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

### Stock Yield vaults (mainnet 4663 and testnet)

The same kit deposits into and withdraws from Hedgehood's **Stock Yield vaults**: v2 `EpochFund`s that hold one
tokenized stock (NVDA, GOOGL, TSLA, AMZN, META, AAPL, MSFT) and USDG, write a covered call (or run the wheel) on it
every week, and issue transferable NAV shares (`hhNVDA-CC`, …). The premium stays in NAV. Everything is asynchronous:
a deposit queues until the next epoch freeze (Monday morning New York), is priced at that NAV and becomes shares; a
redemption queues the same way and is paid in kind (stock + USDG) at the freeze after the current option expires; both
are then claimed. Requests can be cancelled until the cutoff. Vault actions are sent by the **owner wallet** (the
account itself); a market session key cannot touch a vault.

```sh
hedgehood --mainnet vaults                                         # NAV/share, epoch state, next freeze, cap, last week's yield (no key)
hedgehood --mainnet --owner-key-file ~/.hedgehood/owner.key vault deposit 100 --vault hhNVDA-CC        # dry run: approve + requestDeposit
hedgehood --mainnet --owner-key-file ~/.hedgehood/owner.key vault deposit 100 --vault hhNVDA-CC --send
hedgehood --mainnet vault status --vault NVDA-CC                   # shares, queued requests (cancellable?), claimable
hedgehood --mainnet --owner-key-file ... vault redeem all --vault hhNVDA-CC --send   # paid at the next freeze, after expiry
hedgehood --mainnet --owner-key-file ... vault claim --vault hhNVDA-CC --send        # once vault status shows claimable
hedgehood --mainnet --owner-key-file ... vault cancel deposit --vault hhNVDA-CC --send
```

MCP: `list_vaults`, `vault_status`, `vault_deposit`, `vault_redeem`, `vault_claim`, `vault_cancel` (the writes are gated
like `fill_quote`: `confirm: true`, dry run unless `dryRun: false`, owner key). The hosted read-only server exposes
`list_vaults` / `vault_status` with the same shapes.

### Share lending (mainnet 4663 and testnet)

Two instant (no-epoch) sides on Morpho: **lend** USDG into the `hhUSDG` lending vault (a Morpho Vault V2, ERC-4626;
interest accrues per second from borrowers, 10% performance fee, curator caps), or **borrow** USDG on the Morpho Blue
market whose collateral is a Stock Yield fund share (`hhNVDA-CC`), LLTV 62.5%. The collateral oracle (`ShareRiskOracle`)
is a conservative share value re-marked every week after the Monday lock; a position with health factor below 1 can be
liquidated, so the tools refuse a borrow or collateral withdrawal that would end below 1 and warn above 70% of the LLTV.
With no usable oracle price they refuse borrow / withdraw-collateral (Blue would revert); repay and pledging still work.
Fund shares must be in the wallet to pledge: claim what a fund owes you first (`vault claim`). Owner key for every write.

```sh
hedgehood --mainnet lend status                                       # size, cap, liquidity, supply rate, your hhUSDG (no key)
hedgehood --mainnet --owner-key-file ~/.hedgehood/owner.key lend deposit 100            # dry run: approve + deposit
hedgehood --mainnet --owner-key-file ... lend withdraw all --send     # redeem every share (instant while liquidity allows)
hedgehood --mainnet --account <addr> borrow status                    # LLTV, oracle, rate; collateral, debt, HF, LTV, liquidation price
hedgehood --mainnet --owner-key-file ... borrow collateral all        # approve + supplyCollateral (fund shares from the wallet)
hedgehood --mainnet --owner-key-file ... borrow take 50               # refused if HF < 1 after; warns above 70% of LLTV
hedgehood --mainnet --owner-key-file ... borrow repay all --send      # repay by shares: clears the accruing debt exactly
hedgehood --mainnet --owner-key-file ... borrow withdraw-collateral all --send
```

The market is **discovered from the lending vault** (its `liquidityAdapter` / `liquidityData` and the adapter's
`marketIds`), with the deployment registry (`chains.ts` `lending.markets`) as the fallback, so the scheduled mainnet
oracle migration (new market id) needs no kit release; `--market <id>` / `marketId` targets another market. MCP:
`lend_status`, `lend_deposit`, `lend_withdraw`, `borrow_status`, `borrow_supply_collateral`, `borrow_take`, `borrow_repay`,
`borrow_withdraw_collateral` (writes gated like `vault_deposit`).

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
`my_record`, `get_agent_record`, `register_agent` (ERC-8004, owner key), `faucet` (testnet TestUSD), `decode_instrument`; Stock Yield vaults:
`list_vaults`, `vault_status`, `vault_deposit`, `vault_redeem`, `vault_claim`, `vault_cancel` (owner key); share lending:
`lend_status`, `lend_deposit`, `lend_withdraw`, `borrow_status`, `borrow_supply_collateral`, `borrow_take`, `borrow_repay`,
`borrow_withdraw_collateral` (owner key). Write tools
(`fill_quote`, `close_position`, `deposit_x402`, `redeem`, `withdraw`, `authorize_session`, `register_agent`, `faucet`,
`vault_deposit`, `vault_redeem`, `vault_claim`, `vault_cancel`, `lend_deposit`, `lend_withdraw`, `borrow_*` except
`borrow_status`) do nothing without `confirm: true`; with it they simulate
and return the unsigned transaction(s) unless `dryRun: false`, and then report the tx hash(es).

## Security model

- **No custody.** Nothing here holds funds. Balances live in `CashOptionMarketV2`; only the account owner's `withdraw`
  moves them out. The RFQ backend never holds a key and never sends a transaction. Vault shares and queues belong to
  the account in the `EpochFund`; only the account (or a position manager it approved on chain) can redeem, cancel or
  claim, so every vault write is sent from the owner key, never from a session key.
- **Session keys.** The agent's key is authorized by the owner with `authorizeSession(key, expiresAt, scope,
  maxShortRisk, maxSpend)`: it can sign and take orders and cancel, for one account, until `expiresAt`, within two
  cumulative budgets (USDG raw; `SessionLimit` beyond either). `maxShortRisk` (`riskLeft`) bounds the worst case of the
  shorts it opens: each sell leg costs `ceil(openedShort x maxPayout / 1e18)`, `openedShort` being the shares beyond the
  long held (selling a long is free) and `maxPayout` `capHigh - strike` (call) or `strike - capLow` (put) per token; 0,
  the kit's default, = it cannot sell to open. `maxSpend` (`spendLeft`) bounds the premium + fees it pays as buyer, less
  the worst case of the shorts a buy closes (0 = buy to close only; the kit requires an explicit `--max-spend
  <usdg|unlimited>`). `type(uint256).max` is unlimited for either. The SDK prices each leg's charge in advance
  (`MarketClient.sessionCharge`, `ClosePlan.sessionCharge`), and the CLI and MCP show it with every quote, fill and
  close. A key can lose at most `maxShortRisk + maxSpend` plus the longs it can sell and the shorts it can buy back up to
  their worst case. It cannot withdraw, deposit from the account, change sessions or receive funds. Re-authorizing resets
  both budgets and voids every order the key signed before; `revokeSession` is immediate and voids every unfilled order
  the key signed.
- **Balance mode.** Fills settle premium, fee and collateral inside the deposited balance (`fillOrderAs(..., fromBalance =
  true)`): no ERC-20 approvals, nothing is ever pulled from a wallet; a shortfall reverts. A session key can only fill
  this way (the market reverts `SessionWalletMode` on a session leg in wallet mode), and the kit refuses or forces
  `fromBalance = false` from a session key before anything is sent.
- **Listed strikes.** Names (`NVDA-20261030-220-C`) carry the listed per-share strike; the id packs the per-token strike
  the market stores, `round(shareStrike x uiMultiplier / 1e18)` with the multiplier the expiry snapshotted (NVDA mainnet
  1.000775…: 220 is stored as 220.170535). The kit maps between the two with the expiry's `uiMultiplier`.
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

- Contracts: `CashOptionMarketV2` + `CashOptionOrderBookV2` + `ChainlinkExpirySource` (hedgehood-options PR #58, branch
  `contracts/redteam-fixes`, commit `ccbab74`: session short-risk budget, unreadable stock controls, phase-boundary round
  hints; on top of PR #54's spend budget, listed per-share grid and multiplier tolerance). ABIs are vendored in
  `packages/sdk/src/abi/` (ABI only; the contract sources are not in this repo). The testnet market below was deployed
  from the earlier `131c1ae` build: until it is redeployed from `ccbab74`, session reads and `authorizeSession` from this
  kit do not match it.
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
- Stock Yield vaults (hedgehood-vaults `contracts/src/v2`, tag `audit-v2-freeze-2026-10-21`; ABIs vendored in
  `packages/sdk/src/abi/{epochFund,vaultRegistry,openDepositGate,stakeThresholdGate}.ts`). Mainnet 4663:
  `VaultRegistry` `0x868502F926AE068B61EA9CC55042A9F962651e76`, `OpenDepositGate` `0x337B27c931873e6Ef087e8f84034b96F1d6eeFA5`,
  eight funds (`hhNVDA-CC` `0x4a1c42b0E0D229B677D574d3dCdc2A5Dff848373`, `hhNVDA-WHEEL`, `hhGOOGL-CC`, `hhTSLA-CC`,
  `hhAMZN-CC`, `hhMETA-CC`, `hhAAPL-CC`, `hhMSFT-CC`; the full list is `getVaults(4663)` in `chains.ts`), owner Safe
  `0xB5C9…489b`, cap 100k USDG per fund, fee 20% of premium. Fund snapshots (NAV, schedules, last epochs, fee) come from
  the public `GET https://hedgehood.app/api/stockyield/funds` when it answers, else from the chain. Testnet 46630:
  registry `0xBeE38aF4Fc4f50A0C04bDdA45Bec6cBABFf476b9`, one fund `hhNVDA-CC` `0x2a7CC7E34a1CFAda9e3aeA978e805dbaB05D83b4`
  on open-mint tNVDA2 (fixture feed; not mainnet configuration).
- Share lending (Morpho Blue `morpho-org/morpho-blue` 8e26ca6, AdaptiveCurveIrm `morpho-blue-irm` b9a5806, Vault V2
  `morpho-org/vault-v2` 10ed1ea + `MorphoMarketV1AdapterV2`, hedgehood-vaults `contracts/src/collateral/ShareRiskOracle.sol`
  at `dd9bddd`; ABIs vendored with `scripts/vendor-abis.mjs --lending`). Mainnet 4663: canonical Blue
  `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`, lending vault `hhUSDG` `0x54Bc097643BB9fd4ab004f11859893655529E954`
  (adapter `0xdEbAd49D242967CBf0DDAe8626873ad54cF7878A`, Safe owner/curator, 24 h timelock, cap 20k USDG, fee 10%),
  market `0x789202f8…b7aa` (hhNVDA-CC vs USDG, oracle `0x6EcA44BBB41D3176A451910C4f735A51AdAb4237`, IRM `0x2BD3…0fa1`, LLTV
  62.5%; to be migrated to a new oracle and market id, which the kit picks up from the vault). Testnet 46630: test Blue
  `0xa0BA91A2F99894044CCD82cA48e5C795BA7570B6`, vault `0x6ab073F0E3F1610C4Ad9e7Dc19Ca25F831682f00`, v5 market
  `0x375cd2da…32df` (PoC parameters, not mainnet configuration).

## Development

```sh
pnpm install
pnpm -r typecheck && pnpm -r test && pnpm -r build
node scripts/vendor-abis.mjs <hedgehood-options/contracts/out> <commit>   # refresh ABIs after a contract change
node scripts/vendor-abis.mjs --lending <hedgehood-vaults checkout> <commit>  # Blue, IRM, ShareRiskOracle, Vault V2 + adapter
```

See [RELEASING.md](RELEASING.md) (npm) and [REGISTRIES.md](REGISTRIES.md) (MCP registry, Smithery, Glama, plugin
directories). Contributions: keep PRs focused, never commit keys or `.env` files.

## License

MIT. x402 USDG preset adapted from `@priors/x402` (MIT, Priors contributors).
