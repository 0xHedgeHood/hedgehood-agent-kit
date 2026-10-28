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

// ---------------------------------------------------------------- backend instrument names
// The RFQ service names instruments `UNDERLYING-YYYYMMDD-STRIKE-C|P` (rfq/registry.py `instrument_key`): the New York
// calendar date of the expiry and the strike in USD as Python's `f"{usd:g}"` prints it ("200", "202.5").

const NY_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** `YYYYMMDD` of a unix expiry in New York time (the OCC date). */
export function expiryDateNY(expiry: bigint | number): string {
  return NY_DATE.format(new Date(Number(expiry) * 1000)).replace(/-/g, "");
}

/** Strike label as the backend prints it: 220000000n -> "220", 222500000n -> "222.5". */
export function strikeLabel(strikeRaw: bigint): string {
  const whole = strikeRaw / 1_000_000n;
  const frac = (strikeRaw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function instrumentName(underlying: string, expiry: bigint | number, strikeRaw: bigint, isPut: boolean): string {
  return `${underlying.toUpperCase()}-${expiryDateNY(expiry)}-${strikeLabel(strikeRaw)}-${isPut ? "P" : "C"}`;
}

export const INSTRUMENT_NAME_RE = /^([A-Z]{1,8})-(\d{8})-(\d+(?:\.\d+)?)-([CP])$/;

/** Parses `NVDA-20261030-220-C`; the expiry is a date, so the unix expiry needs the market's opened expiries to resolve. */
export function parseInstrumentName(text: string): { underlying: string; date: string; strikeRaw: bigint; isPut: boolean } {
  const m = INSTRUMENT_NAME_RE.exec(text.trim().toUpperCase());
  if (!m) throw new RangeError(`instrument must look like NVDA-20261030-220-C, got ${text}`);
  const [whole, frac = ""] = m[3]!.split(".");
  if (frac.length > 6) throw new RangeError("strike has more than 6 decimals");
  const strikeRaw = BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0");
  return { underlying: m[1]!, date: m[2]!, strikeRaw, isPut: m[4] === "P" };
}

/** Resolves a backend instrument name to an id given the market's opened expiries (unix seconds). */
export function resolveInstrumentName(text: string, expiries: Iterable<bigint>): bigint {
  const p = parseInstrumentName(text);
  for (const e of expiries) if (expiryDateNY(e) === p.date) return encodeInstrumentId(e, p.strikeRaw, p.isPut);
  throw new RangeError(`no opened expiry on ${p.date}`);
}
