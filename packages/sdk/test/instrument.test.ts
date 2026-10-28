import { describe, expect, it } from "vitest";
import { decodeInstrumentId, describeInstrument, encodeInstrumentId, EXPIRY_SHIFT, gridFor, instrumentName, instrumentNameOf, kindOf, MAX_STRIKE, resolveInstrumentName, shareStrikeOf, tokenStrikeOf } from "../src/index.js";

/** NVDA's mainnet uiMultiplier on 2026-10-28 (hedgehood-options aa47f7f fork test). */
const NVDA_M = 1_000_775_159_164_630_595n;
const EXPIRY = 1793390400n; // 2026-10-30 16:00 New York

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

  it("gridFor(anchor, 1e18, ...) equals the two-argument form", () => {
    const p = { capBandBps: 5000n, strikeStepBps: 250n, strikeTick: 1_000_000n, strikesPerSide: 4n };
    expect(gridFor(217_405_000n, 10n ** 18n, p)).toEqual(gridFor(217_405_000n, p));
  });

  it("lays the grid in listed per-share USD under a multiplier (contract test vector: ORCL M 1.00476, anchor 131.04)", () => {
    const m = 1_004_760_000_000_000_000n;
    const { capLow, capHigh, strikes } = gridFor(131_040_000n, m, { capBandBps: 5000n, strikeStepBps: 150n, strikeTick: 2_500_000n, strikesPerSide: 6n });
    expect(capLow).toBe(65_520_000n);
    expect(capHigh).toBe(196_560_000n);
    expect(strikes.length).toBe(13);
    expect(strikes[0]).toBe(115_547_400n);
    strikes.forEach((k, i) => {
      const listed = 115_000_000n + BigInt(i) * 2_500_000n;
      expect(k).toBe((listed * m + 5n * 10n ** 17n) / 10n ** 18n);
      expect(tokenStrikeOf(listed, m)).toBe(k);
      expect(shareStrikeOf(k, m)).toBe(listed);
    });
  });
});

describe("per-share strikes under a non-1e18 uiMultiplier", () => {
  // the NVDA 220 strike is stored per token as round(220e6 x M / 1e18) = 220170535 (not a whole dollar)
  const K220 = 220_170_535n;
  const CALL220 = encodeInstrumentId(EXPIRY, K220, false);

  it("maps per-token strikes to listed per-share strikes and back", () => {
    expect(tokenStrikeOf(220_000_000n, NVDA_M)).toBe(K220);
    expect(shareStrikeOf(K220, NVDA_M)).toBe(220_000_000n);
    expect(shareStrikeOf(K220)).toBe(K220); // M = 1e18: unchanged
    expect(() => shareStrikeOf(K220, 0n)).toThrow(RangeError);
  });

  it("names and labels show the per-share strike", () => {
    expect(instrumentName("NVDA", EXPIRY, K220, false, NVDA_M)).toBe("NVDA-20261030-220-C");
    expect(instrumentNameOf(CALL220, "NVDA", NVDA_M)).toBe("NVDA-20261030-220-C");
    expect(describeInstrument(CALL220, "NVDA", NVDA_M)).toBe("NVDA 2026-10-30 220 C");
    // without the multiplier the per-token raw shows through
    expect(instrumentNameOf(CALL220, "NVDA")).toBe("NVDA-20261030-220.170535-C");
  });

  it("resolves a per-share name to the listed per-token strike", () => {
    const strikes = [215_000_000n, 220_000_000n, 225_000_000n].map((s) => tokenStrikeOf(s, NVDA_M));
    const listed = [{ expiry: EXPIRY, uiMultiplier: NVDA_M, strikes }];
    expect(resolveInstrumentName("NVDA-20261030-220-C", listed)).toBe(CALL220);
    expect(resolveInstrumentName("nvda-20261030-225-p", listed)).toBe(encodeInstrumentId(EXPIRY, strikes[2]!, true));
    // an exact per-token strike is accepted too
    expect(resolveInstrumentName("NVDA-20261030-220.170535-C", listed)).toBe(CALL220);
    expect(() => resolveInstrumentName("NVDA-20261030-230-C", listed)).toThrow(/no strike 230 .*215, 220, 225/);
    // without strikes: computed from the multiplier
    expect(resolveInstrumentName("NVDA-20261030-220-C", [{ expiry: EXPIRY, uiMultiplier: NVDA_M }])).toBe(CALL220);
    // bare expiries keep the M = 1e18 behaviour
    expect(resolveInstrumentName("NVDA-20261030-220-C", [EXPIRY])).toBe(encodeInstrumentId(EXPIRY, 220_000_000n, false));
  });
});
