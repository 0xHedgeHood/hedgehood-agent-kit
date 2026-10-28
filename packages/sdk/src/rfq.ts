import type { Address, Hex } from "viem";
import { encodeFillOrderAs } from "./calldata.js";
import { getDeployment, type BackendHosts } from "./chains.js";
import { instrumentName, decodeInstrumentId } from "./instrument.js";
import {
  currentPremiumRaw,
  orderDigest,
  orderFromJson,
  orderProblems,
  takerCashflow,
  verifyOrderSignature,
  type Order,
  type OrderJson,
  Side,
} from "./order.js";

/**
 * Client for the Hedgehood agent-market backend (hedgehood-options branch `feat/rfq-backend`, PR #38 @ 0cd8d23:
 * `rfq/app.py`, `rfq/service.py`, `indexer/app.py`). Two services, two hosts:
 *
 *  RFQ (quote service)
 *    GET  /v1/markets                              -> { markets: MarketSummary[] }
 *    GET  /v1/instruments?underlying=&expiry=      -> { instruments: InstrumentListing[] }   (expiry: unix seconds or YYYYMMDD)
 *    GET  /v1/mark?instrument=NVDA-20261030-220-C  -> MarkView
 *    POST /v1/rfq  { instrument | underlying,expiry,strike,isPut; side: buy|sell; quantity (shares, decimal string); taker; sessionKey? }
 *                                                  -> QuoteResponse (the desk's signed V2 Order addressed to `taker`)
 *    POST /v1/rpc  JSON-RPC 2.0 `getSignerSideOrder {instrument, side, amount, takerWallet}` (AirSwap maker protocol shape),
 *                  `getPricing {instruments[]}`, `getMarkets`, `getInstruments`, `getProtocols`
 *    errors: { error: invalid|unknown_instrument|halted|not_executable|risk|refused, reason } with 400/404/503/503/409/409
 *  Indexer
 *    GET  /v1/positions?account=&settled=0|1       -> PositionsView (positions + the account's leaderboard row + agentId)
 *    GET  /v1/fills?account=&market=&limit=        -> { fills: FillRow[] }
 *    GET  /v1/leaderboard?by=account|agent&order=settledPnlRaw|fills|volumeRaw|premiumPaidRaw|premiumReceivedRaw&limit=
 *    GET  /v1/agents/{agentId}                     -> AgentView (ERC-8004 record + accounts trading under it)
 *    GET  /v1/quotes/{digest}                      -> QuoteStatus
 *
 * Integers that may exceed 2^53 are decimal strings (`*Raw`); prices per share (`bid`, `ask`, `mid`, `price.start`) are
 * JSON numbers in USDG per share. The backend is in dry-run mode until the operator mounts the quote signer key: a quote
 * with `dryRun: true` carries a placeholder signature and cannot be filled (the book would revert `InvalidSignature`).
 */
export const RfqPaths = {
  markets: "/v1/markets",
  instruments: "/v1/instruments",
  mark: "/v1/mark",
  rfq: "/v1/rfq",
  rpc: "/v1/rpc",
  positions: "/v1/positions",
  fills: "/v1/fills",
  leaderboard: "/v1/leaderboard",
  agent: (agentId: string | number | bigint) => `/v1/agents/${agentId}`,
  quote: (digest: string) => `/v1/quotes/${digest}`,
  deposit: "/v1/deposit",
  instructions: "/v1/instructions",
} as const;

export interface MarketSummary {
  marketId: string;
  underlying: string;
  version: 1 | 2;
  chainId: number;
  market: Address;
  book: Address;
  underlyingToken: Address;
  uiMultiplierRaw: string;
  feeBps: string;
  retired: boolean;
  expiries: Array<{ expiry: string; expiryDate: string; capLow: string; capHigh: string; strikes: number; settled: boolean }>;
}

export interface InstrumentListing {
  /** `NVDA-20261030-220-C` */
  instrument: string;
  marketId: string;
  market: Address;
  book: Address;
  version: 1 | 2;
  chainId: number;
  underlying: string;
  expiry: string;
  expiryDate: string;
  strikeUsd: number;
  strikeRaw: string;
  isPut: boolean;
  capLow: string;
  capHigh: string;
  instrumentId: string;
  /** Listed OCC symbol of the same strike/expiry. */
  occ: string;
  settled: boolean;
}

