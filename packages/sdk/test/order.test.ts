import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, type Address } from "viem";
import {
  ORDER_TYPEHASH,
  ORDER_TYPE_STRING,
  Side,
  currentPremiumRaw,
  encodeInstrumentId,
  orderBookDomain,
  orderDigest,
  orderFromJson,
  orderProblems,
  orderToJson,
  premiumFor,
  recoverOrderSigner,
  signOrder,
  takerFeeFor,
  verifyOrderSignature,
  type Order,
} from "../src/index.js";

/**
 * Fixture values computed independently with Foundry's `cast` against the Solidity source of
 * CashOptionOrderBookV2 (hedgehood-options feat/market-v2-derive-style @ 131c1ae):
 *   cast keccak "<ORDER_TYPE_STRING>"                                           -> EXPECTED_TYPEHASH
 *   structHash = keccak(abi.encode(typehash, fields...)), domain = EIP712("CashOptionOrderBook","2", 46630, book),
 *   digest = keccak(0x1901 ‖ domainSeparator ‖ structHash)                       -> EXPECTED_DIGEST
 */
const EXPECTED_TYPEHASH = "0x96518061cf95ec8752ed1e709c6f68748344faf1e6ab0e6d84845028691bbdb8";
const EXPECTED_DOMAIN_SEPARATOR = "0x4a84c642658aac7000526346bbc9e7a21dde1f0df80ea61c045fcdf2d390582b";
const EXPECTED_STRUCT_HASH = "0x0c4aa1a1e6c7d676121bf876fbc3dea5439e4bdb6fdc6d06329a2c706d12ce33";
const EXPECTED_DIGEST = "0x32acdb1d7011793ece8ef3b4d5eaafb33820b0b2ebee66475140de2e48b427a5";

const BOOK: Address = "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5";
const MARKET: Address = "0xC289617d613C9865a6595B365DaD88277282e0Ac";
const EXPIRY = 1793390400n; // 2026-10-30 16:00 New York (20:00 UTC)
const STRIKE = 220_000_000n; // $220

export const fixtureOrder: Order = {
  maker: "0x1111111111111111111111111111111111111111",
  signer: "0x2222222222222222222222222222222222222222",
  taker: "0x3333333333333333333333333333333333333333",
  chainId: 46630n,
  settlement: BOOK,
  market: MARKET,
  instrumentId: encodeInstrumentId(EXPIRY, STRIKE, false),
  side: Side.Ask,
  quantityRaw: 10n ** 18n,
  minFillRaw: 0n,
  premiumStartRaw: 5_000_000n,
  premiumEndRaw: 4_500_000n,
  startTime: 1761600000n,
  validUntil: 1761600060n,
  stockMultiplier: 10n ** 18n,
  nonce: 7n,
  fromBalance: true,
};

describe("EIP-712 order", () => {
  it("struct string hashes to the contract's ORDER_TYPEHASH", () => {
    expect(keccak256(toHex(ORDER_TYPE_STRING))).toBe(EXPECTED_TYPEHASH);
    expect(ORDER_TYPEHASH).toBe(EXPECTED_TYPEHASH);
  });

  it("instrument id of the fixture matches (expiry << 96) | (strike << 1)", () => {
    expect(fixtureOrder.instrumentId).toBe(142087026062721526102620822511099174400n);
  });

  it("domain separator and digest match cast", async () => {
    const { hashDomain, hashStruct } = await import("viem");
    const d = orderBookDomain(46630, BOOK);
    const domain = { name: d.name!, version: d.version!, chainId: BigInt(d.chainId!), verifyingContract: d.verifyingContract! };
    expect(hashDomain({ domain, types: { EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ] } })).toBe(EXPECTED_DOMAIN_SEPARATOR);
    const { ORDER_TYPES, orderToTuple } = await import("../src/order.js");
    expect(hashStruct({ data: orderToTuple(fixtureOrder), primaryType: "Order", types: ORDER_TYPES })).toBe(EXPECTED_STRUCT_HASH);
    expect(orderDigest(fixtureOrder)).toBe(EXPECTED_DIGEST);
  });

  it("signs with the signer key and recovers it; a foreign key is refused", async () => {
    const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const order = { ...fixtureOrder, signer: signer.address };
    const sig = await signOrder(signer, order);
    expect(await recoverOrderSigner(order, sig)).toBe(signer.address);
    expect(await verifyOrderSignature(order, sig)).toBe(true);
    expect(await verifyOrderSignature({ ...order, nonce: 8n }, sig)).toBe(false);
    const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    await expect(signOrder(other, order)).rejects.toThrow(/not order.signer/);
  });

  it("round-trips through the JSON wire form", () => {
    const j = orderToJson(fixtureOrder);
    expect(typeof j.instrumentId).toBe("string");
    expect(orderFromJson(j)).toEqual(fixtureOrder);
    expect(orderFromJson({ ...j, side: "Ask" })).toEqual(fixtureOrder);
    expect(() => orderFromJson({ ...j, maker: "0x12" })).toThrow(/maker/);
    expect(() => orderFromJson({ ...j, quantityRaw: "-1" })).toThrow(/quantityRaw/);
  });
});

