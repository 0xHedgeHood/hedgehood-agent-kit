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
New York date and the USD strike as Python `f"{usd:g}"` prints it (`NVDA-20261030-220-C`, `…-222.5-P`); the kit
derives the name from an id with `instrumentName()` and resolves a name with `resolveInstrumentName()`.

## RFQ

| route | request | response |
|---|---|---|
| `GET /v1/markets` | | `{ markets: [{ marketId, underlying, version, chainId, market, book, underlyingToken, uiMultiplierRaw, feeBps, retired, expiries: [{ expiry, expiryDate, capLow, capHigh, strikes (count), settled }] }] }` |
| `GET /v1/instruments?underlying=&expiry=` | `expiry` unix or `YYYYMMDD` | `{ instruments: [{ instrument, marketId, market, book, version, chainId, underlying, expiry, expiryDate, strikeUsd, strikeRaw, isPut, capLow, capHigh, instrumentId, occ, settled }] }` |
| `GET /v1/mark?instrument=` | | `{ instrument, instrumentId, market, book, version, executable, at, source, unit, bid?, ask?, mid?, delta?, iv?, halfSpreadBps?, spot?, spotSource?, surfaceAge?, reason? }` |
| `POST /v1/rfq` | `{ instrument \| underlying, expiry, strike, isPut; side: buy\|sell (the taker's side); quantity: shares as a decimal string; taker; sessionKey? }` | `QuoteResponse` below |
| `POST /v1/rpc` | JSON-RPC 2.0 `getSignerSideOrder { instrument, side, amount, takerWallet }` (AirSwap maker protocol shape), `getPricing { instruments[] }`, `getMarkets`, `getInstruments`, `getProtocols` | `{ result }` or `{ error: { code: -32000, message, data: { reason, code } } }` |

Refusals: `invalid` 400, `unknown_instrument` 404, `halted` 503, `not_executable` 503 (feed stale, listed session
closed, divergence), `risk` 409, `refused` 409. `RfqError.code` carries the code.

`QuoteResponse`: `{ quote: Order (17 fields, numbers as strings, side "0"/"1"), signature, digest, validUntil, startTime,
ttl, instrument, instrumentId, market, book, marketId, version, taker, takerSide, makerSide, quantityRaw, markPrice,
price { start, end, unit }, premiumStartRaw, premiumEndRaw, fee { bps, startRaw, endRaw }, decay { model, bpsPerMin,
encodedInOrder }, signing { maker, signer, kind: owner|session, domain }, funding { makerFromBalance, takerDefault,
canFill: bool|null, preview { canFill, shortfallRaw, collateralRaw, requirementRaw, requirementAfterRaw, cashDeltaRaw,
mode, sessionLimitRaw, reason, note } }, fill { to, chainId, quantityRaw, default, fillOrderAs, fillOrderAsWallet,
fillOrder, note }, dryRun, pricing }`. `canFill` is `null` when the service has no RPC for the preview (the case on the
public testnet stack today). `dryRun: true` = no signer key mounted: placeholder signature, the kit marks the quote
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

The indexer keys agents by ERC-8004 id, not by address; the kit's `my_record` is `GET /v1/positions?account=` (which
includes the account's leaderboard row and `agentId`) plus recent fills, and `get_agent_record(agentId)` is
`/v1/agents/{id}`.

## Gateway (x402 deposits)

`GET /v1/instructions` → `{ summary, endpoint, method, body, flow[], asset { symbol, address, decimals, network, chainId },
payTo, fee { raw }, limits { minRaw, maxRaw, dayCapRaw, ratePerS, burst, feeRaw }, markets[], after[], depositCalldata,
notice }`.

`POST /v1/deposit { account, amountRaw | amount, underlying | market }`: without a payment → 402, header
`PAYMENT-REQUIRED` = body = x402 v2 `PaymentRequired` with one `exact` requirement `{ scheme, network, asset, amount =
amountRaw + fee, payTo = the float wallet, maxTimeoutSeconds 600, extra { name "Global Dollar", version "1" },
description }`; with `PAYMENT-SIGNATURE` → facilitator verify + settle, then `market.deposit(account, amountRaw)` from
the float → 200 `{ id, status: prepared|sent|confirmed|queued|failed, account, market, underlying, amountRaw, feeRaw,
tx, txHash, error, payment { payer, transaction, network }, send, note }` + header `PAYMENT-RESPONSE`. 409 `replay`
(EIP-3009 nonce reused), 429 `rate_limited` / `day_cap`, 400 `invalid`. `status: prepared` = the operator runs `SEND=0`:
the USDG was collected, the deposit transaction is only prepared.

`depositViaGateway` reads the instructions first and refuses to sign unless: `asset.address` is this chain's USDG and
`asset.network` is this chain (`eip155:46630` / `eip155:4663`); the 402's requirement is `exact`, for that asset, to the
published `payTo`, for exactly `amountRaw + fee.raw`, under the payer's cap; and `amountRaw` is within `limits`. The
signed EIP-3009 window is capped at 600 s.

### Known mismatch on the testnet stack (backend fix needed)

`gateway/x402.py` hard-codes `NETWORK = 'eip155:4663'` and `gateway/app.py` calls `x402.requirement(total, pay_to, ...)`
without `asset=` / `network=`, so on the 46630 deployment `/v1/instructions` answers `asset.address` = tUSDG but
`asset.network: "eip155:4663", chainId: 4663`, and the 402 would carry mainnet USDG `0x5fc5…d168` on `eip155:4663`
(observed live 2026-10-28). An EIP-3009 signature on that domain could never settle on testnet, so the kit refuses with
`the gateway's network eip155:4663 is not eip155:46630; nothing was signed`. Fix on the backend: pass
`asset=reg['usdg'], network=f"eip155:{reg['chainId']}"` to `x402.requirement` and the instructions. Until then
`deposit_x402` / `hedgehood deposit --x402` cannot run on testnet; `hedgehood deposit --wallet` (approve + deposit from
the owner key) works.

## Hosted MCP

`https://mcp.hedgehood.io/mcp` (Python FastMCP, stateless streamable HTTP, JSON responses): `list_markets`,
`list_instruments`, `get_mark`, `get_quote(instrument, side, quantity, account, session_key?)`, `get_positions`,
`get_leaderboard`, `get_agent_record`, `how_to_deposit`. Read-only and keyless; the local `@hedgehood-io/mcp` adds the
signing tools (`fill_quote`, `deposit_x402`, `redeem`, `withdraw`, `authorize_session`, `register_agent`).
