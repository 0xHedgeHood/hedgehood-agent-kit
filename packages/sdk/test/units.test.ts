import { describe, expect, it } from "vitest";
import { formatShares, formatStrike, formatUsdg, parseShares, parseUsdg, pricePerShare } from "../src/index.js";

describe("units", () => {
  it("parses and formats USDG (6 decimals) and shares (18 decimals)", () => {
    expect(parseUsdg("25")).toBe(25_000_000n);
    expect(parseUsdg("$0.5")).toBe(500_000n);
    expect(parseUsdg(1.25)).toBe(1_250_000n);
    expect(() => parseUsdg("0.0000001")).toThrow();
    expect(formatUsdg(1_250_000n)).toBe("1.25");
    expect(parseShares("1.5")).toBe(15n * 10n ** 17n);
    expect(formatShares(5n * 10n ** 17n)).toBe("0.5");
  });
  it("formats strikes and per-share prices", () => {
    expect(formatStrike(220_000_000n)).toBe("220");
    expect(formatStrike(222_500_000n)).toBe("222.5");
    expect(formatStrike(1_000_000n)).toBe("1");
    expect(pricePerShare(5_000_000n, 10n ** 18n)).toBe("5");
    expect(pricePerShare(5_000_000n, 2n * 10n ** 18n)).toBe("2.5");
  });
});
