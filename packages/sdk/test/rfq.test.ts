import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  RfqClient,
  RfqError,
  Side,
  encodeFillOrderAs,
  encodeInstrumentId,
  expiryDateNY,
  instrumentName,
  orderDigest,
  orderToJson,
  parseInstrumentName,
  resolveInstrumentName,
  sharesDecimal,
  signOrder,
  type Order,
  type QuoteResponse,
} from "../src/index.js";

const BOOK: Address = "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5";
const MARKET: Address = "0xC289617d613C9865a6595B365DaD88277282e0Ac";
const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const makerSession = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const AGENT: Address = "0x3333333333333333333333333333333333333333";
const NOW = 1761600000;
const EXPIRY = 1793390400n; // 2026-10-30 16:00 New York
const INSTRUMENT = encodeInstrumentId(EXPIRY, 220_000_000n, false);
const NAME = "NVDA-20261030-220-C";

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    maker: maker.address,
    signer: maker.address,
    taker: AGENT,
    chainId: 46630n,
    settlement: BOOK,
    market: MARKET,
    instrumentId: INSTRUMENT,
    side: Side.Ask,
    quantityRaw: 10n ** 18n,
    minFillRaw: 10n ** 18n,
    premiumStartRaw: 5_000_000n,
    premiumEndRaw: 5_020_000n, // the desk worsens the price for the taker over the window (ask rises)
    startTime: BigInt(NOW),
    validUntil: BigInt(NOW + 15),
    stockMultiplier: 10n ** 18n,
    nonce: 1n,
    fromBalance: true,
    ...over,
  };
}

/** The backend's `POST /v1/rfq` body for an order, as rfq/service.py builds it. */
async function backendQuote(order: Order, over: Partial<QuoteResponse> = {}, sig?: Hex): Promise<QuoteResponse> {
  const signature = sig ?? (await signOrder(order.signer === maker.address ? maker : makerSession, order));
  return {
    quote: orderToJson(order),
    signature,
    digest: orderDigest(order),
    validUntil: order.validUntil.toString(),
    startTime: order.startTime.toString(),
    ttl: Number(order.validUntil - order.startTime),
    instrument: NAME,
    instrumentId: order.instrumentId.toString(),
    market: MARKET,
    book: BOOK,
    marketId: "nvda-testnet",
    version: 2,
    taker: order.taker,
    takerSide: order.side === Side.Ask ? "buy" : "sell",
    makerSide: order.side,
    quantityRaw: order.quantityRaw.toString(),
    markPrice: 4.98,
    price: { start: 5.0, end: 5.02, unit: "USDG per share" },
    premiumStartRaw: order.premiumStartRaw.toString(),
    premiumEndRaw: order.premiumEndRaw.toString(),
    fee: { bps: 50, startRaw: "25000", endRaw: "25100" },
    decay: { model: "linear", bpsPerMin: 20, encodedInOrder: true },
    signing: { maker: order.maker, signer: order.signer, kind: order.signer === order.maker ? "owner" : "session", domain: { name: "CashOptionOrderBook", version: "2", chainId: 46630, verifyingContract: BOOK } },
    funding: { makerFromBalance: true, takerDefault: "balance", canFill: true, preview: { canFill: true, shortfallRaw: "0", collateralRaw: "100000000", requirementRaw: "0", requirementAfterRaw: "0", cashDeltaRaw: "-5045100", mode: "balance", sessionLimitRaw: null, reason: null } },
    fill: { to: BOOK, chainId: 46630, quantityRaw: order.quantityRaw.toString(), default: "fillOrderAs", fillOrderAs: encodeFillOrderAs(BOOK, order.taker, order, signature, order.quantityRaw, true).data, fillOrderAsWallet: encodeFillOrderAs(BOOK, order.taker, order, signature, order.quantityRaw, false).data, fillOrder: "0x" },
    dryRun: false,
    ...over,
  };
}

