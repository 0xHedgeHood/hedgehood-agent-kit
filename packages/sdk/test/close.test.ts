import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, type Address, type Hex } from "viem";
import {
  RfqClient,
  Side,
  closePosition,
  encodeFillOrderAs,
  encodeInstrumentId,
  orderBookV2Abi,
  orderDigest,
  orderToJson,
  planClose,
  signOrder,
  type MarketClient,
  type Order,
  type Position,
  type QuoteResponse,
  type SendResult,
  type TxRequest,
} from "../src/index.js";

const BOOK: Address = "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5";
const MARKET: Address = "0xC289617d613C9865a6595B365DaD88277282e0Ac";
const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const AGENT: Address = "0x3333333333333333333333333333333333333333";
const NOW = 1761600000;
const EXPIRY = 1793390400n;
const CALL = encodeInstrumentId(EXPIRY, 220_000_000n, false);
const PUT = encodeInstrumentId(EXPIRY, 210_000_000n, true);
const ONE = 10n ** 18n;

function order(over: Partial<Order>): Order {
  return {
    maker: maker.address, signer: maker.address, taker: AGENT, chainId: 46630n, settlement: BOOK, market: MARKET, instrumentId: CALL,
    side: Side.Bid, quantityRaw: ONE, minFillRaw: 0n, premiumStartRaw: 1_570_000n, premiumEndRaw: 1_560_000n, startTime: BigInt(NOW),
    validUntil: BigInt(NOW + 15), stockMultiplier: ONE, nonce: 7n, fromBalance: true, ...over,
  };
}

async function quoteFor(o: Order, dryRun = false): Promise<QuoteResponse> {
  const signature = dryRun ? (("0x" + "ab".repeat(65)) as Hex) : await signOrder(maker, o);
  return {
    quote: orderToJson(o), signature, digest: orderDigest(o), validUntil: o.validUntil.toString(), startTime: o.startTime.toString(), ttl: 15,
    instrument: o.instrumentId === CALL ? "NVDA-20261030-220-C" : "NVDA-20261030-210-P", instrumentId: o.instrumentId.toString(), market: MARKET, book: BOOK, marketId: "nvda-testnet", version: 2,
    taker: AGENT, takerSide: o.side === Side.Ask ? "buy" : "sell", makerSide: o.side, quantityRaw: o.quantityRaw.toString(), markPrice: 1.62,
    price: { start: 1.57, end: 1.56, unit: "USDG per share" }, premiumStartRaw: o.premiumStartRaw.toString(), premiumEndRaw: o.premiumEndRaw.toString(),
    fee: { bps: 50, startRaw: "0", endRaw: "0" }, decay: { model: "linear", bpsPerMin: 20, encodedInOrder: true },
    signing: { maker: o.maker, signer: o.signer, kind: "owner", domain: { name: "CashOptionOrderBook", version: "2", chainId: 46630, verifyingContract: BOOK } },
    funding: { makerFromBalance: true, takerDefault: "balance", canFill: true, preview: { canFill: true, mode: "balance" } },
    fill: { to: BOOK, chainId: 46630, quantityRaw: o.quantityRaw.toString(), default: "fillOrderAs", fillOrderAs: encodeFillOrderAs(BOOK, AGENT, o, signature, o.quantityRaw, true).data, fillOrderAsWallet: null, fillOrder: "0x" },
    dryRun,
  };
}

/** A MarketClient double: on-chain reads answered from fixtures, sends recorded. */
function fakeMarket(positions: Position[]) {
  const sends: Array<{ request: TxRequest; dryRun?: boolean }> = [];
  const m = {
    chainId: 46630,
    market: MARKET,
    orderBook: BOOK,
    account: AGENT,
    deployment: { underlying: "NVDA", market: MARKET, orderBook: BOOK },
    snapshot: async () => ({ account: AGENT, collateralRaw: 0n, requirementRaw: 0n, freeCollateralRaw: 0n, walletUsdgRaw: 0n, expiries: [EXPIRY], positions }),
    protocolFeeBps: async () => 50n,
    fillOrderAs: (o: Order, sig: Hex, qty: bigint, fromBalance = true, account: Address = AGENT) => encodeFillOrderAs(BOOK, account, o, sig, qty, fromBalance),
    send: async (request: TxRequest, opts: { dryRun?: boolean } = {}): Promise<SendResult> => {
      sends.push({ request, dryRun: opts.dryRun });
      return { dryRun: opts.dryRun ?? true, request, from: "0x4444444444444444444444444444444444444444" };
    },
  };
  return { market: m as unknown as MarketClient, sends };
}

