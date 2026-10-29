# Backend API the kit talks to

Reconciled with hedgehood-options branch `feat/rfq-backend` (PR #38, head `0cd8d23`): `docs/AGENT_MARKET_BACKEND.md`,
`rfq/app.py`, `rfq/service.py`, `indexer/app.py`, `gateway/app.py`, `gateway/x402.py`, `mcp_server/tools.py`,
`rfq/abi_v2.py`. The SDK client lives in `packages/sdk/src/rfq.ts` (`RfqPaths`, types) and `x402.ts` (gateway flow);
the hosts are in `packages/sdk/src/chains.ts` (`HEDGEHOOD_API`). Verified live on 2026-10-28 against the public
testnet deployment (dry-run mode: placeholder signatures, `SEND=0` gateway, fixture pricing).

## Hosts

| service | host | env override |
|---|---|---|
| RFQ quote service | `https://agent-api.hedgehood.io` | `HEDGEHOOD_RFQ_URL` / `--rfq-url` |
| indexer (fills, positions, leaderboard, agents) | `https://agent-index.hedgehood.io` | `HEDGEHOOD_INDEXER_URL` / `--indexer-url` |
| x402 deposit gateway | `https://agent-pay.hedgehood.io` | `HEDGEHOOD_GATEWAY_URL` / `--gateway-url` |
| hosted read-only MCP (streamable HTTP) | `https://mcp.hedgehood.io/mcp` | (`server.json` remotes) |

The same hosts serve both chains; the chain id (`--testnet` 46630 default, `--mainnet` 4663) selects the deployment the
kit reads and the `chainId` it expects in quotes. Today the backend's registry holds only the testnet NVDA market.

Conventions: JSON; integers that may exceed 2^53 are decimal strings (`*Raw`: USDG raw 6 decimals, shares 18 decimals);
prices per share (`bid`/`ask`/`mid`, `price.start/end`, `markPrice`) are JSON numbers in USDG per share; times unix
seconds; errors `{ "error": <code>, "reason": <text> }`. Instruments are named `UNDERLYING-YYYYMMDD-STRIKE-C|P` with the
New York date and the **listed per-share** strike in USD as Python `f"{usd:g}"` prints it (`NVDA-20261030-220-C`,
`…-222.5-P`). Since hedgehood-options PR #54 (`aa47f7f`) the market lays its grid in listed per-share USD and stores
each strike per token as `k = round(shareStrike x M / 1e18)`, M = the expiry's snapshotted `uiMultiplier`; the name's
strike is `round(k x 1e18 / M)` (NVDA mainnet M = 1.000775159164630595: id strike 220.170535, name `…-220-C`). The
kit derives the name from an id with `instrumentName(…, uiMultiplier)` / `MarketClient.instrumentName(id)` and
resolves a name against the expiry's strikes with `MarketClient.resolveInstrumentName()`; quote requests
(`QuoteRequest.uiMultiplier`) and marks send the per-share name. With M = 1e18 (testnet tNVDA2) nothing changes. The
backend must name and parse the same way (`rfq/registry.py` `strike_entry` / `instrument_key` keyed `usd = raw / 1e6`
at `18d189c`: per-token, so it agrees only while M = 1e18).

## RFQ

| route | request | response |
|---|---|---|
| `GET /v1/markets` | | `{ markets: [{ marketId, underlying, version, chainId, market, book, underlyingToken, uiMultiplierRaw, feeBps, retired, expiries: [{ expiry, expiryDate, capLow, capHigh, strikes (count), settled }] }] }` |
| `GET /v1/instruments?underlying=&expiry=` | `expiry` unix or `YYYYMMDD` | `{ instruments: [{ instrument, marketId, market, book, version, chainId, underlying, expiry, expiryDate, strikeUsd, strikeRaw, isPut, capLow, capHigh, instrumentId, occ, settled }] }` |
| `GET /v1/mark?instrument=` | | `{ instrument, instrumentId, market, book, version, executable, at, source, unit, bid?, ask?, mid?, delta?, iv?, halfSpreadBps?, spot?, spotSource?, surfaceAge?, reason? }` |
| `POST /v1/rfq` | `{ instrument \| underlying, expiry, strike, isPut; side: buy\|sell (the taker's side); quantity: shares as a decimal string; taker; sessionKey? }` | `QuoteResponse` below |
| `POST /v1/rpc` | JSON-RPC 2.0 `getSignerSideOrder { instrument, side, amount, takerWallet }` (AirSwap maker protocol shape), `getPricing { instruments[] }`, `getMarkets`, `getInstruments`, `getProtocols` | `{ result }` or `{ error: { code: -32000, message, data: { reason, code } } }` |

Refusals: `invalid` 400, `unknown_instrument` 404, `halted` 503, `not_executable` 503 (feed stale, listed session
closed, divergence), `risk` 409, `refused` 409. `RfqError.code` carries the code. A `503` whose `reason` is
`not_executable:feed_not_healthy` is retried once by `requestQuote` after 1.5 s (`feedRetryMs`), because the pricing feed
cycles every 20 s; every other refusal surfaces at once.

`QuoteResponse`: `{ quote: Order (17 fields, numbers as strings, side "0"/"1"), signature, digest, validUntil, startTime,
ttl, instrument, instrumentId, market, book, marketId, version, taker, takerSide, makerSide, quantityRaw, markPrice,
price { start, end, unit }, premiumStartRaw, premiumEndRaw, fee { bps, startRaw, endRaw }, decay { model, bpsPerMin,
encodedInOrder }, signing { maker, signer, kind: owner|session, domain }, funding { makerFromBalance, takerDefault,
canFill: bool|null, preview { canFill, shortfallRaw, collateralRaw, requirementRaw, requirementAfterRaw, cashDeltaRaw,
mode, sessionLimitRaw, reason, note } }, fill { to, chainId, quantityRaw, default, fillOrderAs, fillOrderAsWallet,
fillOrder, note }, dryRun, pricing }`. `canFill` is `null` when the service has no RPC for the preview (the case on the
public testnet stack today). `funding.preview.sessionLimitRaw` / a `SessionLimit:requirement` reason come from the
backend's pre-#58 model (a cap on the account's requirement); with hedgehood-options PR #58 the market charges a
session's short-risk and spend budgets instead, and the kit prices that charge itself (`MarketClient.sessionCharge`,
from `position`, the expiry's caps and `sessions()`), so it treats the backend field as informational until the
backend follows. `dryRun: true` = no signer key mounted: placeholder signature, the kit marks the quote
`fillable: false` and `fill_quote` / `hedgehood fill` refuse it.

