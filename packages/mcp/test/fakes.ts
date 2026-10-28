/**
 * Test doubles shared by the MCP and CLI tests: a JSON-RPC node answering the market's reads from fixtures, a maker
 * quoting both sides of every instrument, and an indexer with /v1/pnl and /v1/history rows. Everything goes through one
 * `fetch` so no network is touched.
 */
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeFillOrderAs, encodeInstrumentId, erc20Abi, instrumentName, marketV2Abi, orderBookV2Abi, orderDigest, orderToJson, Side, signOrder, type Order, type QuoteResponse } from "@hedgehood-io/sdk";

export const ACCOUNT = "0x3333333333333333333333333333333333333333" as Address;
export const BOOK = "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5" as Address;
export const MARKET = "0xC289617d613C9865a6595B365DaD88277282e0Ac" as Address;
export const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const EXPIRY = 1793390400n; // 2026-10-30 16:00 New York
export const STRIKES = [210_000_000n, 220_000_000n];
export const CALL220 = encodeInstrumentId(EXPIRY, 220_000_000n, false);
export const PUT210 = encodeInstrumentId(EXPIRY, 210_000_000n, true);
export const ONE = 10n ** 18n;
export const RPC = "https://rpc.testnet.chain.robinhood.com";

export interface ChainState {
  /** positions(account, EXPIRY) as the contract returns them: [call@210, put@210, call@220, put@220]. */
  positions: bigint[];
  collateralRaw: bigint;
  requirementRaw: bigint;
  /** eth_call payloads the node received for the book (simulated fills). */
  simulated: Hex[];
}

export function defaultChain(): ChainState {
  return { positions: [0n, -(ONE / 2n), ONE, 0n], collateralRaw: 100_000_000n, requirementRaw: 10_000_000n, simulated: [] };
}

const abi = [...marketV2Abi, ...orderBookV2Abi, ...erc20Abi];

function rpcResult(state: ChainState, method: string, params: unknown[]): unknown {
  if (method === "eth_chainId") return "0xb626";
  if (method === "eth_blockNumber") return "0x10";
  if (method !== "eth_call") throw new Error(`fake rpc: unexpected ${method}`);
  const call = params[0] as { to: Address; data: Hex; from?: Address };
  const { functionName, args } = decodeFunctionData({ abi, data: call.data });
  const enc = (result: unknown) => encodeFunctionResult({ abi, functionName, result } as Parameters<typeof encodeFunctionResult>[0]);
  switch (functionName) {
    case "collateral":
      return enc(state.collateralRaw);
    case "requirement":
      return enc(state.requirementRaw);
    case "freeCollateral":
      return enc(state.collateralRaw - state.requirementRaw);
    case "balanceOf":
      return enc(0n);
    case "accountExpiries":
      return enc([EXPIRY]);
    case "openedExpiryCount":
      return enc(1n);
    case "openedExpiries":
      return enc([EXPIRY]);
    case "strikesOf":
      return enc(STRIKES);
    case "positions":
      return enc(state.positions);
    case "protocolFeeBps":
      return enc(50n);
    case "tradingOpen":
      return enc(true);
    case "requirementIfTraded":
      return enc(0n);
    case "uiMultiplier":
      return enc(ONE);
    case "expiryInfo":
      return enc({ openedAt: 1792785600n, settled: false, settledByOwner: false, uiMultiplier: ONE, anchor: 215_000_000n, capLow: 150_500_000n, capHigh: 279_500_000n, settlementPrice: 0n, rawSettlementPrice: 0n, strikes: STRIKES });
    case "sessions":
      return enc([BigInt(Math.floor(Date.now() / 1000) + 86400), 3n, 0n]);
    case "fillOrderAs":
      state.simulated.push(call.data);
      return "0x";
    default:
      throw new Error(`fake rpc: no fixture for ${functionName}(${(args as unknown as unknown[] | undefined)?.join(", ") ?? ""})`);
  }
}

