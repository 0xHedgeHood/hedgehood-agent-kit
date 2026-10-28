import type { Address, Hex } from "viem";
import { getDeployment } from "./chains.js";
import {
  currentPremiumRaw,
  orderFromJson,
  orderProblems,
  takerCashflow,
  verifyOrderSignature,
  type Order,
  type OrderJson,
  Side,
} from "./order.js";

/**
 * Client for the Hedgehood agent-market backend (branch feat/rfq-backend of hedgehood-options).
 *
 * ASSUMED API (the backend was not available when this kit was written; docs/AGENT_MARKET_BACKEND.md did not
 * exist yet). Every route lives under `${apiUrl}/v1`; integers that may exceed 2^53 are decimal strings, as in
 * the relay's openapi.yaml. Adjust `RfqPaths` and the response types below when the real contract lands.
 *
 *   GET  /v1/markets                       -> { markets: MarketInfo[] }
 *   GET  /v1/instruments?market=&expiry=   -> { instruments: InstrumentInfo[] }
 *   GET  /v1/mark?instrumentId=&market=    -> MarkInfo
 *   POST /v1/rfq                           -> QuoteResponse   (AirSwap-style: taker asks, maker returns a signed Order)
 *   GET  /v1/leaderboard?chainId=&period=  -> { entries: LeaderboardEntry[] }
 *   GET  /v1/agents/{address}              -> AgentRecord
 *   POST /v1/deposit                       -> x402 "exact" flow (see x402.ts)
 */
export const RfqPaths = {
  markets: "/v1/markets",
  instruments: "/v1/instruments",
  mark: "/v1/mark",
  rfq: "/v1/rfq",
  leaderboard: "/v1/leaderboard",
  agent: (address: string) => `/v1/agents/${address}`,
  deposit: "/v1/deposit",
} as const;

export interface MarketInfo {
  chainId: number;
  underlying: string;
  market: Address;
  orderBook: Address;
  settlementToken: Address;
  underlyingToken: Address;
  protocolFeeBps: number;
  /** Open expiries (unix seconds) with trading still allowed. */
  expiries: string[];
  /** Latest spot in USDG raw per share, if the backend has one. */
  spotRaw?: string;
  observedAt?: number;
}

export interface InstrumentInfo {
  instrumentId: string;
  expiry: string;
  strikeRaw: string;
  isPut: boolean;
  tradingOpen: boolean;
  /** Indicative mark in USDG raw per share, if quoted. */
  markRaw?: string;
}

export interface MarkInfo {
  instrumentId: string;
  /** Mark per share, USDG raw. */
  markRaw: string;
  /** Indicative bid/ask per share, USDG raw, when the maker streams them. */
  bidRaw?: string;
  askRaw?: string;
  spotRaw?: string;
  iv?: number;
  observedAt: number;
}

export interface QuoteRequest {
  chainId: number;
  market: Address;
  instrumentId: bigint;
  /** What the taker wants to do: buy lifts the maker's ask, sell hits the maker's bid. */
  side: "buy" | "sell";
  quantityRaw: bigint;
  /** The account the fill will be for (the agent's owner account); the quote's `taker` must equal it. */
  taker: Address;
  /** Optional: how long the taker wants the quote to stay valid (the maker may shorten it). */
  ttlSeconds?: number;
}

export interface QuoteResponse {
  order: OrderJson;
  signature: Hex;
  /** Whether the maker believes the taker can fill now (balance, requirement, trading window). */
  canFill: boolean;
  /** When !canFill: USDG raw the taker's balance is short by. */
  shortfallRaw?: string;
  /** Maker-side id for support. */
  quoteId?: string;
  reason?: string;
}

/** A quote the SDK has verified: the order parsed, the maker's EOA signature checked, taker and window checked. */
export interface VerifiedQuote {
  order: Order;
  signature: Hex;
  canFill: boolean;
  shortfallRaw: bigint;
  quoteId?: string;
  /** Pro rata taker cashflow for the requested quantity at `now` (positive = pays). */
  premiumNowRaw: bigint;
  feeNowRaw: bigint;
  netNowRaw: bigint;
  /** Seconds until validUntil at `now`. */
  secondsLeft: number;
  /** Premium per share now, USDG raw. */
  pricePerShareRaw: bigint;
  /** The whole decay ladder: premium (total, for order.quantityRaw) at validUntil. */
  premiumAtExpiryRaw: bigint;
}

export interface LeaderboardEntry {
  rank: number;
  account: Address;
  /** ERC-8004 agent id when registered. */
  agentId?: string;
  name?: string;
  pnlRaw: string;
  volumeRaw: string;
  fills: number;
  winRate?: number;
}

export interface AgentRecord {
  account: Address;
  agentId?: string;
  name?: string;
  pnlRaw: string;
  volumeRaw: string;
  fills: number;
  rank?: number;
  /** Recent fills, newest first. */
  recent?: Array<{ txHash: Hex; instrumentId: string; side: "buy" | "sell"; quantityRaw: string; premiumRaw: string; feeRaw: string; at: number }>;
}

export class RfqError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "RfqError";
  }
}

export interface RfqClientOptions {
  /** Base URL; defaults to the chain's registry entry. */
  apiUrl?: string;
  chainId: number;
  fetch?: typeof fetch;
  /** Optional bearer token for rate-limit tiers; never logged. */
  apiKey?: string;
  timeoutMs?: number;
  /** Clock override (unix seconds) for tests. */
  now?: () => number;
}

