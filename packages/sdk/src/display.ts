import type { PnlView } from "./rfq.js";
import { formatSignedUsdg, formatTimeToExpiry } from "./pnl.js";
import { formatShares, formatUsdg } from "./units.js";

/** Printable ASCII only: backend text cannot move the cursor or break a Markdown code fence. */
function cell(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[^\x20-\x7e]/g, " ").replace(/`/g, "'");
}

/** Shared plain-text rendering for terminals and MCP clients; no ANSI/colour dependency. */
export function asciiTable(headers: string[], rows: string[][]): string {
  const clean = [headers, ...rows].map((row) => headers.map((_, i) => cell(row[i] ?? "")));
  const widths = headers.map((_, i) => Math.max(...clean.map((row) => row[i]!.length)));
  const rule = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const line = (row: string[]) => "| " + row.map((v, i) => /^[+-]?\d/.test(v) && i > 0 ? v.padStart(widths[i]!) : v.padEnd(widths[i]!)).join(" | ") + " |";
  return [rule, line(clean[0]!), rule, ...clean.slice(1).map(line), rule].join("\n");
}

const money = (raw: string | null | undefined) => formatSignedUsdg(raw) ?? "N/A";
const abs = (n: bigint) => n < 0n ? -n : n;

/** Account-wide indexer snapshot, not a return series or an executable close valuation. */
export function renderPnlDashboard(p: PnlView, chainId: number): string {
  const active = p.positions.filter((row) => row.settledAt == null && BigInt(row.quantityRaw) !== 0n);
  const incomplete = p.unrealizedRaw == null || active.some((row) => row.unrealizedRaw == null || row.markMid == null);
  const network = chainId === 46630 ? "TESTNET" : chainId === 4663 ? "MAINNET" : `CHAIN ${chainId}`;
  const unit = chainId === 46630 ? "TestUSD (test funds)" : "USDG";
  const lines = [
    `HEDGEHOOD / OPTIONS / ${network} (${chainId})`,
    `Account  ${cell(p.account)}`,
    `Report   ${new Date(p.asOf * 1000).toISOString()} | account-wide indexer snapshot`,
    "",
    asciiTable(["Realized", "Unrealized", "Fees paid", "Total P&L"], [[money(p.realizedRaw), money(p.unrealizedRaw), formatUsdg(BigInt(p.feesPaidRaw)), incomplete ? "N/A (missing marks)" : money(p.totalRaw)]]),
    "",
    `OPEN POSITIONS (${active.length}) / ${unit}`,
    active.length ? asciiTable(["Instrument", "Qty", "Avg", "Mid", "Unrealized", "Expiry*"], active.map((row) => [
      row.instrument, formatShares(BigInt(row.quantityRaw)), row.avgPriceRaw == null ? "N/A" : formatUsdg(BigInt(row.avgPriceRaw)),
      row.markMid == null ? "N/A" : String(row.markMid), money(row.unrealizedRaw), formatTimeToExpiry(row.expiry, p.asOf),
    ])) : "No open positions. Realized totals can include closed/settled positions.",
  ];
  // Scale in integer raw units: preserve small losses and never convert monetary values to Number.
  const ranked = active.filter((row) => row.unrealizedRaw != null).sort((a, b) => {
    const diff = abs(BigInt(b.unrealizedRaw!)) - abs(BigInt(a.unrealizedRaw!));
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  }).slice(0, 6);
  const scale = ranked.reduce((max, row) => abs(BigInt(row.unrealizedRaw!)) > max ? abs(BigInt(row.unrealizedRaw!)) : max, 0n);
  if (ranked.length) {
    lines.push("", "UNREALIZED BY POSITION (up to 6 largest |P&L|; snapshot, not history)");
    lines.push(asciiTable(["Instrument", "loss <        0        > gain", "P&L"], ranked.map((row) => {
      const value = BigInt(row.unrealizedRaw!);
      const size = value === 0n || scale === 0n ? 0 : Math.max(1, Number(abs(value) * 10n / scale));
      const left = value < 0n ? "#".repeat(size).padStart(10) : " ".repeat(10);
      const right = value > 0n ? "#".repeat(size).padEnd(10) : " ".repeat(10);
      return [row.instrument, `${left}|${right}`, money(row.unrealizedRaw)];
    })));
  }
  const times = active.map((row) => row.markAt).filter((v): v is number => v != null);
  if (active.length) lines.push(`Mark timestamps: ${times.length === active.length ? "oldest " + new Date(Math.min(...times) * 1000).toISOString() : "not available for every position"}.`);
  lines.push("* Time to expiry at report time. Qty uses backend token-share units.", `${unit}. Totals from indexer; fees shown separately, not deducted again.`, "Mark-to-mid valuation; a close quote may differ. No broker/desk P&L included.");
  if (incomplete) lines.push("INCOMPLETE: missing marks; total P&L is unavailable, not zero.");
  if (p.note) lines.push(`Note: ${cell(p.note)}`);
  return lines.join("\n");
}