What `RfqClient.getQuote` verifies locally before returning a quote: order well formed; `chainId`, `settlement` (= the
expected book) and `market`; `taker` = our account (zero taker refused); instrument and side as requested;
`quantityRaw` ≥ requested; `validUntil` in the future and ≤ the instrument's expiry; decay window valid; `version` 2;
the backend's `digest` equals our `orderDigest` (same EIP-712 encoding as `rfq/abi_v2.py`; the backend's golden fixture
is pinned in `packages/sdk/test/order.test.ts`); its `fill.fillOrderAs` equals our `encodeFillOrderAs`; `fee.bps` equals
the book's `protocolFeeBps`; and, unless `dryRun`, the signature recovers to `order.signer`. `MarketClient.checkOrder`
adds the on-chain `orderDigest` / `remaining` / `isValidOrderSignature` / `currentPremiumRaw` reads.

## Indexer

| route | response |
|---|---|
| `GET /v1/positions?account=&settled=0\|1` | `{ account, positions: [{ account, market, expiry, strike, isPut, quantityRaw (signed), costRaw (signed), updatedAt, settledAt, instrument, settlement }], leaderboard: row\|null, agentId, note }` |
| `GET /v1/fills?account=&market=&limit=` | `{ fills: [{ txHash, logIndex, market, blockNumber, maker, taker, digest, expiry, strike, isPut, makerSide, quantityRaw, premiumRaw, feeRaw, seenAt, hedge }] }` |
| `GET /v1/leaderboard?by=account\|agent&order=settledPnlRaw\|fills\|volumeRaw\|premiumPaidRaw\|premiumReceivedRaw&limit=` | `{ by, order, rows: [{ account, agentId, fills, premiumPaidRaw, premiumReceivedRaw, feesPaidRaw, settledPnlRaw, volumeRaw, updatedAt }] }` (by agent: `{ agentId, accounts[], ... }`) |
| `GET /v1/agents/{agentId}` | `{ agentId, record: { agentId, owner, agentURI, agentWallet, registry } \| null, accounts: rows[], registry }` |
| `GET /v1/quotes/{digest}` | the RFQ quote's status (open / expired / filled) |
| `GET /v1/pnl?account=` | `{ account, asOf, positions: [{ instrument, market, expiry, strike, isPut, quantityRaw, costRaw, avgPriceRaw\|null, markMid\|null, markBid, markAsk, markSource\|null, markAt\|null, unrealizedRaw\|null, settledAt\|null, settlementRaw\|null }], realizedRaw, unrealizedRaw\|null, feesPaidRaw, totalRaw, note }` |
| `GET /v1/history?account=&limit=&since=` | `{ account, events: [ { type: "fill", at, txHash, instrument, side: "buy"\|"sell", quantityRaw, priceRaw, premiumRaw, feeRaw, counterparty } \| { type: "settlement", at, instrument, settlementPrice, payoutRaw } \| { type: "redeem", at, txHash, expiry, amountRaw } ] }`, newest first; `since` unix seconds |

