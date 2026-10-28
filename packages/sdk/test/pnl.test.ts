import { describe, expect, it } from "vitest";
import { encodeInstrumentId, formatSignedUsdg, formatTimeToExpiry, positionPnl, type PnlView, type Position } from "../src/index.js";

const EXPIRY = 1793390400n;
const NOW = Number(EXPIRY) - 2 * 86400 - 3 * 3600 - 7 * 60;
const pos: Position = { instrumentId: encodeInstrumentId(EXPIRY, 220_000_000n, false), expiry: EXPIRY, strike: 220_000_000n, shareStrike: 220_000_000n, uiMultiplier: 10n ** 18n, isPut: false, quantityRaw: 2n * 10n ** 18n };
const pnl: PnlView = {
  account: "0x3333333333333333333333333333333333333333",
  asOf: NOW,
  positions: [{ instrument: "NVDA-20261030-220-C", market: "0xC289617d613C9865a6595B365DaD88277282e0Ac", expiry: Number(EXPIRY), strike: "220000000", isPut: false, quantityRaw: "2000000000000000000", costRaw: "3360000", avgPriceRaw: "1680000", markMid: 1.625, markBid: 1.57, markAsk: 1.68, markSource: "desk", markAt: NOW, unrealizedRaw: "-110000", settledAt: null, settlementRaw: null }],
  realizedRaw: "0",
  unrealizedRaw: "-110000",
  feesPaidRaw: "16800",
  totalRaw: "-126800",
};

describe("pnl helpers", () => {
  it("formats time to expiry", () => {
    expect(formatTimeToExpiry(EXPIRY, NOW)).toBe("2d 3h");
    expect(formatTimeToExpiry(EXPIRY, Number(EXPIRY) - 3 * 3600 - 5 * 60)).toBe("3h 05m");
    expect(formatTimeToExpiry(EXPIRY, Number(EXPIRY) - 12 * 60 - 30)).toBe("12m");
    expect(formatTimeToExpiry(EXPIRY, Number(EXPIRY) + 1)).toBe("expired");
  });

  it("formats signed USDG", () => {
    expect(formatSignedUsdg("554900")).toBe("+0.5549");
    expect(formatSignedUsdg(-110000n)).toBe("-0.11");
    expect(formatSignedUsdg(null)).toBeUndefined();
  });

  it("joins an on-chain position with its indexer P&L row by instrument name", () => {
    const f = positionPnl(pos, "nvda", pnl, NOW);
    expect(f).toEqual({ instrument: "NVDA-20261030-220-C", avgPrice: "1.68", mark: 1.625, markBid: 1.57, markAsk: 1.68, unrealized: "-0.11", unrealizedRaw: "-110000", secondsToExpiry: 2 * 86400 + 3 * 3600 + 7 * 60, expiresIn: "2d 3h" });
    const none = positionPnl({ ...pos, isPut: true }, "NVDA", pnl, NOW);
    expect(none.instrument).toBe("NVDA-20261030-220-P");
    expect(none.avgPrice).toBeUndefined();
    expect(none.unrealized).toBeUndefined();
    expect(positionPnl(pos, "NVDA", undefined, NOW).expiresIn).toBe("2d 3h");
  });
});