export class RfqClient {
  readonly apiUrl: string;
  readonly chainId: number;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: RfqClientOptions) {
    this.chainId = opts.chainId;
    const url = opts.apiUrl ?? getDeployment(opts.chainId).apiUrl;
    if (!url) throw new Error(`no API url for chain ${opts.chainId}; pass apiUrl`);
    this.apiUrl = url.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const u = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await this.fetchImpl(u, { method, headers, body: body === undefined ? undefined : JSON.stringify(body, bigintReplacer), signal: ctl.signal });
      const text = await r.text();
      let json: unknown = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
      if (!r.ok) {
        const detail = (json as { detail?: unknown; error?: unknown } | undefined)?.detail ?? (json as { error?: unknown } | undefined)?.error;
        throw new RfqError(`${method} ${path} -> ${r.status}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`, r.status, json);
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async markets(): Promise<MarketInfo[]> {
    const r = await this.request<{ markets: MarketInfo[] }>("GET", RfqPaths.markets, undefined, { chainId: this.chainId });
    return r.markets ?? [];
  }

  async instruments(market: Address, expiry?: bigint): Promise<InstrumentInfo[]> {
    const r = await this.request<{ instruments: InstrumentInfo[] }>("GET", RfqPaths.instruments, undefined, { chainId: this.chainId, market, expiry: expiry?.toString() });
    return r.instruments ?? [];
  }

  async mark(market: Address, instrumentId: bigint): Promise<MarkInfo> {
    return this.request<MarkInfo>("GET", RfqPaths.mark, undefined, { chainId: this.chainId, market, instrumentId: instrumentId.toString() });
  }

  /**
   * Asks the maker for a firm quote and verifies it locally before it is returned: the order is well formed, for
   * this chain and the expected book/market, addressed to `req.taker`, signed by `order.signer` (EOA recovery; a
   * contract maker is flagged `signerIsContractOrSession` for an on-chain `isValidOrderSignature` check), still
   * valid, and on the side the taker asked for (buy -> maker Ask, sell -> maker Bid).
   */
  async getQuote(req: QuoteRequest, expect: { orderBook: Address; protocolFeeBps: bigint | number }): Promise<VerifiedQuote> {
    const r = await this.request<QuoteResponse>("POST", RfqPaths.rfq, {
      chainId: req.chainId,
      market: req.market,
      instrumentId: req.instrumentId.toString(),
      side: req.side,
      quantityRaw: req.quantityRaw.toString(),
      taker: req.taker,
      ttlSeconds: req.ttlSeconds,
    });
    if (!r || typeof r !== "object" || !r.order || typeof r.signature !== "string") throw new RfqError("malformed quote response", undefined, r);
    return this.verifyQuote(r, req, expect);
  }

  /** The verification `getQuote` applies, exposed for quotes obtained elsewhere. */
  async verifyQuote(r: QuoteResponse, req: QuoteRequest, expect: { orderBook: Address; protocolFeeBps: bigint | number }): Promise<VerifiedQuote> {
    const order = orderFromJson(r.order);
    const now = this.now();
    const problems = orderProblems(order, { chainId: req.chainId, orderBook: expect.orderBook, market: req.market, taker: req.taker, now });
    if (order.taker === "0x0000000000000000000000000000000000000000") problems.push("quote is not addressed to a taker (open order, not an RFQ quote)");
    if (order.instrumentId !== req.instrumentId) problems.push("quote is for another instrument");
    const wantSide = req.side === "buy" ? Side.Ask : Side.Bid;
    if (order.side !== wantSide) problems.push(`quote side is ${order.side === Side.Ask ? "Ask" : "Bid"}, expected ${wantSide === Side.Ask ? "Ask" : "Bid"}`);
    if (order.quantityRaw < req.quantityRaw) problems.push("quote is smaller than the requested quantity");
    if (!/^0x[0-9a-fA-F]+$/.test(r.signature)) problems.push("signature is not hex");
    if (problems.length) throw new RfqError(`quote rejected: ${problems.join("; ")}`, undefined, r);
    const sigOk = await verifyOrderSignature(order, r.signature);
    if (!sigOk) throw new RfqError("quote rejected: signature does not recover to order.signer (contract or session signers need an on-chain isValidOrderSignature check)", undefined, r);
    const flow = takerCashflow(order, req.quantityRaw, expect.protocolFeeBps, now);
    const premiumNow = currentPremiumRaw(order, now);
    return {
      order,
      signature: r.signature,
      canFill: r.canFill !== false,
      shortfallRaw: r.shortfallRaw ? BigInt(r.shortfallRaw) : 0n,
      quoteId: r.quoteId,
      premiumNowRaw: flow.premium,
      feeNowRaw: flow.fee,
      netNowRaw: flow.net,
      secondsLeft: Number(order.validUntil) - now,
      pricePerShareRaw: (premiumNow * 10n ** 18n) / order.quantityRaw,
      premiumAtExpiryRaw: order.premiumEndRaw,
    };
  }

  async leaderboard(period: "7d" | "30d" | "all" = "30d", limit = 25): Promise<LeaderboardEntry[]> {
    const r = await this.request<{ entries: LeaderboardEntry[] }>("GET", RfqPaths.leaderboard, undefined, { chainId: this.chainId, period, limit });
    return r.entries ?? [];
  }

  async agent(address: Address): Promise<AgentRecord> {
    return this.request<AgentRecord>("GET", RfqPaths.agent(address), undefined, { chainId: this.chainId });
  }
}

function bigintReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}