describe("backend golden fixture (hedgehood-options tests/test_abi_v2.py `order()`, feat/rfq-backend @ 0cd8d23)", () => {
  // Their test recomputes _hashTypedDataV4 by hand (eth_abi) for this order; the same formula run with `cast` gives
  // the hashes below, so the kit, the backend and the contract agree on the digest.
  const backendOrder: Order = {
    maker: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A", // Account.from_key(0x11..11)
    signer: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
    taker: "0x0000000000000000000000000000000000000301",
    chainId: 4663n,
    settlement: "0x0000000000000000000000000000000000000202",
    market: "0x0000000000000000000000000000000000000201",
    instrumentId: encodeInstrumentId(1_792_180_800n, 210_000_000n, false),
    side: Side.Ask,
    quantityRaw: 5n * 10n ** 17n,
    minFillRaw: 5n * 10n ** 17n,
    premiumStartRaw: 2_500_000n,
    premiumEndRaw: 2_520_000n,
    startTime: 1_792_000_000n,
    validUntil: 1_792_000_015n,
    stockMultiplier: 10n ** 18n,
    nonce: 7n,
    fromBalance: true,
  };
  it("matches the digest the backend's abi_v2.order_digest produces", async () => {
    expect(backendOrder.instrumentId).toBe(141991191677344271959867671748752748800n);
    expect(orderDigest(backendOrder)).toBe("0xd7c8942636b7d0ffe6026f7dc027a471ba7131f8786ebf15b1d89515508f1f12");
    const signer = privateKeyToAccount("0x1111111111111111111111111111111111111111111111111111111111111111");
    expect(signer.address).toBe(backendOrder.maker);
    const sig = await signOrder(signer, backendOrder);
    expect(await recoverOrderSigner(backendOrder, sig)).toBe(signer.address);
    // decay as the backend computes it (abi_v2.current_premium_raw): 7 s into a 15 s rise of 20000 on an ask -> ceil
    expect(currentPremiumRaw(backendOrder, 1_792_000_007n)).toBe(2_500_000n + 9_334n);
  });
});

describe("premium decay (currentPremiumRaw)", () => {
  it("is the start premium before startTime, the end at/after validUntil, flat when equal", () => {
    expect(currentPremiumRaw(fixtureOrder, 1761599999n)).toBe(5_000_000n);
    expect(currentPremiumRaw(fixtureOrder, 1761600000n)).toBe(5_000_000n);
    expect(currentPremiumRaw(fixtureOrder, 1761600060n)).toBe(4_500_000n);
    expect(currentPremiumRaw(fixtureOrder, 1761600999n)).toBe(4_500_000n);
    const flat = { ...fixtureOrder, premiumEndRaw: 5_000_000n, startTime: 0n };
    expect(currentPremiumRaw(flat, 1761600030n)).toBe(5_000_000n);
  });

  it("rounds in the maker's favour: a falling ask rounds down, a falling bid rounds up", () => {
    // span 500000 over 60 s; at 7 s the exact move is 58333.33...
    const t = 1761600007n;
    expect(currentPremiumRaw(fixtureOrder, t)).toBe(5_000_000n - 58_333n); // ask: fall rounded down -> higher premium
    const bid = { ...fixtureOrder, side: Side.Bid };
    expect(currentPremiumRaw(bid, t)).toBe(5_000_000n - 58_334n); // bid: fall rounded up -> lower premium
    const risingAsk = { ...fixtureOrder, premiumStartRaw: 4_500_000n, premiumEndRaw: 5_000_000n };
    expect(currentPremiumRaw(risingAsk, t)).toBe(4_500_000n + 58_334n); // ask: rise rounded up
    const risingBid = { ...risingAsk, side: Side.Bid };
    expect(currentPremiumRaw(risingBid, t)).toBe(4_500_000n + 58_333n); // bid: rise rounded down
  });

  it("pro rata premium rounds up and the taker fee rounds up", () => {
    const half = 5n * 10n ** 17n;
    expect(premiumFor(fixtureOrder, half, 1761600007n)).toBe((5_000_000n - 58_333n + 1n) / 2n); // 4941667 / 2 = 2470833.5 -> 2470834
    expect(takerFeeFor(2_470_834n, 50)).toBe(12_355n); // 12354.17 -> ceil
    expect(() => premiumFor(fixtureOrder, 0n, 0)).toThrow();
    expect(() => premiumFor(fixtureOrder, 2n * 10n ** 18n, 0)).toThrow();
  });
});

describe("orderProblems", () => {
  it("passes the fixture and flags the book's static checks", () => {
    expect(orderProblems(fixtureOrder, { chainId: 46630, orderBook: BOOK, market: MARKET, taker: fixtureOrder.taker, now: 1761600001 })).toEqual([]);
    expect(orderProblems(fixtureOrder, { chainId: 4663 })).toContain("chainId 46630 != 4663");
    expect(orderProblems(fixtureOrder, { taker: "0x4444444444444444444444444444444444444444" })[0]).toMatch(/taker/);
    expect(orderProblems(fixtureOrder, { now: 1761600060 })).toContain("order expired (validUntil passed)");
    expect(orderProblems({ ...fixtureOrder, validUntil: EXPIRY + 1n })).toContain("validUntil after the instrument's expiry");
    expect(orderProblems({ ...fixtureOrder, startTime: fixtureOrder.validUntil })).toContain("decay window invalid (startTime >= validUntil)");
  });
});