/** The maker's `POST /v1/rfq` answer for a request body, signed for real so the SDK's verification passes. */
export async function makerQuote(body: { instrument: string; side: "buy" | "sell"; quantity: string; taker: Address }, opts: { now?: number; dryRun?: boolean } = {}): Promise<QuoteResponse> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const isPut = body.instrument.endsWith("-P");
  const strike = BigInt(Math.round(Number(body.instrument.split("-")[2]) * 1e6));
  const instrumentId = encodeInstrumentId(EXPIRY, strike, isPut);
  const quantityRaw = BigInt(Math.round(Number(body.quantity) * 1e6)) * 10n ** 12n;
  const side = body.side === "buy" ? Side.Ask : Side.Bid;
  const perShare = body.side === "buy" ? 1_680_000n : 1_570_000n; // NVDA-20261030-220-C live 2026-10-28: buy 1.68 / sell 1.57
  const premium = (perShare * quantityRaw) / ONE;
  const order: Order = {
    maker: maker.address, signer: maker.address, taker: body.taker, chainId: 46630n, settlement: BOOK, market: MARKET, instrumentId, side, quantityRaw, minFillRaw: 0n,
    premiumStartRaw: premium, premiumEndRaw: premium, startTime: BigInt(now - 1), validUntil: BigInt(now + 20), stockMultiplier: ONE, nonce: BigInt(now), fromBalance: true,
  };
  const signature = opts.dryRun ? (("0x" + "ab".repeat(65)) as Hex) : await signOrder(maker, order);
  return {
    quote: orderToJson(order), signature, digest: orderDigest(order), validUntil: order.validUntil.toString(), startTime: order.startTime.toString(), ttl: 20,
    instrument: body.instrument, instrumentId: instrumentId.toString(), market: MARKET, book: BOOK, marketId: "nvda-testnet", version: 2, taker: body.taker,
    takerSide: body.side, makerSide: side, quantityRaw: quantityRaw.toString(), markPrice: 1.625, price: { start: Number(perShare) / 1e6, end: Number(perShare) / 1e6, unit: "USDG per share" },
    premiumStartRaw: premium.toString(), premiumEndRaw: premium.toString(), fee: { bps: 50, startRaw: "0", endRaw: "0" }, decay: { model: "linear", bpsPerMin: 0, encodedInOrder: true },
    signing: { maker: maker.address, signer: maker.address, kind: "owner", domain: { name: "CashOptionOrderBook", version: "2", chainId: 46630, verifyingContract: BOOK } },
    funding: { makerFromBalance: true, takerDefault: "balance", canFill: true, preview: { canFill: true, mode: "balance" } },
    fill: { to: BOOK, chainId: 46630, quantityRaw: quantityRaw.toString(), default: "fillOrderAs", fillOrderAs: encodeFillOrderAs(BOOK, body.taker, order, signature, quantityRaw, true).data, fillOrderAsWallet: null, fillOrder: "0x" },
    dryRun: opts.dryRun ?? false,
  };
}

export const NAME220C = instrumentName("NVDA", EXPIRY, 220_000_000n, false);
export const NAME210P = instrumentName("NVDA", EXPIRY, 210_000_000n, true);

export function pnlFixture(asOf: number) {
  return {
    account: ACCOUNT,
    asOf,
    positions: [
      { instrument: NAME220C, market: MARKET, expiry: Number(EXPIRY), strike: "220000000", isPut: false, quantityRaw: ONE.toString(), costRaw: "1688400", avgPriceRaw: "1680000", markMid: 1.625, markBid: 1.57, markAsk: 1.68, markSource: "desk", markAt: asOf, unrealizedRaw: "-55000", settledAt: null, settlementRaw: null },
      { instrument: NAME210P, market: MARKET, expiry: Number(EXPIRY), strike: "210000000", isPut: true, quantityRaw: (-(ONE / 2n)).toString(), costRaw: "-400000", avgPriceRaw: "800000", markMid: 0.7, markBid: 0.65, markAsk: 0.75, markSource: "desk", markAt: asOf, unrealizedRaw: "50000", settledAt: null, settlementRaw: null },
    ],
    realizedRaw: "1200000",
    unrealizedRaw: "-5000",
    feesPaidRaw: "12400",
    totalRaw: "1182600",
    note: "marks at desk mid",
  };
}