function clientWith(response: unknown | ((url: URL, body: unknown) => unknown), status = 200) {
  const calls: Array<{ url: URL; init: RequestInit; body: unknown }> = [];
  const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, init: init ?? {}, body });
    const r = typeof response === "function" ? (response as (u: URL, b: unknown) => unknown)(u, body) : response;
    return new Response(JSON.stringify(r), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new RfqClient({ chainId: 46630, hosts: { rfq: "https://rfq.test", indexer: "https://index.test", gateway: "https://pay.test" }, fetch: fetchImpl, now: () => NOW + 7 });
  return { client, calls };
}

const req = { chainId: 46630, market: MARKET, instrumentId: INSTRUMENT, side: "buy" as const, quantityRaw: 10n ** 18n, taker: AGENT };
const expect712 = { orderBook: BOOK, protocolFeeBps: 50 };

describe("instrument names (backend convention)", () => {
  it("formats and parses NVDA-YYYYMMDD-STRIKE-C|P with the New York date", () => {
    expect(expiryDateNY(EXPIRY)).toBe("20261030");
    expect(instrumentName("nvda", EXPIRY, 220_000_000n, false)).toBe(NAME);
    expect(instrumentName("NVDA", EXPIRY, 222_500_000n, true)).toBe("NVDA-20261030-222.5-P");
    expect(parseInstrumentName("NVDA-20261030-222.5-P")).toEqual({ underlying: "NVDA", date: "20261030", strikeRaw: 222_500_000n, isPut: true });
    expect(resolveInstrumentName(NAME, [1792785600n, EXPIRY])).toBe(INSTRUMENT);
    expect(() => resolveInstrumentName(NAME, [1792785600n])).toThrow(/no opened expiry/);
    expect(() => parseInstrumentName("NVDA 220 C")).toThrow(/look like/);
  });

  it("sharesDecimal renders 18-decimal raw as the backend's decimal shares", () => {
    expect(sharesDecimal(10n ** 18n)).toBe("1");
    expect(sharesDecimal(5n * 10n ** 17n)).toBe("0.5");
    expect(sharesDecimal(1_250_000_000_000_000_000n)).toBe("1.25");
  });
});

