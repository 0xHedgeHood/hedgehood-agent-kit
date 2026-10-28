# Backend API the kit assumes

The agent-market backend (hedgehood-options branch `feat/rfq-backend`: RFQ service, x402 deposit gateway, hosted
read-only MCP, indexer) was not available when this kit was written and `docs/AGENT_MARKET_BACKEND.md` did not exist yet.
The SDK codes to the shape below behind one small client (`packages/sdk/src/rfq.ts`, `RfqPaths`; x402 flow in
`packages/sdk/src/x402.ts`). When the real contract lands, change those two files and the fixtures in
`packages/sdk/test/rfq.test.ts` / `x402.test.ts`.

Conventions assumed from the relay's `docs/api/openapi.yaml`: JSON, integers that may exceed 2^53 as decimal strings
(`*Raw`), USDG raw = 6 decimals, quantities = 18-decimal shares, unix seconds, errors as `{"detail": "..."}`, addresses
EIP-55 in responses. Base URL per chain is in the SDK registry (`deployments[chainId].apiUrl`, placeholders
`https://agents-testnet.hedgehood.app` / `https://agents.hedgehood.app`).

| route | request | response | used by |
|---|---|---|---|
| `GET /v1/markets?chainId=` | | `{ markets: MarketInfo[] }` (`underlying, market, orderBook, settlementToken, underlyingToken, protocolFeeBps, expiries[], spotRaw?, observedAt`) | `list_markets` (best effort; chain reads are the source of truth) |
| `GET /v1/instruments?chainId=&market=&expiry=` | | `{ instruments: InstrumentInfo[] }` (`instrumentId, expiry, strikeRaw, isPut, tradingOpen, markRaw?`) | `list_instruments` marks |
| `GET /v1/mark?chainId=&market=&instrumentId=` | | `MarkInfo` (`markRaw, bidRaw?, askRaw?, spotRaw?, iv?, observedAt`) | `get_mark` |
| `POST /v1/rfq` | `{ chainId, market, instrumentId, side: "buy"\|"sell", quantityRaw, taker, ttlSeconds? }` | `{ order: OrderJson, signature, canFill, shortfallRaw?, quoteId?, reason? }` — AirSwap-style: the maker signs a V2 `Order` with `taker` = the requesting account, `validUntil` seconds away, optional linear decay (`premiumStartRaw/EndRaw`, `startTime`). `side: buy` → maker `Ask`; `sell` → maker `Bid`. | `get_quote`, `quote`, `fill` |
| `POST /v1/deposit` | `{ chainId, market, account, amountRaw }` | **402** with `PAYMENT-REQUIRED` (x402 v2, one `exact` requirement: `network eip155:4663|46630`, `asset` = USDG, `amount` ≤ `amountRaw`, `payTo` = gateway, `extra: {name: "Global Dollar", version: "1"}`); on resend with `PAYMENT-SIGNATURE` → **200** `{ depositTxHash, account, amountRaw }` + `PAYMENT-RESPONSE`. The gateway settles the EIP-3009 transfer and calls `market.deposit(account, amount)`. | `deposit_x402`, `deposit --x402` |
| `GET /v1/leaderboard?chainId=&period=7d\|30d\|all&limit=` | | `{ entries: LeaderboardEntry[] }` (`rank, account, agentId?, name?, pnlRaw, volumeRaw, fills, winRate?`) | `leaderboard` |
| `GET /v1/agents/{address}?chainId=` | | `AgentRecord` (`account, agentId?, name?, pnlRaw, volumeRaw, fills, rank?, recent[]`) | `my_record` |

Client-side verification of a quote (done regardless of what the backend says): well-formed order, `chainId`,
`settlement` = the expected book, `market`, `taker` = our account (zero taker refused as "not an RFQ quote"),
`instrumentId` and side as requested, `quantityRaw ≥` requested, `validUntil` in the future and ≤ the instrument's
expiry, decay window valid, and the signature recovers (EOA) to `order.signer`. A contract or session signer is also
checkable on chain with `CashOptionOrderBookV2.isValidOrderSignature` (`MarketClient.checkOrder`).

Open questions for the backend owners: authentication (none assumed; `apiKey` bearer supported), rate limits, whether
`/v1/rfq` is per market or global, the exact 402 `resource` fields and whether `payTo` is a per-chain constant the SDK
should pin, and the hosted read-only MCP URL for `server.json`'s `remotes` entry (placeholder `https://mcp.hedgehood.io/mcp`).
