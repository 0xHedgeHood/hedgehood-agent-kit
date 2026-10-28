/**
 * Instrument ids of CashOptionMarketV2:
 *
 *   instrumentId = (expiry << 96) | (strike << 1) | (isPut ? 1 : 0)
 *
 * `expiry` is unix seconds (the 16:00 New York close), `strike` is USDG raw (1e6) per whole share, as in the
 * contract (`EXPIRY_SHIFT = 96`, `MAX_STRIKE = 2^95 - 1`).
 */

export const EXPIRY_SHIFT = 96n;
export const MAX_STRIKE = (1n << 95n) - 1n;
export const MAX_EXPIRY = (1n << (256n - EXPIRY_SHIFT)) - 1n;

export interface Instrument {
  /** Unix seconds of the expiry (market close). */
  expiry: bigint;
  /** Strike in USDG raw (6 decimals) per whole share. */
  strike: bigint;
  isPut: boolean;
}

export type OptionKind = "call" | "put";

/** Encodes an instrument id exactly as `CashOptionMarketV2.instrumentId(expiry, strike, isPut)`. */
export function encodeInstrumentId(expiry: bigint | number, strike: bigint | number, isPut: boolean): bigint {
  const e = BigInt(expiry);
  const s = BigInt(strike);
  if (e < 0n || e > MAX_EXPIRY) throw new RangeError(`expiry out of range: ${e}`);
  if (s <= 0n || s > MAX_STRIKE) throw new RangeError(`strike out of range: ${s}`);
  return (e << EXPIRY_SHIFT) | (s << 1n) | (isPut ? 1n : 0n);
}

/** Decodes an instrument id exactly as `CashOptionMarketV2.decodeInstrument(id)`. */
export function decodeInstrumentId(id: bigint | string): Instrument {
  const v = typeof id === "string" ? BigInt(id) : id;
  if (v < 0n) throw new RangeError("negative instrument id");
  return {
    expiry: v >> EXPIRY_SHIFT,
    strike: (v >> 1n) & MAX_STRIKE,
    isPut: (v & 1n) === 1n,
  };
}

/** The expiry an id belongs to (what the book uses to bound `validUntil`). */
export function expiryOf(id: bigint): bigint {
  return id >> EXPIRY_SHIFT;
}

export function kindOf(id: bigint): OptionKind {
  return (id & 1n) === 1n ? "put" : "call";
}

/** Human label such as "NVDA 2026-10-30 220 C". */
export function describeInstrument(id: bigint, underlying = ""): string {
  const { expiry, strike, isPut } = decodeInstrumentId(id);
  const date = new Date(Number(expiry) * 1000).toISOString().slice(0, 10);
  const k = strike / 1_000_000n;
  const frac = strike % 1_000_000n;
  const strikeText = frac === 0n ? k.toString() : `${k}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
  return `${underlying ? underlying + " " : ""}${date} ${strikeText} ${isPut ? "P" : "C"}`;
}

/**
 * The strike grid an opening at `anchor` would fix, mirroring `CashOptionMarketV2.gridFor`. Useful to reproduce the
 * strikes from an `ExpiryOpened` event's anchor without an RPC call. All inputs are raw bigints.
 */
export function gridFor(
  anchor: bigint,
  params: { capBandBps: bigint; strikeStepBps: bigint; strikeTick: bigint; strikesPerSide: bigint },
): { capLow: bigint; capHigh: bigint; strikes: bigint[] } {
  const BPS = 10_000n;
  const capLow = (anchor * (BPS - params.capBandBps)) / BPS;
  const capHigh = (anchor * (BPS + params.capBandBps)) / BPS;
  if (capLow === 0n || anchor <= capLow || anchor >= capHigh) throw new RangeError("invalid grid configuration");
  const tick = params.strikeTick;
  let step = (((anchor * params.strikeStepBps) / BPS + tick / 2n) / tick) * tick;
  if (step === 0n) step = tick;
  const centre = ((anchor + step / 2n) / step) * step;
  const n = params.strikesPerSide;
  const first = centre > n * step ? centre - n * step : 0n;
  const strikes: bigint[] = [];
  for (let s = first; s <= centre + n * step; s += step) {
    if (s > capLow && s < capHigh) strikes.push(s);
  }
  return { capLow, capHigh, strikes };
}