`/v1/pnl` and `/v1/history` (added alongside this kit's `close` / `pnl` / `history` features; shapes agreed with the
backend, mocked in the kit's tests): every `*Raw` is a decimal string of signed USDG raw (6 decimals) except
`quantityRaw` (signed 1e18 shares, negative = short); `markMid` / `markBid` / `markAsk` / `settlementPrice` are floats in
USDG per share; `avgPriceRaw` and `priceRaw` are per share. `unrealizedRaw` is mark-to-mid and `null` without a mark;
`totalRaw = realizedRaw + unrealizedRaw - feesPaidRaw`. The SDK reads them with `RfqClient.getPnl(account)` and
`getHistory(account, { limit, since })`; `positionPnl()` joins an on-chain position with its `/v1/pnl` row by instrument
name for the `positions` views.

The indexer keys agents by ERC-8004 id, not by address; the kit's `my_record` is `GET /v1/positions?account=` (which
includes the account's leaderboard row and `agentId`) plus recent fills, and `get_agent_record(agentId)` is
`/v1/agents/{id}`.

## Gateway (x402 deposits)

`GET /v1/instructions` → `{ summary, endpoint, method, body, flow[], asset { symbol, address, decimals, network, chainId,
eip712 { name, version } }, faucet, payTo, fee { raw }, limits { minRaw, maxRaw, dayCapRaw, ratePerS, burst, feeRaw },
markets[], after[], depositCalldata, notice }`. `faucet` is null except on a testnet whose settlement token is TestUSD:
`{ token, function "faucet()", selector, data, amountRaw, cooldownS, nextAt, sender, cli, note }` (hosted MCP:
`how_to_get_test_funds`).

`POST /v1/deposit { account, amountRaw | amount, underlying | market }`: without a payment → 402, header
`PAYMENT-REQUIRED` = body = x402 v2 `PaymentRequired` with one `exact` requirement `{ scheme, network, asset, amount =
amountRaw + fee, payTo = the float wallet, maxTimeoutSeconds 600, extra = the token's EIP-712 domain (USDG: { name "Global Dollar", version "1" }; TestUSD: { name
"Hedgehood Test USD", version "1" }),
description }`; with `PAYMENT-SIGNATURE` → facilitator verify + settle, then `market.deposit(account, amountRaw)` from
the float → 200 `{ id, status: prepared|sent|confirmed|queued|failed, account, market, underlying, amountRaw, feeRaw,
tx, txHash, error, payment { payer, transaction, network }, send, note }` + header `PAYMENT-RESPONSE`. 409 `replay`
(EIP-3009 nonce reused), 429 `rate_limited` / `day_cap`, 400 `invalid`. `status: prepared` = the operator runs `SEND=0`:
the USDG was collected, the deposit transaction is only prepared.

`depositViaGateway` reads the instructions first and refuses to sign unless: `asset.address` is this chain's USDG and
`asset.network` is this chain (`eip155:46630` / `eip155:4663`); the 402's requirement is `exact`, for that asset, to the
published `payTo`, for exactly `amountRaw + fee.raw`, under the payer's cap; and `amountRaw` is within `limits`. The
signed EIP-3009 window is capped at 600 s.

### Testnet

The gateway names the registry's token and network (`eip155:46630` on the testnet; fixed on the backend since the
2026-10-28 observation of `eip155:4663` there). tUSDG has no EIP-3009, so `deposit_x402` only becomes possible on the
testnet once the markets settle in TestUSD and a facilitator serves `eip155:46630`; `hedgehood deposit --wallet`
(approve + deposit from the owner key) works either way.

