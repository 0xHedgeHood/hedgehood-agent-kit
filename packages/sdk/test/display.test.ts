import { describe, expect, it } from "vitest";
import { asciiTable, renderPnlDashboard, type PnlPosition, type PnlView } from "../src/index.js";

const account = "0x3333333333333333333333333333333333333333";
const row = (extra: Partial<PnlPosition> = {}): PnlPosition => ({
  instrument: "NVDA-20261030-220-C", market: account, expiry: 1793390400, strike: "220000000", isPut: false,
  quantityRaw: "1000000000000000000", costRaw: "2000000", avgPriceRaw: "2000000", markMid: 3,
  markSource: "fixture", markAt: 1793300000, unrealizedRaw: "1000000", settledAt: null, settlementRaw: null, ...extra,
});
const view = (extra: Partial<PnlView> = {}): PnlView => ({
  account, asOf: 1793300000, positions: [row()], realizedRaw: "0", unrealizedRaw: "1000000", feesPaidRaw: "10000", totalRaw: "990000", ...extra,
});

describe("portable account dashboard", () => {
  it("preserves exact amounts, signed bars, network and report/mark time", () => {
    const display = renderPnlDashboard(view({ positions: [row(), row({ instrument: "TSLA-20261030-200-P", unrealizedRaw: "-1" })], realizedRaw: "9007199254740993123456" }), 46630);
    expect(display).toContain("+9007199254740993.123456");
    expect(display).toContain("+0.99");
    expect(display).toContain("-0.000001");
    expect(display).toContain("|##########");
    expect(display).toContain("#|");
    expect(display).toContain("TESTNET (46630)");
    expect(display).toContain("Mark timestamps: oldest");
    expect(display).toContain("snapshot, not history");
    expect(display).toMatch(/^[\x20-\x7e\n]+$/);
  });

  it("never renders a partial backend total as a complete total when a mark is missing", () => {
    const display = renderPnlDashboard(view({ positions: [row({ markMid: null, unrealizedRaw: null })], unrealizedRaw: null, totalRaw: "999000000" }), 4663);
    expect(display).toContain("N/A (missing marks)");
    expect(display).toContain("INCOMPLETE");
    expect(display).not.toContain("+999");
    expect(display).not.toContain("UNREALIZED BY POSITION");
  });

  it("does not call settled or flat rows active, while keeping lifetime totals", () => {
    const display = renderPnlDashboard(view({ positions: [row({ settledAt: 1793290000 }), row({ quantityRaw: "0" })] }), 46630);
    expect(display).toContain("OPEN POSITIONS (0)");
    expect(display).toContain("+0.99");
    expect(display).not.toContain("UNREALIZED BY POSITION");
  });

  it("strips terminal controls and code fences from external text", () => {
    const table = asciiTable(["Name"], [["\x1b[2Jevil\n```\x07"]]);
    expect(table).not.toContain("\x1b");
    expect(table).not.toContain("```");
    expect(table).toMatch(/^[\x20-\x7e\n]+$/);
  });
});
