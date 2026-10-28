import { describe, expect, it } from "vitest";
import { decodeInstrumentId, describeInstrument, encodeInstrumentId, EXPIRY_SHIFT, gridFor, kindOf, MAX_STRIKE } from "../src/index.js";

describe("instrument ids", () => {
  it("encode/decode round trip for calls and puts", () => {
    const id = encodeInstrumentId(1793390400n, 220_000_000n, true);
    expect(id & 1n).toBe(1n);
    expect(decodeInstrumentId(id)).toEqual({ expiry: 1793390400n, strike: 220_000_000n, isPut: true });
    expect(decodeInstrumentId(id.toString())).toEqual({ expiry: 1793390400n, strike: 220_000_000n, isPut: true });
    expect(kindOf(id)).toBe("put");
    expect(kindOf(id - 1n)).toBe("call");
    expect(EXPIRY_SHIFT).toBe(96n);
  });

  it("matches the contract's layout and bounds", () => {
    expect(encodeInstrumentId(1n, 1n, false)).toBe((1n << 96n) | 2n);
    expect(encodeInstrumentId(1n, MAX_STRIKE, false)).toBe((1n << 96n) | (MAX_STRIKE << 1n));
    expect(() => encodeInstrumentId(1n, MAX_STRIKE + 1n, false)).toThrow(RangeError);
    expect(() => encodeInstrumentId(1n, 0n, false)).toThrow(RangeError);
    expect(() => encodeInstrumentId(1n << 160n, 1n, false)).toThrow(RangeError);
  });

  it("describes an instrument", () => {
    expect(describeInstrument(encodeInstrumentId(1793390400n, 222_500_000n, false), "NVDA")).toBe("NVDA 2026-10-30 222.5 C");
  });

  it("reproduces the testnet grid from MARKET_V2.md (anchor 217.405 -> 195..235 on $5 steps)", () => {
    const { capLow, capHigh, strikes } = gridFor(217_405_000n, { capBandBps: 5000n, strikeStepBps: 250n, strikeTick: 1_000_000n, strikesPerSide: 4n });
    expect(capLow).toBe(108_702_500n);
    expect(capHigh).toBe(326_107_500n);
    expect(strikes.map((s) => Number(s / 1_000_000n))).toEqual([195, 200, 205, 210, 215, 220, 225, 230, 235]);
  });
});