/** An RfqClient whose /v1/rfq answers with a maker quote on the side it was asked for. */
function fakeRfq(opts: { dryRun?: boolean } = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { instrument: string; side: "buy" | "sell"; quantity: string };
    bodies.push(body);
    const id = body.instrument.endsWith("-C") ? CALL : PUT;
    const qty = BigInt(Math.round(Number(body.quantity) * 1e6)) * 10n ** 12n;
    const o = order({ instrumentId: id, side: body.side === "buy" ? Side.Ask : Side.Bid, quantityRaw: qty });
    return new Response(JSON.stringify(await quoteFor(o, opts.dryRun)), { status: 200 });
  }) as typeof fetch;
  return { rfq: new RfqClient({ chainId: 46630, hosts: { rfq: "https://rfq.test" }, fetch: fetchImpl, now: () => NOW + 5 }), bodies };
}

const long: Position = { instrumentId: CALL, expiry: EXPIRY, strike: 220_000_000n, isPut: false, quantityRaw: ONE };
const short: Position = { instrumentId: PUT, expiry: EXPIRY, strike: 210_000_000n, isPut: true, quantityRaw: -(ONE / 2n) };

describe("planClose", () => {
  it("closes a long by selling the whole position to the maker's bid and builds the fillOrderAs calldata", async () => {
    const { market } = fakeMarket([long, short]);
    const { rfq, bodies } = fakeRfq();
    const plan = await planClose({ market, rfq, instrumentId: CALL, sessionKey: "0x4444444444444444444444444444444444444444" });
    expect(plan.side).toBe("sell");
    expect(plan.quantityRaw).toBe(ONE);
    expect(plan.remainingRaw).toBe(0n);
    expect(plan.instrument).toBe("NVDA-20261030-220-C");
    expect(bodies[0]).toEqual({ instrument: "NVDA-20261030-220-C", side: "sell", quantity: "1", taker: AGENT, sessionKey: "0x4444444444444444444444444444444444444444" });
    expect(plan.quote.order.side).toBe(Side.Bid);
    expect(plan.request.to).toBe(BOOK);
    expect(plan.request.data.startsWith("0x18943a04")).toBe(true);
    expect(plan.request.data).toBe(encodeFillOrderAs(BOOK, AGENT, plan.quote.order, plan.quote.signature, ONE, true).data);
    expect(plan.quote.netNowRaw).toBeLessThan(0n); // the taker receives premium net of fee
  });

  it("closes a short by buying back, caps the quantity at |position| and reports the remainder of a partial close", async () => {
    const { market } = fakeMarket([long, short]);
    const { rfq, bodies } = fakeRfq();
    const all = await planClose({ market, rfq, instrumentId: PUT, quantityRaw: 5n * ONE });
    expect(all.side).toBe("buy");
    expect(all.quantityRaw).toBe(ONE / 2n);
    expect(all.remainingRaw).toBe(0n);
    expect(bodies[0]).toMatchObject({ instrument: "NVDA-20261030-210-P", side: "buy", quantity: "0.5" });
    const part = await planClose({ market, rfq, instrumentId: CALL, quantityRaw: ONE / 4n });
    expect(part.quantityRaw).toBe(ONE / 4n);
    expect(part.remainingRaw).toBe((3n * ONE) / 4n);
    expect(bodies[1]).toMatchObject({ side: "sell", quantity: "0.25" });
  });

  it("refuses when there is no position, or a non-positive quantity", async () => {
    const { market } = fakeMarket([short]);
    const { rfq, bodies } = fakeRfq();
    await expect(planClose({ market, rfq, instrumentId: CALL })).rejects.toThrow(/no open position in NVDA-20261030-220-C/);
    await expect(planClose({ market, rfq, instrumentId: PUT, quantityRaw: 0n })).rejects.toThrow(/positive/);
    expect(bodies.length).toBe(0);
  });
});

describe("closePosition", () => {
  it("is a dry run unless dryRun: false and sends through the market client's signer", async () => {
    const { market, sends } = fakeMarket([long]);
    const { rfq } = fakeRfq();
    const r = await closePosition({ market, rfq, instrumentId: CALL });
    expect(r.result.dryRun).toBe(true);
    expect(sends).toEqual([{ request: r.request, dryRun: true }]);
    const sent = await closePosition({ market, rfq, instrumentId: CALL, dryRun: false, fromBalance: false });
    expect(sent.result.dryRun).toBe(false);
    expect(sends[1]!.dryRun).toBe(false);
    // fromBalance is carried into the calldata
    const fromBalanceOf = (data: Hex) => (decodeFunctionData({ abi: orderBookV2Abi, data }).args as unknown as unknown[])[4];
    expect(fromBalanceOf(r.request.data)).toBe(true);
    expect(fromBalanceOf(sent.request.data)).toBe(false);
  });

  it("refuses a backend dry-run quote without sending", async () => {
    const { market, sends } = fakeMarket([long]);
    const { rfq } = fakeRfq({ dryRun: true });
    await expect(closePosition({ market, rfq, instrumentId: CALL })).rejects.toThrow(/dry-run quote/);
    expect(sends.length).toBe(0);
    const plan = await planClose({ market, rfq, instrumentId: CALL });
    expect(plan.quote.fillable).toBe(false);
  });
});