describe("RfqClient.getQuote", () => {
  it("posts the backend's request shape, verifies digest, calldata and signature, and prices the decayed fill", async () => {
    const order = makeOrder();
    const { client, calls } = clientWith(await backendQuote(order));
    const q = await client.getQuote(req, expect712);
    expect(calls[0]!.url.toString()).toBe("https://rfq.test/v1/rfq");
    expect(calls[0]!.body).toEqual({ instrument: NAME, side: "buy", quantity: "1", taker: AGENT });
    expect(q.order).toEqual(order);
    expect(q.fillable).toBe(true);
    expect(q.dryRun).toBe(false);
    expect(q.canFill).toBe(true);
    expect(q.digest).toBe(orderDigest(order));
    expect(q.secondsLeft).toBe(8);
    // 7 s into a 15 s rise of 20000: an ask rounds the rise up (9333.33 -> 9334)
    expect(q.premiumNowRaw).toBe(5_000_000n + 9_334n);
    expect(q.feeNowRaw).toBe(25_047n); // 0.5% of 5009334 = 25046.67 -> ceil
    expect(q.netNowRaw).toBe(q.premiumNowRaw + q.feeNowRaw);
    expect(q.markPrice).toBe(4.98);
    expect(q.instrument).toBe(NAME);
  });

  it("passes sessionKey through and reports the backend's funding preview", async () => {
    const order = makeOrder();
    const { client, calls } = clientWith(await backendQuote(order, { funding: { makerFromBalance: true, takerDefault: "balance", canFill: false, preview: { canFill: false, shortfallRaw: "1230000", mode: "balance", reason: "InsufficientCollateral" } } }));
    const q = await client.getQuote({ ...req, sessionKey: makerSession.address }, expect712);
    expect(calls[0]!.body).toMatchObject({ sessionKey: makerSession.address });
    expect(q.canFill).toBe(false);
    expect(q.shortfallRaw).toBe(1_230_000n);
    expect(q.funding.reason).toBe("InsufficientCollateral");
  });

  it("accepts a backend dry-run quote (placeholder signature) but marks it unfillable", async () => {
    const order = makeOrder();
    const placeholder = ("0x" + "ab".repeat(65)) as Hex;
    const { client } = clientWith(await backendQuote(order, { dryRun: true }, placeholder));
    const q = await client.getQuote(req, expect712);
    expect(q.dryRun).toBe(true);
    expect(q.fillable).toBe(false);
  });

  it("rejects a quote addressed to another taker, an open order, a backend digest mismatch and calldata mismatch", async () => {
    const other = makeOrder({ taker: "0x4444444444444444444444444444444444444444" });
    await expect(clientWith(await backendQuote(other)).client.getQuote(req, expect712)).rejects.toThrow(/taker/);
    const open = makeOrder({ taker: "0x0000000000000000000000000000000000000000" });
    await expect(clientWith(await backendQuote(open)).client.getQuote(req, expect712)).rejects.toThrow(/not addressed/);
    const order = makeOrder();
    await expect(clientWith(await backendQuote(order, { digest: ("0x" + "00".repeat(32)) as Hex })).client.getQuote(req, expect712)).rejects.toThrow(/digest differs/);
    const good = await backendQuote(order);
    await expect(clientWith({ ...good, fill: { ...good.fill, fillOrderAs: "0x1234" } }).client.getQuote(req, expect712)).rejects.toThrow(/calldata differs/);
  });

  it("rejects an expired quote, the wrong book, chain, side, a short size, another instrument, a V1 quote and a fee mismatch", async () => {
    for (const [over, re] of [
      [{ validUntil: BigInt(NOW + 7) }, /expired/],
      [{ settlement: MARKET }, /order book/],
      [{ chainId: 4663n }, /chainId/],
      [{ side: Side.Bid }, /side/],
      [{ quantityRaw: 10n ** 17n }, /smaller/],
      [{ instrumentId: INSTRUMENT | 1n }, /another instrument/],
    ] as Array<[Partial<Order>, RegExp]>) {
      const order = makeOrder(over);
      await expect(clientWith(await backendQuote(order)).client.getQuote(req, expect712)).rejects.toThrow(re);
    }
    const order = makeOrder();
    await expect(clientWith(await backendQuote(order, { version: 1 })).client.getQuote(req, expect712)).rejects.toThrow(/V1/);
    await expect(clientWith(await backendQuote(order, { fee: { bps: 30, startRaw: "0", endRaw: "0" } })).client.getQuote(req, expect712)).rejects.toThrow(/fee 30 bps/);
  });

  it("rejects a signature that does not recover to order.signer; accepts the desk's session-key signer", async () => {
    const order = makeOrder();
    const bad = await signOrder(makerSession, { ...order, signer: makerSession.address });
    const wrong = await backendQuote(order, {}, bad);
    wrong.fill.fillOrderAs = encodeFillOrderAs(BOOK, AGENT, order, bad, order.quantityRaw, true).data;
    await expect(clientWith(wrong).client.getQuote(req, expect712)).rejects.toThrow(/signature/);
    const sessionSigned = makeOrder({ signer: makerSession.address });
    const q = await clientWith(await backendQuote(sessionSigned)).client.getQuote(req, expect712);
    expect(q.order.signer).toBe(makerSession.address);
  });

  it("surfaces the backend's refusal codes", async () => {
    const { client } = clientWith({ error: "not_executable", reason: "not_executable:stale" }, 503);
    const err = await client.getQuote(req, expect712).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RfqError);
    expect((err as RfqError).code).toBe("not_executable");
    expect((err as RfqError).status).toBe(503);
    expect((err as RfqError).message).toMatch(/503 not_executable: not_executable:stale/);
  });

  it("getSignerSideOrder uses the JSON-RPC face", async () => {
    const order = makeOrder();
    const quote = await backendQuote(order);
    const { client, calls } = clientWith((u: URL, body: unknown) => (u.pathname === "/v1/rpc" ? { jsonrpc: "2.0", id: (body as { id: number }).id, result: quote } : {}));
    const r = await client.getSignerSideOrder(req);
    expect(calls[0]!.body).toMatchObject({ jsonrpc: "2.0", method: "getSignerSideOrder", params: { instrument: NAME, side: "buy", amount: "1", takerWallet: AGENT } });
    expect(r.digest).toBe(orderDigest(order));
    const { client: refusing } = clientWith({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "quote refused", data: { reason: "halted:operator", code: "halted" } } });
    const err = await refusing.getSignerSideOrder(req).catch((e: unknown) => e);
    expect((err as RfqError).code).toBe("halted");
  });

  it("reads markets, instruments, mark (rfq host) and positions, fills, leaderboard, agents (indexer host)", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = (async (url: string | URL) => {
      const u = new URL(String(url));
      seen.push(u.toString());
      const body = u.pathname.endsWith("/markets")
        ? { markets: [{ underlying: "NVDA", version: 2, expiries: [{ expiry: EXPIRY.toString(), expiryDate: "20261030", strikes: 9, settled: false }] }] }
        : u.pathname.endsWith("/instruments")
          ? { instruments: [{ instrument: NAME, instrumentId: INSTRUMENT.toString() }] }
          : u.pathname.endsWith("/mark")
            ? { instrument: NAME, executable: true, bid: 4.9, ask: 5.1, mid: 5.0, unit: "USDG per share", at: NOW }
            : u.pathname.endsWith("/positions")
              ? { account: AGENT, positions: [{ instrument: NAME, quantityRaw: "1000000000000000000", costRaw: "5045100" }], leaderboard: { account: AGENT, fills: 1 }, agentId: null }
              : u.pathname.endsWith("/fills")
                ? { fills: [{ txHash: "0x01" }] }
                : u.pathname.endsWith("/leaderboard")
                  ? { by: "account", order: "settledPnlRaw", rows: [{ account: AGENT, fills: 1 }] }
                  : { agentId: "7", record: { agentId: "7", owner: AGENT }, accounts: [], registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const client = new RfqClient({ chainId: 46630, hosts: { rfq: "https://rfq.test/", indexer: "https://index.test" }, fetch: fetchImpl });
    expect((await client.markets())[0]!.underlying).toBe("NVDA");
    expect((await client.instruments("NVDA", EXPIRY))[0]!.instrument).toBe(NAME);
    expect((await client.mark({ instrumentId: INSTRUMENT, underlying: "NVDA" })).mid).toBe(5.0);
    expect((await client.positions(AGENT)).positions[0]!.instrument).toBe(NAME);
    expect((await client.fills({ account: AGENT, limit: 5 }))[0]!.txHash).toBe("0x01");
    expect((await client.leaderboard({ by: "account", order: "fills", limit: 5 })).rows[0]).toMatchObject({ fills: 1 });
    expect((await client.agent(7)).agentId).toBe("7");
    expect(seen[0]).toBe("https://rfq.test/v1/markets");
    expect(seen[1]).toBe(`https://rfq.test/v1/instruments?underlying=NVDA&expiry=${EXPIRY}`);
    expect(seen[2]).toBe(`https://rfq.test/v1/mark?instrument=${NAME}`);
    expect(seen[3]).toBe(`https://index.test/v1/positions?account=${AGENT}&settled=0`);
    expect(seen[5]).toBe("https://index.test/v1/leaderboard?by=account&order=fills&limit=5");
    expect(seen[6]).toBe("https://index.test/v1/agents/7");
  });
});