## Hosted MCP

`https://mcp.hedgehood.io/mcp` (Python FastMCP, stateless streamable HTTP, JSON responses): `list_markets`,
`list_instruments`, `get_mark`, `get_quote(instrument, side, quantity, account, session_key?)`, `get_positions`,
`get_leaderboard`, `get_agent_record`, `how_to_deposit`, and for the Stock Yield vaults `list_vaults` and
`vault_status(account, vault?)` with the shapes below. Read-only and keyless; the local `@hedgehood-io/mcp` adds the
signing tools (`fill_quote`, `deposit_x402`, `redeem`, `withdraw`, `authorize_session`, `register_agent`,
`vault_deposit`, `vault_redeem`, `vault_claim`, `vault_cancel`, and the share-lending writes).
Share lending adds the read-only `lend_status(account)` and `borrow_status(account, marketId?)` (shapes below); the
local server also has the writes `lend_deposit`, `lend_withdraw`, `borrow_supply_collateral`, `borrow_take`,
`borrow_repay`, `borrow_withdraw_collateral`.

## Stock Yield funds API (hedgehood.app)

`GET https://hedgehood.app/api/stockyield/funds` (keyuyuan/rh `rhsvc/stockyield_funds.py`, served by the hedgehood.app
API behind a 30 s warm cache; mainnet 4663 only; no auth) → `{ chainId, funds: [row], builtAt }`. A row is the fund's
on-chain snapshot with every integer as a decimal string: `{ chainId, vault, name, symbol, stock, stockSymbol, usdg,
usdgSymbol, strategy { address, name, code, legs[] } | null, depositGate, paused, phase, effectivePhase
(Collecting|Locked|Frozen), currentEpoch, schedules { "<epoch>": { depositCutoff, tradeStart, tradeEnd, expiry,
maxAtmDeviationBps } } (current and the next two), depositCapUsdg, stockHeld, usdgHeld, pendingStock, pendingUsdg,
reservedStock, reservedUsdg, totalSupply, markPrice, price (live Oracle price, "0" while the market is closed), readAt,
epochs: [{ navUsdg, income, settledAt, navPrice?, depositStock?, depositUsdg?, depositsRefunded? }] (last settled epochs,
newest first), stake (HEDGE threshold, 0 = open gate), feeBps }`; a fund the API could not read comes back as `{ vault,
error }` and is read from the chain instead. Override with `HEDGEHOOD_VAULT_API_URL` / `--vault-api-url` (`off` =
chain only). The kit never trusts the API for the fund list: `VaultRegistry.vaults()` on chain is authoritative and API
rows are joined by address; the account's shares, queues and claimables are always read on chain.

`list_vaults` / `vault_status` shape (the hosted MCP serves the same): per fund `{ vault, symbol, name, strategy { code,
name }, stock { address, symbol, decimals: 18 }, usdg, gate { address, kind: open|stake|none|unknown }, paused,
depositCap, capUsed, capLeft, totalShares, holdings { stock, usdg }, nav { usdgPerShare | null, navUsdg, stockPrice,
source: live|mark|none }, epoch { index, state: open|frozen|locked|settling, phase, nextFreezeAt, nextSettleAt,
nextCohort, schedule }, lastEpoch { index, premiumIncome, navAtFreeze, weeklyYield, settledAt } | null, feeBps?,
source: api|chain, my { account, shares, uncreditedShares?, pendingDeposit { epoch, usdg, stock, cancellable } | null,
pendingRedeem { epoch, shares, cancellable } | null, claimable { stock, usdg }, canDeposit, wallet { usdg, stock },
nextAction } }`. Amounts are decimal strings (USDG 6 decimals, shares and stock 18), times ISO-8601. `state` is
derived from the contract's `phase` and the epoch schedule: `open` while collecting before the cutoff, `frozen` once
the cutoff passed (freeze done or overdue) until an engine locks, `locked` until the expiry, `settling` after it;
`nextFreezeAt` is the cutoff of the cohort a request made now would join, `nextSettleAt` the current epoch's expiry.
`weeklyYield` = the last settled epoch's premium income over the NAV it started with (assets at the freeze plus that
cohort's deposits).

