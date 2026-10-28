import { instrumentName } from "./instrument.js";
import type { Position } from "./market.js";
import type { PnlPosition, PnlView } from "./rfq.js";
import { formatUsdg } from "./units.js";

/** Seconds -> "3d 4h", "2h 05m", "12m", "expired". */
export function formatTimeToExpiry(expiry: bigint | number, now: number = Math.floor(Date.now() / 1000)): string {
  const s = Number(expiry) - now;
  if (s <= 0) return "expired";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m}m`;
}

/** Signed USDG raw string -> "+1.25" / "-0.30"; null -> undefined. */
export function formatSignedUsdg(raw: string | bigint | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const v = typeof raw === "bigint" ? raw : BigInt(raw);
  return `${v >= 0n ? "+" : "-"}${formatUsdg(v < 0n ? -v : v)}`;
}

export interface PositionPnlFields {
  /** Backend instrument name of the position. */
  instrument: string;
  /** Average entry price per share, USDG; undefined when the indexer has none. */
  avgPrice?: string;
  /** Desk mid per share, USDG (number); undefined without a mark. */
  mark?: number;
  markBid?: number;
  markAsk?: number;
  /** Mark-to-mid P&L, signed USDG ("+1.25"); undefined without a mark. */
  unrealized?: string;
  unrealizedRaw?: string;
  secondsToExpiry: number;
  expiresIn: string;
}

/** Index a `PnlView` by instrument name. */
export function pnlByInstrument(pnl: PnlView | undefined): Map<string, PnlPosition> {
  const m = new Map<string, PnlPosition>();
  for (const p of pnl?.positions ?? []) m.set(p.instrument.toUpperCase(), p);
  return m;
}

/** On-chain position + the indexer's P&L row for it (when available) + time to expiry. */
export function positionPnl(position: Position, underlying: string, pnl: PnlView | Map<string, PnlPosition> | undefined, now: number = Math.floor(Date.now() / 1000)): PositionPnlFields {
  const instrument = instrumentName(underlying, position.expiry, position.strike, position.isPut, position.uiMultiplier);
  const rows = pnl instanceof Map ? pnl : pnlByInstrument(pnl);
  const row = rows.get(instrument.toUpperCase());
  const avgPrice = row?.avgPriceRaw != null ? formatUsdg(BigInt(row.avgPriceRaw)) : undefined;
  return {
    instrument,
    avgPrice,
    mark: row?.markMid ?? undefined,
    markBid: row?.markBid ?? undefined,
    markAsk: row?.markAsk ?? undefined,
    unrealized: formatSignedUsdg(row?.unrealizedRaw),
    unrealizedRaw: row?.unrealizedRaw ?? undefined,
    secondsToExpiry: Math.max(0, Number(position.expiry) - now),
    expiresIn: formatTimeToExpiry(position.expiry, now),
  };
}