export function historyFixture(now: number) {
  return {
    account: ACCOUNT,
    events: [
      { type: "fill", at: now - 3600, txHash: "0x" + "01".repeat(32), instrument: NAME220C, side: "buy", quantityRaw: ONE.toString(), priceRaw: "1680000", premiumRaw: "1680000", feeRaw: "8400", counterparty: maker.address },
      { type: "fill", at: now - 7200, txHash: "0x" + "02".repeat(32), instrument: NAME210P, side: "sell", quantityRaw: (ONE / 2n).toString(), priceRaw: "800000", premiumRaw: "400000", feeRaw: "2000", counterparty: maker.address },
      { type: "settlement", at: now - 86400, instrument: "NVDA-20261023-200-C", settlementPrice: 212.5, payoutRaw: "1250000" },
      { type: "redeem", at: now - 86000, txHash: "0x" + "03".repeat(32), expiry: 1792785600, amountRaw: "1250000" },
    ],
  };
}

export interface FakeWorld {
  fetch: typeof fetch;
  chain: ChainState;
  /** Every backend request: path + parsed body. */
  backend: Array<{ url: URL; body?: unknown }>;
}

/** One fetch for everything: the RPC node, the maker (`https://rfq.test`) and the indexer (`https://index.test`). */
export function fakeWorld(opts: { chain?: ChainState; quoteDryRun?: boolean; quoteFails?: Array<{ status: number; body: unknown }>; indexerDown?: boolean } = {}): FakeWorld {
  const chain = opts.chain ?? defaultChain();
  const backend: FakeWorld["backend"] = [];
  const failures = [...(opts.quoteFails ?? [])];
  const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const text = init?.body ? String(init.body) : undefined;
    if (url.origin === RPC) {
      const req = JSON.parse(text!) as { id: number; method: string; params: unknown[] } | Array<{ id: number; method: string; params: unknown[] }>;
      const one = (r: { id: number; method: string; params: unknown[] }) => {
        try {
          return { jsonrpc: "2.0", id: r.id, result: rpcResult(chain, r.method, r.params) };
        } catch (e) {
          return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } };
        }
      };
      return new Response(JSON.stringify(Array.isArray(req) ? req.map(one) : one(req)), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = text ? JSON.parse(text) : undefined;
    backend.push({ url, body });
    const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const now = Math.floor(Date.now() / 1000);
    if (url.pathname === "/v1/rfq") {
      const f = failures.shift();
      if (f) return ok(f.body, f.status);
      return ok(await makerQuote(body as Parameters<typeof makerQuote>[0], { dryRun: opts.quoteDryRun }));
    }
    if (opts.indexerDown) return ok({ error: "unavailable" }, 503);
    if (url.pathname === "/v1/pnl") return ok(pnlFixture(now));
    if (url.pathname === "/v1/history") {
      const h = historyFixture(now);
      const since = url.searchParams.get("since");
      const limit = url.searchParams.get("limit");
      let events = h.events;
      if (since) events = events.filter((e) => e.at >= Number(since));
      if (limit) events = events.slice(0, Number(limit));
      return ok({ ...h, events });
    }
    if (url.pathname === "/v1/positions") return ok({ account: ACCOUNT, positions: [], leaderboard: { account: ACCOUNT, fills: 2, settledPnlRaw: "1200000" }, agentId: null });
    if (url.pathname === "/v1/fills") return ok({ fills: [] });
    return ok({ error: "unknown_route" }, 404);
  }) as typeof fetch;
  return { fetch: fetchImpl, chain, backend };
}

/** Points the market client's RPC transport (global fetch) at the fake node for the duration of `fn`. */
export async function withGlobalFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}
