import { describe, expect, it } from "vitest";
import {
  closedShortOf,
  describeSessionCharge,
  encodeInstrumentId,
  formatSessionCap,
  maxPaidUntilExpiry,
  maxPayoutPerToken,
  openedShortOf,
  premiumFor,
  sessionChargeOf,
  sessionLimitDetail,
  shortRiskCharge,
  Side,
  spendCharge,
  takerFeeFor,
  UNLIMITED,
  type Order,
} from "../src/index.js";

// The fixture expiry of the MCP/CLI fakes: caps 150.5 / 279.5 USDG per token.
const CAPS = { capLow: 150_500_000n, capHigh: 279_500_000n };
const ONE = 10n ** 18n;
const THIRD = 333_333_333_333_333_333n;

describe("max payout per token", () => {
  it("is capHigh - K for a call and K - capLow for a put", () => {
    expect(maxPayoutPerToken(220_000_000n, false, CAPS)).toBe(59_500_000n);
    expect(maxPayoutPerToken(200_000_000n, true, CAPS)).toBe(49_500_000n);
  });
  it("refuses a strike outside the caps", () => {
    expect(() => maxPayoutPerToken(279_500_000n, false, CAPS)).toThrow(/inside the caps/);
    expect(() => maxPayoutPerToken(150_000_000n, true, CAPS)).toThrow(/inside the caps/);
  });
});

describe("short-risk charge (sell legs)", () => {
  const call = 59_500_000n; // 220 call
  const put = 49_500_000n; // 200 put
  it("sell to open from flat: ceil(qty x maxPayout / 1e18)", () => {
    expect(shortRiskCharge(ONE, 0n, call)).toBe(59_500_000n);
    expect(shortRiskCharge(2n * ONE, 0n, put)).toBe(99_000_000n);
    expect(shortRiskCharge(THIRD, 0n, call)).toBe(19_833_334n); // 19_833_333.33... rounds up
    expect(shortRiskCharge(1n, 0n, call)).toBe(1n); // one wei of a share still costs 1 raw
  });
  it("selling an existing long is free; only the part beyond the long is charged", () => {
    expect(shortRiskCharge(ONE, ONE, call)).toBe(0n);
    expect(shortRiskCharge(ONE / 2n, ONE, call)).toBe(0n); // partial close of a long
    expect(shortRiskCharge(ONE, (4n * ONE) / 10n, call)).toBe(35_700_000n); // 0.6 opened
  });
  it("a flip (sell more than the long) charges the new short only", () => {
    expect(openedShortOf(3n * ONE, ONE)).toBe(2n * ONE);
    expect(shortRiskCharge(3n * ONE, ONE, call)).toBe(119_000_000n);
  });
  it("adding to an existing short charges the whole leg", () => {
    expect(shortRiskCharge(2n * ONE, -ONE, put)).toBe(99_000_000n);
  });
});

describe("spend charge (buy legs)", () => {
  const call = 59_500_000n;
  it("buying to open is charged premium + fee in full", () => {
    expect(spendCharge(ONE, 0n, call, 1_608_000n)).toBe(1_608_000n);
    expect(spendCharge(ONE, ONE, call, 1_608_000n)).toBe(1_608_000n); // adding to a long
  });
  it("buying back a short at or below its worst case is free, full or partial", () => {
    expect(spendCharge(ONE, -ONE, call, 1_608_000n)).toBe(0n);
    expect(spendCharge(ONE / 2n, -ONE, call, 804_000n)).toBe(0n);
    expect(spendCharge(ONE, -ONE, call, 59_500_000n)).toBe(0n);
  });
  it("only what is paid above the closed short's worst case (floored) is charged", () => {
    expect(spendCharge(ONE, -ONE, call, 60_000_000n)).toBe(500_000n);
    expect(closedShortOf(ONE, -THIRD)).toBe(THIRD);
    expect(spendCharge(ONE, -THIRD, call, 20_000_000n)).toBe(166_667n); // worst case 19_833_333.33 floors to 19_833_333
  });
  it("a flip (buy more than the short) nets the payment against the closed short's worst case", () => {
    expect(spendCharge(3n * ONE, -ONE, call, 5_000_000n)).toBe(0n);
    expect(spendCharge(2n * ONE, -(ONE / 10n), call, 10_000_000n)).toBe(4_050_000n); // 10 - 5.95
  });
});

