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

function panel(title: string, body: string[]): string {
  const clean = [title, ...body].map(cell);
  const width = Math.max(72, ...clean.map((line) => line.length));
  const rule = "+" + "-".repeat(width + 2) + "+";
  const line = (text: string) => `| ${text.padEnd(width)} |`;
  return [rule, line(clean[0]!), rule, ...clean.slice(1).map(line), rule].join("\n");
}

/** Separate scales for realized and unrealized charts; these are comparisons, never an equity curve. */
function bars(title: string, rows: { instrument: string; raw: string | null | undefined }[]): string[] {
  const ranked = rows.filter((row) => row.raw != null).sort((a, b) => {
    const diff = abs(BigInt(b.raw!)) - abs(BigInt(a.raw!));
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  }).slice(0, 6);
  if (!ranked.length) return [];
  const scale = ranked.reduce((max, row) => abs(BigInt(row.raw!)) > max ? abs(BigInt(row.raw!)) : max, 0n);
  const body = [`  ${"LOSS".padEnd(10)}0${"GAIN".padStart(10)}`, ""];
  for (const row of ranked) {
    const value = BigInt(row.raw!);
    const size = value === 0n || scale === 0n ? 0 : Math.max(1, Number(abs(value) * 10n / scale));
    const left = value < 0n ? "#".repeat(size).padStart(10) : " ".repeat(10);
    const right = value > 0n ? "#".repeat(size).padEnd(10) : " ".repeat(10);
    body.push(row.instrument, `  ${left}|${right}  ${money(row.raw)}`, "");
  }
  body.push("Up to 6 largest |P&L|. Shared scale within this chart; not a return %.");
  return ["", panel(title, body)];
}

/** Account-wide indexer snapshot, not a return series or an executable close valuation. */
export function renderPnlDashboard(p: PnlView, chainId: number): string {
  const active = p.positions.filter((row) => row.settledAt == null && BigInt(row.quantityRaw) !== 0n);
  const closed = p.positions.filter((row) => !active.includes(row));
  const incomplete = p.unrealizedRaw == null || active.some((row) => row.unrealizedRaw == null || row.markMid == null);
  const network = chainId === 46630 ? "TESTNET" : chainId === 4663 ? "MAINNET" : `CHAIN ${chainId}`;
  const unit = chainId === 46630 ? "TestUSD (test funds)" : "USDG";
  const total = incomplete ? "N/A (missing marks)" : money(p.totalRaw);
  const state = incomplete ? "INCOMPLETE" : BigInt(p.totalRaw) < 0n ? "LOSS" : BigInt(p.totalRaw) > 0n ? "PROFIT" : "FLAT";
  const lines = [
    panel(`HEDGEHOOD / OPTIONS / ${network} (${chainId})`, [
      "P O R T F O L I O",
      "",
      `Account  ${p.account}`,
      `Report   ${new Date(p.asOf * 1000).toISOString()}`,
      "",
      `TOTAL P&L   ${total}   [${state}]`,
      `Realized    ${money(p.realizedRaw)}    |    Unrealized  ${money(p.unrealizedRaw)}`,
      `Fees paid   ${formatUsdg(BigInt(p.feesPaidRaw))} (already included)`,
      "",
      `${active.length} OPEN  /  ${closed.length} CLOSED OR SETTLED    |    ${unit}`,
    ]),
    "",
    active.length ? `OPEN POSITIONS (${active.length}) / ${unit}\n` + asciiTable(["Instrument", "Qty", "Avg", "Mid", "Unrealized", "Expiry*"], active.map((row) => [
      row.instrument, formatShares(BigInt(row.quantityRaw)), row.avgPriceRaw == null ? "N/A" : formatUsdg(BigInt(row.avgPriceRaw)),
      row.markMid == null ? "N/A" : String(row.markMid), money(row.unrealizedRaw), formatTimeToExpiry(row.expiry, p.asOf),
    ])) : panel("OPEN POSITIONS (0)", ["No open positions.", closed.length ? "Your closed / settled results are shown below." : "No position records yet."]),
  ];
  lines.push(...bars("UNREALIZED BY POSITION (snapshot, not history)", active.map((row) => ({ instrument: row.instrument, raw: row.unrealizedRaw }))));
  if (closed.length) {
    lines.push(...bars("REALIZED BY CLOSED / SETTLED POSITION (not history)", closed.map((row) => ({ instrument: row.instrument, raw: row.realizedRaw }))));
    const missing = closed.filter((row) => row.realizedRaw == null);
    if (missing.length) lines.push("", panel("CLOSED / SETTLED - P&L UNAVAILABLE", missing.map((row) => `${row.instrument}  N/A`)));
  }
  const times = active.map((row) => row.markAt).filter((v): v is number => v != null);
  lines.push("");
  if (active.length) {
    lines.push(`Mark timestamps: ${times.length === active.length ? "oldest " + new Date(Math.min(...times) * 1000).toISOString() : "not available for every position"}.`);
    lines.push("* Time to expiry at report time. Qty uses backend token-share units.", "Mid-price estimates; actual close proceeds may differ.");
  }
  lines.push(`${unit}. Account-wide indexer snapshot; fees already included.`);
  if (incomplete) lines.push("INCOMPLETE: missing marks; total P&L is unavailable, not zero.");
  // The deployed backend's note is a raw-field schema, not portfolio commentary. Keep it in JSON only.
  if (p.note && !p.note.startsWith("USDG raw (1e6)")) lines.push(`Note: ${cell(p.note)}`);
  return lines.join("\n");
}
