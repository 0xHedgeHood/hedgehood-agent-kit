# Changelog

## 0.4.1 (2026-10-29)

- Portfolio dashboard: summary card and realized P&L bars for closed / settled positions, including accounts with no
  remaining open positions. Hide the raw-field schema note in human output; JSON is unchanged. Shared by CLI and MCP.

## 0.4.0 (2026-10-29)

**Upgrade note:** owner-key fills and closes now default to wallet mode, which may approve the market to pull
premium, fees and collateral from the wallet. Use `--from-balance` (CLI) or `fromBalance: true` (MCP) to retain
balance mode. Session keys remain balance-only, and transactions remain dry-run unless explicitly enabled.

**One wallet, all markets (no contract change).** Each `CashOptionMarketV2` (one per underlying) keeps its own
balance, positions and session grant; the kit now reads and trades them like one account.

- SDK `account`: `readAccount` reads every market of the chain in parallel (one Multicall3 batch per market,
  JSON-RPC batched): collateral, locked, free, the wallet's allowance to the market, open / expired positions and the
  configured key's session; the wallet balance; totals; `tradable` (live session + free balance). A market whose reads
  fail is marked (`error`, `failed`) instead of failing the view. `fundingAdvice` names a market's shortfall, the free
  balance elsewhere and the owner's command; `planDeposit`, `planWithdrawAll`, `planRebalance`. `resolveMarket(chainId,
  ticker|address)`, `MULTICALL3`.
- SDK `funding`: `planFillFunding` for wallet mode (`fromBalance = false`, the account's own key: the market pulls
  premium, fee and any collateral shortfall from the wallet; approve exactly what the fill can pull, or max) and balance
  mode (optionally deposit the shortfall first), as ordered approve / deposit / fill steps with `problems`;
  `minReceivedUntilExpiry`; `sessionFundingRefusal`. `MarketClient.sendPlan` runs such plans (dry run by default,
  errors decoded per step).
- CLI: `hedgehood account [--key]`; `withdraw --all` (one tx per market) and `withdraw --market`; `rebalance --from
  --to --amount`; `deposit --market [--approve exact|max]`. `fill` / `close` trade in the quote's market (instrument
  ticker or quote file) and take `--signer session|owner`, `--from-balance`, `--auto-deposit`, `--approve`. The account's
  own key now fills in **wallet mode by default** (also in self-custody, where the session key is the account); the dry
  run lists every transaction. A session key stays balance-only and is refused, before anything is sent, when its
  market's balance is short, with the shortfall, the free balance elsewhere and `hedgehood rebalance …` / `hedgehood
  deposit … --market X --wallet`. `fill --json` prints a single object.
- MCP: `get_account`, `deposit`, `rebalance` (owner, confirm + dryRun), `withdraw` takes `market` and `all`;
  `get_quote`, `get_mark`, `list_instruments`, `positions`, `close_position`, `deposit_x402` take `market` (or the
  instrument name's ticker); `fill_quote` / `close_position` take `signer`, `fromBalance`, `autoDeposit`, `approve`
  with the same owner / session rules; `list_markets` lists every market. 37 tools including `get_dashboard`.
- Tests after combining the account and dashboard changes: SDK 131, MCP 33, CLI 30; the shared fakes answer
  Multicall3 and per-market state.

- User portfolio ASCII dashboard shared by SDK `renderPnlDashboard`, CLI `dashboard` / `pnl --ascii`, and MCP
  `get_dashboard` (text plus structured data). Shows account-wide totals, active positions, signed snapshot bars,
  report/mark times and unknown marks without a fabricated equity curve. Dashboard queries need only an address.
- CLI `markets` alias `list`; `--ascii` tables for markets and positions. Existing JSON commands retain their shapes.
- Local-build, address-only Claude Code setup and synthetic preview: [terminal guide](docs/TERMINAL.md).

## 0.3.0 (tagged 2026-10-29, never published to npm; everything below ships in 0.4.0)

**Testnet on TestUSD, 20 markets (hedgehood-options #63, deployed 2026-10-29).** The testnet markets were redeployed on
TestUSD (`hUSD-test`, open faucet) and GOOGL was added: `chains.ts` 46630 lists 20 V2 markets (NVDA, AMD, MU, SNDK, CRWV,
NBIS, IONQ, INTC, TSM, ASML, TSLA, PLTR, GME, MSTR, COIN, CRCL, RKLB, RGTI, ORCL, GOOGL) with `settlementToken` and `usdg`
= TestUSD; the old tUSDG markets are no longer listed. Verified live: faucet, deposit, session authorize from a browser
wallet, session-key buy and close for that account, per-key P&L.

**Testnet faucet and ERC-8004 testnet registry (hedgehood-options `testnet/onboarding-kit` @ `8e860ad`).**

- Testnet `identityRegistry` is `0x8004A818BFB912233c491871b3d84c89A494BD9e`, the ERC-8004 reference deployment's testnet
  address (live on 46630; the mainnet address `0x8004A169…a432` has no code there), so `register` / `register_agent` work
  on the testnet. Checked against the reference `IdentityRegistryUpgradeable` (v2.0.0) on an anvil fork of 46630.
- `chains.ts` 46630 `faucet`: TestUSD (`hUSD-test`, "Hedgehood Test USD", no value) at its CREATE2 address
  `0x850DE815d41F6983Aaf09247f9a465c0aefff04C`; SDK `getFaucet`, `encodeFaucet`, `readFaucet`, `faucetRefusal`,
  `drawFaucet`; ABI `testUsdAbi` vendored with `scripts/vendor-abis.mjs --testusd`. Mainnet refuses.
- CLI `hedgehood faucet [--send]` and MCP tool `faucet` (confirm + dryRun): `faucet()` from the owner key (else the
  session key), refused during the 24 h cooldown or before the token is deployed.
- SKILL.md: testnet onboarding (connect -> faucet -> deposit -> session key -> quote -> fill).

**Breaking: session short-risk budget (hedgehood-options PR #58, `contracts/redteam-fixes` @ `ccbab74`).** Market, book
and (new) `ChainlinkExpirySource` ABIs re-vendored from that commit; selectors and types are unchanged, the meanings are
not. Needs a market deployed from `ccbab74` (PR #58 deployed); the testnet registry entry still points at the `131c1ae`
build.

- `authorizeSession(key, expiresAt, scope, maxShortRisk, maxSpend)`: the 4th argument (was `maxRequirement`, a cap on
  the account's total requirement) is a cumulative short-risk budget. Each sell leg signed or taken by the key charges
  `ceil(openedShort x maxPayout / 1e18)`, `openedShort = max(0, qty - max(0, positionBefore))`, `maxPayout = capHigh -
  K` (call) or `K - capLow` (put) per token; selling a long held is free; 0 = the key cannot sell to open; max uint =
  unlimited. `maxSpend` is now charged on buys as `max(0, paid - floor(closedShort x maxPayout / 1e18))`: buying to
  open in full, buying back a short free up to its worst case. Both budgets only decrease; `SessionLimit` means the
  leg needs more than its budget has left (the market no longer reverts it for a raised total requirement).
- SDK: `AuthorizeSessionOptions.maxShortRisk` (default 0) replaces `maxRequirement` (passing it throws with a pointer);
  `encodeAuthorizeSession(…, maxShortRisk, maxSpend)`; `SessionInfo.riskLeft` replaces `maxRequirement` (`sessions()`
  returns `(expiresAt, authorizedAt, scope, riskLeft, spendLeft)`). New `session` module: `maxPayoutPerToken`,
  `openedShortOf`, `closedShortOf`, `shortRiskCharge`, `spendCharge`, `sessionChargeOf` (with `withinBudget`),
  `maxPaidUntilExpiry` (the most an ask can cost until `validUntil`), `describeSessionCharge`, `sessionLimitDetail`;
  `formatSessionCap` moved there and shows what is left of an `UNLIMITED` grant (>= 2^128) as "unlimited".
  `MarketClient.position(id)`, `maxPayoutPerToken(id)`, `sessionCharge(leg)`; `planClose` returns `sessionCharge` when
  given a session key; `MarketClient.send(…, { sessionCharge })` names the budget in a `SessionLimit` error.
- Errors: `SessionLimit` hint explains both budgets; `StockControlsPaused` now also covers unreadable token controls;
  `InvalidRoundHint`, `OracleUnavailable` and `RoundWalkExhausted` of the settlement source are decoded (incl. the empty
  hint at an aggregator phase boundary on `settleLate` / `failingAt`).
- CLI: `--max-short-risk <usdg|unlimited>` (default 0) on `session authorize` and `join`; `--max-requirement` is a hidden
  alias that errors with the replacement; the printed `cast` command passes `maxShortRisk`. `session status` and
  `positions` show `riskLeft` and `spendLeft`; `quote`, `fill` and `close` print the leg's session charge and flag a
  fill that would revert `SessionLimit`.
- MCP: `authorize_session` takes `maxShortRisk` (default `"0"`) and refuses `maxRequirement`; `positions` shows
  `riskLeft` / `spendLeft`; `get_quote`, `fill_quote` and `close_position` return `sessionCharge`, and `get_quote`'s
  `next` says when the session key cannot fill.
- Docs: skill (budgets, close is free, troubleshooting rows for `SessionLimit`, `StockControlsPaused`,
  `InvalidRoundHint`), README, package READMEs, `docs/BACKEND_API.md` (the backend's `sessionLimitRaw` preview still
  models the requirement cap). Tests: SDK 116 (+19), MCP 27 (+1), CLI 22 (+2), incl. call/put charges, partial
  closes and flips, rounding, CLI flags and status output.

**Breaking: V2 audit fixes (hedgehood-options PR #54, `contracts/audit-fixes-v2` @ `aa47f7f`).** Market and book ABIs
re-vendored with `scripts/vendor-abis.mjs` from that commit. The live testnet market `0xC289…e0Ac` was built from
`131c1ae` (before the fixes): session reads and `authorizeSession` from this version only work against a market
redeployed from `aa47f7f` (the registry entry stays until that redeploy exists).

- Session authorize signature: `authorizeSession(key, expiresAt, scope, maxRequirement, maxSpend)`. SDK
  `encodeAuthorizeSession(…, maxRequirement, maxSpend)` and `MarketClient.authorizeSession(key, expiresAt, { maxSpend,
  maxRequirement?, trade?, cancel? })` (`maxSpend` required). For both caps 0 now means none (0 `maxSpend`: the key
  cannot buy; 0 `maxRequirement`, the new default: no new requirement, it cannot write options) and `UNLIMITED`
  (`type(uint256).max`) means no cap; before, 0 `maxRequirement` meant unlimited. CLI `session authorize` and `join`
  (with an owner key) require `--max-spend <usdg|unlimited>` and print a suggested budget when it is missing;
  `--max-requirement <usdg|unlimited>` defaults to 0; the printed `cast` command takes five arguments. MCP
  `authorize_session` takes `maxSpend` (required unless `revoke`) and `maxRequirement` (default `"0"`), both accepting
  `"unlimited"`, and echoes the terms.
- Session status: `MarketClient.session()` reads `(expiresAt, authorizedAt, scope, maxRequirement, spendLeft)`;
  `SessionInfo` gains `authorizedAt` and `spendLeft`; `formatSessionCap` ("unlimited" / "none (0)" / USDG). Shown by
  `hedgehood session status`, `hedgehood positions` and the MCP `positions` tool.
- Balance mode is forced on the session path: `MarketClient.fillOrderAs(…, fromBalance = false)` from a session key
  (signer != account) throws before anything is built (the market reverts `SessionWalletMode`); MCP `close_position`
  forces `fromBalance: true` for a session key and says so; `orderProblems` flags a session-signed order that is not
  `fromBalance`. Wallet mode stays available when the signer is the account itself.
- Revert decoding: `decodeMarketError` / `MarketRevertError` (new `errors` module) decode market and book custom errors
  from viem errors with a hint (`SessionLimit`: spend budget or requirement cap; `SessionWalletMode`;
  `NotAuthorizedSigner` incl. orders signed before a re-authorization; `TradingUnavailable`; …). `MarketClient.send`
  rethrows simulated or sent reverts as `MarketRevertError`, so the CLI and MCP errors carry the name and the hint.
- Listed per-share strikes: names (`NVDA-20261030-220-C`) and labels show `round(k x 1e18 / M)`, M being the expiry's
  snapshotted `uiMultiplier`, and map back to the per-token strike packed in the id (NVDA mainnet M =
  1.000775159164630595: 220 is stored as 220.170535). New `shareStrikeOf`, `tokenStrikeOf`, `instrumentNameOf`,
  `UNIT_MULTIPLIER`; `instrumentName` / `describeInstrument` take the multiplier (default 1e18); `parseInstrumentName`
  returns `shareStrikeRaw` (was `strikeRaw`); `resolveInstrumentName` accepts `{ expiry, uiMultiplier, strikes }`
  entries; `gridFor(anchor, multiplier, params)` mirrors the contract's `gridFor(uint256,uint256)` (the two-argument
  form assumes 1e18). `MarketClient.expiryMultiplier` (cached), `instrumentName(id)`, `resolveInstrumentName(name)`;
  `ExpiryInfo.shareStrikes`; `Position` gains `shareStrike` and `uiMultiplier` (the snapshot reads `expiryInfo` per
  expiry). `QuoteRequest.uiMultiplier` and `RfqClient.mark({ …, uiMultiplier })` send the per-share name; `planClose`
  uses the position's multiplier. CLI `markets`, `instruments`, `quote`, `fill`, `close`, `positions` and `decode`
  (`--multiplier`, else read from the market) and MCP `list_markets`, `list_instruments`, `get_mark`, `get_quote`,
  `positions`, `close_position`, `decode_instrument` (`uiMultiplier` input; now reads the expiry from the market) all
  use the per-share strike; `expiry:strike:kind` and the MCP `strike` field take the per-share strike.
- Bids' pro rata premium rounds down (asks still up): `premiumFor` follows the book.
- Docs: skill (session limits, per-share strikes, troubleshooting rows for `SessionLimit`, `SessionWalletMode`,
  `StockMultiplierChanged`), README security model and quickstart, `docs/BACKEND_API.md` (naming rule; the backend's
  `rfq/registry.py` at `18d189c` still names by `raw / 1e6`, which agrees only while M = 1e18), package READMEs.
  Tests: SDK 97 (+14), MCP 26 (+4), CLI 20 (+3), including maxSpend encoding, per-share naming under the NVDA mainnet
  multiplier and the ORCL grid vector from the contract tests, and forced balance mode.

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