export interface MarkView {
  instrument: string;
  instrumentId: string;
  market: Address;
  book: Address;
  version: 1 | 2;
  executable: boolean;
  at: number;
  source?: string;
  unit: "USDG per share";
  /** Only when a row exists; USDG per share. */
  bid?: number;
  ask?: number;
  mid?: number;
  delta?: number;
  iv?: number;
  halfSpreadBps?: number;
  spot?: number;
  spotSource?: string;
  surfaceAge?: number;
  /** Why not executable (`no_row`, `stale`, `closed`, ...). */
  reason?: string;
}

export interface FundingPreview {
  canFill: boolean | null;
  shortfallRaw?: string;
  collateralRaw?: string;
  requirementRaw?: string;
  requirementAfterRaw?: string;
  cashDeltaRaw?: string;
  mode: "balance" | "wallet";
  sessionLimitRaw?: string | null;
  reason?: string | null;
  note?: string;
}

export interface QuoteResponse {
  /** The signed V2 order (`fromBalance` is the maker's mode). */
  quote: OrderJson;
  signature: Hex;
  digest: Hex;
  validUntil: string;
  startTime: string;
  ttl: number;
  instrument: string;
  instrumentId: string;
  market: Address;
  book: Address;
  marketId: string;
  version: 1 | 2;
  taker: Address;
  takerSide: "buy" | "sell";
  makerSide: 0 | 1;
  quantityRaw: string;
  markPrice: number;
  price: { start: number; end: number; unit: string };
  premiumStartRaw: string;
  premiumEndRaw: string;
  fee: { bps: number; startRaw: string; endRaw: string; note?: string };
  decay: { model: string; bpsPerMin: number; encodedInOrder: boolean; note?: string };
  signing: { maker: Address; signer: Address; kind: "owner" | "session"; domain: { name: string; version: string; chainId: number; verifyingContract: Address } };
  funding: { makerFromBalance: boolean; takerDefault: "balance" | "wallet"; canFill: boolean | null; preview: FundingPreview };
  fill: { to: Address; chainId: number; quantityRaw: string; default: "fillOrderAs" | "fillOrder"; fillOrderAs: Hex | null; fillOrderAsWallet: Hex | null; fillOrder: Hex; note?: string };
  /** True while the backend runs without a signer key: placeholder signature, not fillable. */
  dryRun: boolean;
  pricing?: Record<string, unknown>;
}

/** A quote the SDK has verified locally. */
export interface VerifiedQuote {
  order: Order;
  signature: Hex;
  digest: Hex;
  instrument: string;
  /** False for a backend dry-run quote (placeholder signature): do not try to fill it. */
  fillable: boolean;
  dryRun: boolean;
  canFill: boolean | null;
  shortfallRaw: bigint;
  funding: FundingPreview;
  feeBps: number;
  /** Pro rata taker cashflow for the requested quantity at `now` (positive = pays). */
  premiumNowRaw: bigint;
  feeNowRaw: bigint;
  netNowRaw: bigint;
  secondsLeft: number;
  /** Premium per share now, USDG raw. */
  pricePerShareRaw: bigint;
  /** Total premium (for order.quantityRaw) at validUntil. */
  premiumAtExpiryRaw: bigint;
  /** The backend's indicative mid per share (USDG, number). */
  markPrice: number;
  raw: QuoteResponse;
}

export interface QuoteRequest {
  chainId: number;
  market: Address;
  instrumentId: bigint;
  /** The taker's side: buy lifts the maker's ask, sell hits the maker's bid. */
  side: "buy" | "sell";
  quantityRaw: bigint;
  /** The account the fill is for; the quote's `taker` must equal it. */
  taker: Address;
  /** The session key that will send the fill, for the backend's SessionLimit preview. */
  sessionKey?: Address;
  /** Underlying ticker (for the instrument name); default "NVDA". */
  underlying?: string;
}

export interface PositionRow {
  account: Address;
  market: Address;
  expiry: number;
  strike: string;
  isPut: number | boolean;
  /** Signed 1e18 shares. */
  quantityRaw: string;
  /** Signed USDG raw paid (positive) or received (negative), taker fees included. */
  costRaw: string;
  updatedAt: number;
  settledAt: number | null;
  instrument: string;
  settlement: { priceRaw: string; blockNumber: number; txHash: Hex } | null;
}

