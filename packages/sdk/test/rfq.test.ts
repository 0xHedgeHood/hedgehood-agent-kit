import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { RfqClient, RfqError, Side, encodeInstrumentId, orderToJson, signOrder, type Order, type QuoteResponse } from "../src/index.js";

const BOOK: Address = "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5";
const MARKET: Address = "0xC289617d613C9865a6595B365DaD88277282e0Ac";
const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const makerSession = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const AGENT: Address = "0x3333333333333333333333333333333333333333";
const NOW = 1761600000;
const EXPIRY = 1793390400n;
const INSTRUMENT = encodeInstrumentId(EXPIRY, 220_000_000n, false);

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
    minFillRaw: 0n,
    premiumStartRaw: 5_000_000n,
    premiumEndRaw: 4_500_000n,
    startTime: BigInt(NOW),
    validUntil: BigInt(NOW + 30),
    stockMultiplier: 10n ** 18n,
    nonce: 1n,
    fromBalance: true,
    ...over,
  };
}

function clientWith(response: QuoteResponse | ((body: unknown) => QuoteResponse), status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const r = typeof response === "function" ? response(body) : response;
    return new Response(JSON.stringify(r), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new RfqClient({ chainId: 46630, apiUrl: "https://api.test/", fetch: fetchImpl, now: () => NOW + 7 });
  return { client, calls };
}

const req = { chainId: 46630, market: MARKET, instrumentId: INSTRUMENT, side: "buy" as const, quantityRaw: 10n ** 18n, taker: AGENT };
const expect712 = { orderBook: BOOK, protocolFeeBps: 50 };

describe("RfqClient.getQuote", () => {
  it("posts the request, verifies the maker signature and computes the decayed cashflow", async () => {
    const order = makeOrder();
    const signature = await signOrder(maker, order);
    const { client, calls } = clientWith({ order: orderToJson(order), signature, canFill: true, quoteId: "q1" });
    const q = await client.getQuote(req, expect712);
    expect(calls[0]!.url).toBe("https://api.test/v1/rfq");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ chainId: 46630, instrumentId: INSTRUMENT.toString(), side: "buy", taker: AGENT });
    expect(q.order).toEqual(order);
    expect(q.canFill).toBe(true);
    expect(q.secondsLeft).toBe(23);
    // 7 s into a 30 s fall of 500000: ask rounds down the move (116666.67 -> 116666)
    expect(q.premiumNowRaw).toBe(5_000_000n - 116_666n);
    expect(q.feeNowRaw).toBe(24_417n); // 0.5% of 4883334 = 24416.67 -> ceil
    expect(q.netNowRaw).toBe(q.premiumNowRaw + q.feeNowRaw);
    expect(q.pricePerShareRaw).toBe(q.premiumNowRaw);
  });

  it("reports shortfall when the maker says !canFill", async () => {
    const order = makeOrder();
    const signature = await signOrder(maker, order);
    const { client } = clientWith({ order: orderToJson(order), signature, canFill: false, shortfallRaw: "1230000" });
    const q = await client.getQuote(req, expect712);
    expect(q.canFill).toBe(false);
    expect(q.shortfallRaw).toBe(1_230_000n);
  });

  it("rejects a quote addressed to another taker", async () => {
    const order = makeOrder({ taker: "0x4444444444444444444444444444444444444444" });
    const { client } = clientWith({ order: orderToJson(order), signature: await signOrder(maker, order), canFill: true });
    await expect(client.getQuote(req, expect712)).rejects.toThrow(/taker/);
  });

  it("rejects an open order (taker = 0) as not an RFQ quote", async () => {
    const order = makeOrder({ taker: "0x0000000000000000000000000000000000000000" });
    const { client } = clientWith({ order: orderToJson(order), signature: await signOrder(maker, order), canFill: true });
    await expect(client.getQuote(req, expect712)).rejects.toThrow(/not addressed/);
  });

  it("rejects an expired quote, the wrong book, the wrong chain, the wrong side and a short size", async () => {
    for (const [over, re] of [
      [{ validUntil: BigInt(NOW + 7) }, /expired/],
      [{ settlement: MARKET }, /order book/],
      [{ chainId: 4663n }, /chainId/],
      [{ side: Side.Bid }, /side/],
      [{ quantityRaw: 10n ** 17n }, /smaller/],
      [{ instrumentId: INSTRUMENT | 1n }, /another instrument/],
    ] as Array<[Partial<Order>, RegExp]>) {
      const order = makeOrder(over);
      const { client } = clientWith({ order: orderToJson(order), signature: await signOrder(maker, order), canFill: true });
      await expect(client.getQuote(req, expect712)).rejects.toThrow(re);
    }
  });

  it("rejects a signature that does not recover to order.signer", async () => {
    const order = makeOrder();
    const bad = await signOrder({ ...makerSession, address: makerSession.address } as typeof maker, { ...order, signer: makerSession.address });
    const { client } = clientWith({ order: orderToJson(order), signature: bad, canFill: true });
    await expect(client.getQuote(req, expect712)).rejects.toThrow(/signature/);
  });

  it("accepts a quote signed by the maker's session key when order.signer is that key", async () => {
    const order = makeOrder({ signer: makerSession.address });
    const { client } = clientWith({ order: orderToJson(order), signature: await signOrder(makerSession, order), canFill: true });
    const q = await client.getQuote(req, expect712);
    expect(q.order.signer).toBe(makerSession.address);
  });

  it("surfaces HTTP errors with the backend's detail", async () => {
    const { client } = clientWith({ detail: "no liquidity" } as unknown as QuoteResponse, 422);
    await expect(client.getQuote(req, expect712)).rejects.toThrow(RfqError);
    await expect(client.getQuote(req, expect712)).rejects.toThrow(/422: no liquidity/);
  });

  it("reads markets, instruments, mark, leaderboard and agent records", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = (async (url: string | URL) => {
      seen.push(String(url));
      const u = new URL(String(url));
      const body = u.pathname.endsWith("/markets")
        ? { markets: [{ underlying: "NVDA" }] }
        : u.pathname.endsWith("/instruments")
          ? { instruments: [{ instrumentId: "1" }] }
          : u.pathname.endsWith("/leaderboard")
            ? { entries: [{ rank: 1 }] }
            : u.pathname.includes("/agents/")
              ? { account: AGENT, fills: 3 }
              : { instrumentId: "1", markRaw: "5000000", observedAt: NOW };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const client = new RfqClient({ chainId: 46630, apiUrl: "https://api.test", fetch: fetchImpl });
    expect(await client.markets()).toEqual([{ underlying: "NVDA" }]);
    expect(await client.instruments(MARKET, EXPIRY)).toEqual([{ instrumentId: "1" }]);
    expect((await client.mark(MARKET, INSTRUMENT)).markRaw).toBe("5000000");
    expect(await client.leaderboard("7d", 5)).toEqual([{ rank: 1 }]);
    expect((await client.agent(AGENT)).fills).toBe(3);
    expect(seen[1]).toContain(`expiry=${EXPIRY}`);
    expect(seen[3]).toContain("period=7d");
  });
});