describe("sessionChargeOf", () => {
  const budgets = { riskLeft: 100_000_000n, spendLeft: 1_000_000n };
  it("names the budget each side draws and whether it fits", () => {
    const sell = sessionChargeOf({ side: "sell", quantityRaw: 2n * ONE, positionBeforeRaw: 0n, maxPayoutRaw: 59_500_000n }, budgets);
    expect(sell).toMatchObject({ budget: "shortRisk", openedShortRaw: 2n * ONE, chargeRaw: 119_000_000n, leftRaw: 100_000_000n, withinBudget: false });
    expect(describeSessionCharge(sell)).toMatch(/119 USDG from the short-risk budget .*left 100 -> the fill will revert SessionLimit/);
    expect(sessionLimitDetail(sell)).toMatch(/short-risk budget \(riskLeft.*--max-short-risk/);
    const buy = sessionChargeOf({ side: "buy", quantityRaw: ONE, positionBeforeRaw: 0n, maxPayoutRaw: 59_500_000n, paidRaw: 1_608_000n }, budgets);
    expect(buy).toMatchObject({ budget: "spend", closedShortRaw: 0n, chargeRaw: 1_608_000n, withinBudget: false });
    expect(sessionLimitDetail(buy)).toMatch(/spend budget \(spendLeft.*--max-spend/);
    const close = sessionChargeOf({ side: "buy", quantityRaw: ONE, positionBeforeRaw: -ONE, maxPayoutRaw: 59_500_000n, paidRaw: 1_608_000n }, { riskLeft: 0n, spendLeft: 0n });
    expect(close).toMatchObject({ chargeRaw: 0n, withinBudget: true });
    expect(describeSessionCharge(close)).toMatch(/^session charge: 0 USDG from the spend budget \(closes a short/);
  });
  it("0 budgets: the key cannot sell to open nor buy to open; it can still close", () => {
    const zero = { riskLeft: 0n, spendLeft: 0n };
    expect(sessionChargeOf({ side: "sell", quantityRaw: ONE, positionBeforeRaw: 0n, maxPayoutRaw: 1n }, zero).withinBudget).toBe(false);
    expect(sessionChargeOf({ side: "sell", quantityRaw: ONE, positionBeforeRaw: ONE, maxPayoutRaw: 59_500_000n }, zero).withinBudget).toBe(true);
  });
  it("UNLIMITED fits anything and stays 'unlimited' after charges", () => {
    const c = sessionChargeOf({ side: "sell", quantityRaw: 1000n * ONE, positionBeforeRaw: 0n, maxPayoutRaw: 59_500_000n }, { riskLeft: UNLIMITED, spendLeft: UNLIMITED });
    expect(c.withinBudget).toBe(true);
    expect(formatSessionCap(UNLIMITED - c.chargeRaw)).toBe("unlimited");
  });
  it("without budgets withinBudget is undefined; a buy needs what it pays", () => {
    expect(sessionChargeOf({ side: "sell", quantityRaw: ONE, positionBeforeRaw: 0n, maxPayoutRaw: 1n }).withinBudget).toBeUndefined();
    expect(() => sessionChargeOf({ side: "buy", quantityRaw: ONE, positionBeforeRaw: 0n, maxPayoutRaw: 1n })).toThrow(/paidRaw/);
  });
});

describe("maxPaidUntilExpiry", () => {
  const base: Order = {
    maker: "0x1111111111111111111111111111111111111111", signer: "0x1111111111111111111111111111111111111111", taker: "0x3333333333333333333333333333333333333333",
    chainId: 46630n, settlement: "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5", market: "0xC289617d613C9865a6595B365DaD88277282e0Ac",
    instrumentId: encodeInstrumentId(1793390400n, 220_000_000n, false), side: Side.Ask, quantityRaw: 2n * ONE, minFillRaw: 0n,
    premiumStartRaw: 3_000_000n, premiumEndRaw: 3_200_000n, startTime: 1000n, validUntil: 1060n, stockMultiplier: ONE, nonce: 1n, fromBalance: true,
  };
  it("bounds a rising ask by its end premium and a falling one by its current premium, fee included", () => {
    const rising = maxPaidUntilExpiry(base, ONE, 50, 1010);
    expect(rising).toBe(1_600_000n + takerFeeFor(1_600_000n, 50));
    const falling = { ...base, premiumStartRaw: 3_200_000n, premiumEndRaw: 3_000_000n };
    const now = premiumFor(falling, ONE, 1010);
    expect(maxPaidUntilExpiry(falling, ONE, 50, 1010)).toBe(now + takerFeeFor(now, 50));
  });
  it("is 0 for a bid (the taker sells)", () => {
    expect(maxPaidUntilExpiry({ ...base, side: Side.Bid }, ONE, 50, 1010)).toBe(0n);
  });
});