export interface LeaderboardRow {
  account: Address;
  agentId: string | null;
  fills: number;
  premiumPaidRaw: string;
  premiumReceivedRaw: string;
  feesPaidRaw: string;
  settledPnlRaw: string;
  volumeRaw: string;
  updatedAt: number;
}

export interface AgentLeaderboardRow {
  agentId: string;
  accounts: Address[];
  fills: number;
  premiumPaidRaw: string;
  premiumReceivedRaw: string;
  feesPaidRaw: string;
  settledPnlRaw: string;
  volumeRaw: string;
}

export interface PositionsView {
  account: Address;
  positions: PositionRow[];
  leaderboard: LeaderboardRow | null;
  agentId: string | null;
  note?: string;
}

export interface FillRow {
  txHash: Hex;
  logIndex: number;
  market: Address;
  blockNumber: number;
  maker: Address;
  taker: Address;
  digest: Hex;
  expiry: number;
  strike: string;
  isPut: number | boolean;
  makerSide: 0 | 1;
  quantityRaw: string;
  premiumRaw: string;
  feeRaw: string;
  seenAt: number;
  hedge: unknown;
}

export interface AgentView {
  agentId: string;
  record: { agentId: string; owner: Address; agentURI: string; agentWallet?: Address; registry: Address } | { agentId: string; error: string } | null;
  accounts: LeaderboardRow[];
  registry: Address;
}

export type LeaderboardOrder = "settledPnlRaw" | "fills" | "volumeRaw" | "premiumPaidRaw" | "premiumReceivedRaw";

export class RfqError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The backend's machine-readable code (`halted`, `not_executable`, `risk`, `unknown_instrument`, `invalid`, ...). */
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "RfqError";
  }
}

export interface RfqClientOptions {
  chainId: number;
  /** Override hosts; defaults to the registry's public hostnames. */
  hosts?: Partial<BackendHosts>;
  fetch?: typeof fetch;
  /** Bearer token, if the deployment requires one; never logged. */
  apiKey?: string;
  timeoutMs?: number;
  /** Clock override (unix seconds) for tests. */
  now?: () => number;
}

