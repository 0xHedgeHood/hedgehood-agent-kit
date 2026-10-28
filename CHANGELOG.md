# Changelog

## 0.3.0 (unreleased)

Stock Yield vaults: agents deposit into and withdraw from Hedgehood's v2 `EpochFund`s through the same kit.

- `@hedgehood-io/sdk`: `VaultClient` (`listVaults`, `status`, `vaultInfo`, `accountInfo`, `resolveVault`, and the
  owner-wallet plans `planDeposit` / `requestDeposit` (ERC-20 approve(s) + `requestDeposit`), `planRedeem` /
  `requestRedeem` (amount or `"all"`), `cancelDeposit`, `cancelRedeem`, `claim`; `sendPlan` runs a plan dry (default)
  or for real, in order). Fund snapshots come from the public `GET https://hedgehood.app/api/stockyield/funds` on
  mainnet when it answers, else from the chain (`VaultRegistry.vaults()` + fund views); NAV per share is derived from
  `stockHeld`, `usdgHeld`, the live Oracle price (or the fund's last mark when the market is closed) and `totalSupply`.
  Epoch state is `open | frozen | locked | settling` with `nextFreezeAt` / `nextSettleAt`. `getVaults(chainId)` and the
  `vaults` entry of the deployment registry (mainnet registry `0x8685…1e76`, OpenDepositGate `0x337B…eFA5`, the eight
  funds; testnet registry `0xBeE3…76b9`, one `hhNVDA-CC`). ABIs vendored from hedgehood-vaults
  `contracts/src/v2` at tag `audit-v2-freeze-2026-10-21` (`scripts/vendor-abis.mjs --vaults`): `epochFundAbi`,
  `vaultRegistryAbi`, `openDepositGateAbi`, `stakeThresholdGateAbi`. `sendTxRequest` shared by both clients. 13 new
  unit tests (71 total).
- `@hedgehood-io/cli`: `vaults` (table; no key needed), `vault status [--vault]`, `vault deposit <usdg> --vault
  <addr|symbol> [--stock] [--send]`, `vault redeem <shares|all> --vault … [--send]`, `vault claim --vault … [--to]
  [--send]`, `vault cancel deposit|redeem --vault … [--send]`; owner key only, dry run unless `--send`, `--json`
  everywhere; `--vault-api-url <url|off>`. 4 new tests (13 total).
- `@hedgehood-io/mcp`: tools `list_vaults`, `vault_status`, `vault_deposit`, `vault_redeem`, `vault_claim`,
  `vault_cancel` (writes gated like `fill_quote`: `confirm` + `dryRun` / `HEDGEHOOD_DRY_RUN`; owner key). The server
  now starts on mainnet 4663, where only the vaults are deployed (`ctx.marketDeployment` is optional; market tools
  report the missing listing). `HEDGEHOOD_VAULT_API_URL` (`off` = chain only). 24 tools; 5 new tests (16 total).
- Share lending (same release): `@hedgehood-io/sdk` `LendingClient`: `lendStatus(account)` (vault size, idle /
  allocated, cap and room, withdrawable now, utilization, supply rate = borrow rate x utilization x (1 - fee), the
  account's hhUSDG shares and value), `planLendDeposit` (approve + `deposit`) / `planLendWithdraw` (amount = `withdraw`,
  `"all"` = `redeem` every share), `borrowStatus(account, marketId?)` (LLTV, oracle price and state, rate, totals; the
  account's collateral, accrued debt, max borrow, health factor, LTV, liquidation price), and the plans
  `planSupplyCollateral` (approve + `supplyCollateral`), `planBorrow`, `planRepay` (`"all"` repays by shares) and
  `planWithdrawCollateral`, all through the shared `sendPlan` (moved to `send.ts`; `VaultClient.sendPlan` uses it). Guards:
  a borrow or collateral withdrawal ending below health factor 1, or made while the `ShareRiskOracle` has no price, is
  refused; the plan warns above 70% of LLTV. The market is discovered from the vault's liquidity adapter and allocated
  market ids (`discoverMarkets`), with the new `lending` entry of the deployment registry as fallback (mainnet: Blue
  `0x9D53…1010`, vault `0x54Bc…E954`, market `0x7892…b7aa`; testnet: test Blue `0xa0BA…70B6`, vault `0x6ab0…2f00`, v5
  market `0x375c…32df`). ABIs vendored with `scripts/vendor-abis.mjs --lending` from hedgehood-vaults `dd9bddd`
  (`morphoBlueAbi`, `adaptiveCurveIrmAbi`, `shareRiskOracleAbi`, `vaultV2Abi`, `morphoMarketV1AdapterV2Abi`). CLI:
  `lend status|deposit|withdraw`, `borrow status|collateral|take|repay|withdraw-collateral` (`--market`, `--send`,
  `--json`). MCP: `lend_status`, `lend_deposit`, `lend_withdraw`, `borrow_status`, `borrow_supply_collateral`,
  `borrow_take`, `borrow_repay`, `borrow_withdraw_collateral` (32 tools). Tests: SDK 83, MCP 22, CLI 17.
- Docs: README (vault quickstart, tool and command lists, addresses), `docs/BACKEND_API.md` (the funds API and the
  hosted-MCP tool names), the skill's "Stock Yield vaults" section (vault vs market, the three-step flow, up to a week
  to redeem, non-US only), `AGENTS.md`. Versions are not bumped in this change.

## 0.2.0 (2026-10-28)

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