## Share lending (chain only)

No backend: everything is read from the chain (`packages/sdk/src/lending.ts`, `LendingClient`). Contracts: the USDG
lending vault `hhUSDG` (Morpho Vault V2, ERC-4626), its `MorphoMarketV1AdapterV2`, Morpho Blue, the market's
`AdaptiveCurveIrm` and its `ShareRiskOracle`; addresses in `chains.ts` `lending`.

**Market discovery** (what the hosted MCP must mirror, so a migration needs no redeploy): read `vault.liquidityAdapter()`
and `vault.liquidityData()`; the data is `abi.encode(MarketParams(loanToken, collateralToken, oracle, irm, lltv))` and its
`keccak256` is the market new deposits go to (the default market). Then `adapter.marketIdsLength()` / `marketIds(i)`
lists every market with a non-zero allocation; `blue.idToMarketParams(id)` gives their params. Only when the vault
cannot be read fall back to the registry list. The vault's caps per market are `vault.absoluteCap(id)` /
`allocation(id)` for the three adapter ids: `keccak256(abi.encode("this", adapter))`,
`keccak256(abi.encode("collateralToken", collateral))`, `keccak256(abi.encode("this/marketParams", adapter, params))`.

**Math.** Market totals are accrued to the current block as Blue does (`borrowRateView` x elapsed, three-term Taylor,
fee shares). Debt = `toAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares)` (virtual 1e6 shares / 1 asset).
Collateral value = `collateral x oracle.price() / 1e36`; max borrow = value x LLTV; health factor = max borrow / debt
(null with no debt); LTV = debt / value; liquidation price (1e36) = `ceil(debt x 1e36 x 1e18 / (collateral x lltv))`,
in USDG per share = price / 1e18. Supply rate = borrow rate (simple annual) x utilization x (1 - Blue fee) x allocated /
totalAssets x (1 - performance fee), capped at the vault's `maxRate`; null with a note when there is no market.
Oracle state: `price()` reverts = `unavailable` (borrow / withdrawCollateral / liquidate frozen; tools refuse those),
else `spot()` `live` flag true = `live`, false = `held` (market closed: last print held).

`lend_status` shape: `{ chainId, account, vault, name, symbol, asset, totalAssets, totalAssetsRaw, idle, allocated, cap,
capRaw, capLeft, withdrawableNow, utilization, supplyApy, supplyApyNote, performanceFee, market { id, borrowRate,
utilization, totalBorrow, available, collateralToken, oracle } | null, oracle <oracleStatus> | null, discovery, my {
account, shares, sharesRaw, assets, assetsRaw, walletUsdg, walletUsdgRaw, canDeposit, canWithdraw, nextAction } }`.

`borrow_status` shape: `{ chainId, account, blue, market { id, loanToken, collateralToken, oracle, irm, lltv, lltvRaw,
oraclePriceRaw, collateralPriceUsdgPerShare, borrowRate, borrowRatePerSecondRaw, utilization, totalSupply,
totalSupplyRaw, totalBorrow, totalBorrowRaw, available, availableRaw, isLiquidityMarket, note, oracleStatus { address,
state: live|held|unavailable, meaning, collateralPriceUsdgPerShare, priceRaw, stockSpot, nav, openCallLiabilities,
error } }, my { account, collateralShares, collateralRaw, collateralValue, debt, borrowAssetsRaw, borrowSharesRaw,
maxBorrow, maxBorrowRaw, borrowable, recommendedBorrowable, healthFactor, ltv, liquidationPriceUsdgPerShare,
liquidationPriceRaw, wallet { fundShares, usdg }, nextAction }, discovery, warnings[] }`. Percentages are strings
("44.67%"), USDG amounts decimal strings with 6 decimals, shares 18, `*Raw` integer strings; `healthFactor` is a number
(4 decimals) or null.