export class RfqClient {
  readonly chainId: number;
  readonly hosts: BackendHosts;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: RfqClientOptions) {
    this.chainId = opts.chainId;
    const base = getDeployment(opts.chainId).api;
    const trim = (u: string) => u.replace(/\/+$/, "");
    this.hosts = { rfq: trim(opts.hosts?.rfq ?? base.rfq), indexer: trim(opts.hosts?.indexer ?? base.indexer), gateway: trim(opts.hosts?.gateway ?? base.gateway), mcp: opts.hosts?.mcp ?? base.mcp };
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private async request<T>(host: keyof BackendHosts, method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    const u = new URL(this.hosts[host] + path);
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
        const b = (json ?? {}) as { error?: unknown; reason?: unknown; detail?: unknown };
        const code = typeof b.error === "string" ? b.error : undefined;
        const reason = b.reason ?? b.detail ?? (typeof b.error === "string" ? undefined : b.error);
        throw new RfqError(`${method} ${path} -> ${r.status}${code ? ` ${code}` : ""}${reason ? `: ${typeof reason === "string" ? reason : JSON.stringify(reason)}` : ""}`, r.status, code, json);
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- rfq

  async markets(): Promise<MarketSummary[]> {
    const r = await this.request<{ markets: MarketSummary[] }>("rfq", "GET", RfqPaths.markets);
    return r.markets ?? [];
  }

  /** `expiry` as unix seconds or `YYYYMMDD`. */
  async instruments(underlying?: string, expiry?: bigint | string): Promise<InstrumentListing[]> {
    const r = await this.request<{ instruments: InstrumentListing[] }>("rfq", "GET", RfqPaths.instruments, undefined, { underlying, expiry: expiry?.toString() });
    return r.instruments ?? [];
  }

  /** Indicative mark by backend instrument name (`NVDA-20261030-220-C`) or by id + underlying. */
  async mark(instrument: string | { instrumentId: bigint; underlying: string }): Promise<MarkView> {
    const name = typeof instrument === "string" ? instrument : nameOf(instrument.instrumentId, instrument.underlying);
    return this.request<MarkView>("rfq", "GET", RfqPaths.mark, undefined, { instrument: name });
  }

  /** The raw quote as the backend returns it (REST `POST /v1/rfq`). */
  async requestQuote(req: QuoteRequest): Promise<QuoteResponse> {
    const body: Record<string, unknown> = { instrument: nameOf(req.instrumentId, req.underlying ?? "NVDA"), side: req.side, quantity: sharesDecimal(req.quantityRaw), taker: req.taker };
    if (req.sessionKey) body.sessionKey = req.sessionKey;
    return this.request<QuoteResponse>("rfq", "POST", RfqPaths.rfq, body);
  }

  /** The same quote through the AirSwap-style JSON-RPC face (`getSignerSideOrder`). */
  async getSignerSideOrder(req: QuoteRequest): Promise<QuoteResponse> {
    const r = await this.request<{ result?: QuoteResponse; error?: { code: number; message: string; data?: { reason?: string; code?: string } } }>("rfq", "POST", RfqPaths.rpc, {
      jsonrpc: "2.0",
      id: 1,
      method: "getSignerSideOrder",
      params: { instrument: nameOf(req.instrumentId, req.underlying ?? "NVDA"), side: req.side, amount: sharesDecimal(req.quantityRaw), takerWallet: req.taker, ...(req.sessionKey ? { sessionKey: req.sessionKey } : {}) },
    });
    if (r.error) throw new RfqError(`getSignerSideOrder: ${r.error.message}${r.error.data?.reason ? `: ${r.error.data.reason}` : ""}`, undefined, r.error.data?.code, r);
    if (!r.result) throw new RfqError("getSignerSideOrder: empty result", undefined, undefined, r);
    return r.result;
  }

  /**
   * Asks the desk for a firm quote and verifies it locally: well-formed order for this chain/book/market, addressed to
   * `req.taker`, the instrument and side requested, size >= requested, still valid, the backend's `digest` equal to
   * our own `orderDigest`, its `fill.fillOrderAs` calldata equal to our encoding, and (unless `dryRun`) the signature
   * recovering to `order.signer`. A dry-run quote is returned with `fillable: false`.
   */
  async getQuote(req: QuoteRequest, expect: { orderBook: Address; protocolFeeBps?: bigint | number }): Promise<VerifiedQuote> {
    const r = await this.requestQuote(req);
    return this.verifyQuote(r, req, expect);
  }

  async verifyQuote(r: QuoteResponse, req: QuoteRequest, expect: { orderBook: Address; protocolFeeBps?: bigint | number }): Promise<VerifiedQuote> {
    if (!r || typeof r !== "object" || !r.quote || typeof r.signature !== "string") throw new RfqError("malformed quote response", undefined, "malformed", r);
    if (r.version !== undefined && Number(r.version) !== 2) throw new RfqError(`quote is for a V${r.version} market; this kit trades V2 only`, undefined, "version", r);
    const order = orderFromJson(r.quote);
    const now = this.now();
    const problems = orderProblems(order, { chainId: req.chainId, orderBook: expect.orderBook, market: req.market, taker: req.taker, now });
    if (order.taker === ZERO) problems.push("quote is not addressed to a taker (open order, not an RFQ quote)");
    if (order.instrumentId !== req.instrumentId) problems.push("quote is for another instrument");
    const wantSide = req.side === "buy" ? Side.Ask : Side.Bid;
    if (order.side !== wantSide) problems.push(`quote side is ${order.side === Side.Ask ? "Ask" : "Bid"}, expected ${wantSide === Side.Ask ? "Ask" : "Bid"}`);
    if (order.quantityRaw < req.quantityRaw) problems.push("quote is smaller than the requested quantity");
    if (!/^0x[0-9a-fA-F]+$/.test(r.signature)) problems.push("signature is not hex");
    const digest = orderDigest(order);
    if (r.digest && r.digest.toLowerCase() !== digest.toLowerCase()) problems.push("backend digest differs from the local orderDigest (contract or encoding mismatch)");
    if (r.fill?.fillOrderAs && /^0x[0-9a-fA-F]+$/.test(r.signature)) {
      const ours = encodeFillOrderAs(expect.orderBook, req.taker, order, r.signature, order.quantityRaw, true).data;
      if (ours.toLowerCase() !== r.fill.fillOrderAs.toLowerCase()) problems.push("backend fillOrderAs calldata differs from the local encoding");
    }
    const feeBps = Number(expect.protocolFeeBps ?? r.fee?.bps ?? 0);
    if (r.fee?.bps !== undefined && expect.protocolFeeBps !== undefined && Number(r.fee.bps) !== Number(expect.protocolFeeBps)) problems.push(`backend fee ${r.fee.bps} bps != book fee ${expect.protocolFeeBps} bps`);
    if (problems.length) throw new RfqError(`quote rejected: ${problems.join("; ")}`, undefined, "rejected", r);
    const dryRun = r.dryRun === true;
    if (!dryRun) {
      const sigOk = await verifyOrderSignature(order, r.signature);
      if (!sigOk) throw new RfqError("quote rejected: signature does not recover to order.signer (a contract signer needs an on-chain isValidOrderSignature check)", undefined, "signature", r);
    }
    const flow = takerCashflow(order, req.quantityRaw, feeBps, now);
    const premiumNow = currentPremiumRaw(order, now);
    const preview: FundingPreview = r.funding?.preview ?? { canFill: r.funding?.canFill ?? null, mode: "balance" };
    return {
      order,
      signature: r.signature,
      digest,
      instrument: r.instrument ?? nameOf(order.instrumentId, req.underlying ?? "NVDA"),
      fillable: !dryRun,
      dryRun,
      canFill: r.funding?.canFill ?? preview.canFill ?? null,
      shortfallRaw: preview.shortfallRaw ? BigInt(preview.shortfallRaw) : 0n,
      funding: preview,
      feeBps,
      premiumNowRaw: flow.premium,
      feeNowRaw: flow.fee,
      netNowRaw: flow.net,
      secondsLeft: Number(order.validUntil) - now,
      pricePerShareRaw: (premiumNow * 10n ** 18n) / order.quantityRaw,
      premiumAtExpiryRaw: order.premiumEndRaw,
      markPrice: Number(r.markPrice ?? 0),
      raw: r,
    };
  }

  // ---------------------------------------------------------------- indexer

  async positions(account: Address, includeSettled = false): Promise<PositionsView> {
    return this.request<PositionsView>("indexer", "GET", RfqPaths.positions, undefined, { account, settled: includeSettled ? 1 : 0 });
  }

  async fills(filter: { account?: Address; market?: Address; limit?: number } = {}): Promise<FillRow[]> {
    const r = await this.request<{ fills: FillRow[] }>("indexer", "GET", RfqPaths.fills, undefined, { account: filter.account, market: filter.market, limit: filter.limit });
    return r.fills ?? [];
  }

  async leaderboard(opts: { by?: "account" | "agent"; order?: LeaderboardOrder; limit?: number } = {}): Promise<{ by: string; order: string; rows: Array<LeaderboardRow | AgentLeaderboardRow>; note?: string }> {
    return this.request("indexer", "GET", RfqPaths.leaderboard, undefined, { by: opts.by ?? "account", order: opts.order ?? "settledPnlRaw", limit: opts.limit ?? 25 });
  }

  /** The ERC-8004 record and the accounts trading under an agent id. */
  async agent(agentId: string | number | bigint): Promise<AgentView> {
    return this.request<AgentView>("indexer", "GET", RfqPaths.agent(agentId.toString()));
  }

  async quoteStatus(digest: Hex): Promise<Record<string, unknown>> {
    return this.request("indexer", "GET", RfqPaths.quote(digest));
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";

function nameOf(instrumentId: bigint, underlying: string): string {
  const d = decodeInstrumentId(instrumentId);
  return instrumentName(underlying, d.expiry, d.strike, d.isPut);
}

/** 18-decimal raw -> the decimal share string the backend parses ("0.5"). */
export function sharesDecimal(quantityRaw: bigint): string {
  const whole = quantityRaw / 10n ** 18n;
  const frac = (quantityRaw % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function bigintReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}
