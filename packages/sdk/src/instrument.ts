/**
 * Instrument ids of CashOptionMarketV2:
 *
 *   instrumentId = (expiry << 96) | (strike << 1) | (isPut ? 1 : 0)
 *
 * `expiry` is unix seconds (the 16:00 New York close), `strike` is USDG raw (1e6) per whole TOKEN (1e18 units, the
 * settlement source's unit), as in the contract (`EXPIRY_SHIFT = 96`, `MAX_STRIKE = 2^95 - 1`).
 *
 * Listed (per-share) strikes: the market lays its grid in listed per-share USD and stores each strike per token as
 * `k = round(shareStrike x M / 1e18)`, M being the token's `uiMultiplier` snapshotted when the expiry opened
 * (`expiryInfo(expiry).uiMultiplier`). With M = 1e18 the two coincide; with M != 1e18 (NVDA on mainnet:
 * 1.000775159164630595) the per-token strike is not a whole dollar, and names and labels show the per-share strike
 * `round(k x 1e18 / M)` instead (`shareStrikeOf`). `tokenStrikeOf` maps a per-share strike back.
 */

export const EXPIRY_SHIFT = 96n;
/** uiMultiplier 1.0 (1e18): per-token and per-share strikes coincide. */
export const UNIT_MULTIPLIER = 10n ** 18n;
export const MAX_STRIKE = (1n << 95n) - 1n;
export const MAX_EXPIRY = (1n << (256n - EXPIRY_SHIFT)) - 1n;

export interface Instrument {
  /** Unix seconds of the expiry (market close). */
  expiry: bigint;
  /** Strike in USDG raw (6 decimals) per whole token, as the contract stores it (see `shareStrikeOf`). */
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

/**
 * The listed per-share strike of a per-token strike under the expiry's snapshotted `uiMultiplier`:
 * `round(k x 1e18 / M)` (half up), the inverse of the grid's `round(shareStrike x M / 1e18)`.
 */
export function shareStrikeOf(tokenStrikeRaw: bigint, multiplier: bigint = UNIT_MULTIPLIER): bigint {
  if (multiplier <= 0n) throw new RangeError("uiMultiplier must be positive");
  if (multiplier === UNIT_MULTIPLIER) return tokenStrikeRaw;
  return (tokenStrikeRaw * UNIT_MULTIPLIER + multiplier / 2n) / multiplier;
}

/** The per-token strike the grid stores for a listed per-share strike: `round(shareStrike x M / 1e18)` (half up). */
export function tokenStrikeOf(shareStrikeRaw: bigint, multiplier: bigint = UNIT_MULTIPLIER): bigint {
  if (multiplier <= 0n) throw new RangeError("uiMultiplier must be positive");
  if (multiplier === UNIT_MULTIPLIER) return shareStrikeRaw;
  return (shareStrikeRaw * multiplier + UNIT_MULTIPLIER / 2n) / UNIT_MULTIPLIER;
}

/**
 * Human label such as "NVDA 2026-10-30 220 C". The strike shown is the listed per-share strike: pass the expiry's
 * snapshotted `uiMultiplier` (`ExpiryInfo.uiMultiplier`) when it is not 1e18.
 */
export function describeInstrument(id: bigint, underlying = "", multiplier: bigint = UNIT_MULTIPLIER): string {
  const { expiry, strike, isPut } = decodeInstrumentId(id);
  const date = new Date(Number(expiry) * 1000).toISOString().slice(0, 10);
  return `${underlying ? underlying + " " : ""}${date} ${strikeLabel(shareStrikeOf(strike, multiplier))} ${isPut ? "P" : "C"}`;
}

export interface GridParams {
  capBandBps: bigint;
  strikeStepBps: bigint;
  strikeTick: bigint;
  strikesPerSide: bigint;
}

/**
 * The strike grid an opening at `anchor` (per-token settlement raw) under the token's `multiplier` would fix,
 * mirroring `CashOptionMarketV2.gridFor(anchor, multiplier)`: caps per token, strikes laid in listed per-share USD
 * (`strikeTick` = the listed interval) and stored per token as `round(shareStrike x M / 1e18)`, kept strictly inside
 * the caps. Reproduces an expiry's strikes from its `ExpiryOpened` anchor and multiplier without an RPC call. The
 * two-argument form `gridFor(anchor, params)` assumes M = 1e18.
 */
export function gridFor(anchor: bigint, multiplier: bigint, params: GridParams): { capLow: bigint; capHigh: bigint; strikes: bigint[] };
export function gridFor(anchor: bigint, params: GridParams): { capLow: bigint; capHigh: bigint; strikes: bigint[] };
export function gridFor(anchor: bigint, a: bigint | GridParams, b?: GridParams): { capLow: bigint; capHigh: bigint; strikes: bigint[] } {
  const multiplier = typeof a === "bigint" ? a : UNIT_MULTIPLIER;
  const params = typeof a === "bigint" ? b! : a;
  const BPS = 10_000n;
  const capLow = (anchor * (BPS - params.capBandBps)) / BPS;
  const capHigh = (anchor * (BPS + params.capBandBps)) / BPS;
  if (capLow === 0n || anchor <= capLow || anchor >= capHigh || multiplier === 0n) throw new RangeError("invalid grid configuration");
  const share = (anchor * UNIT_MULTIPLIER) / multiplier;
  const tick = params.strikeTick;
  let step = (((share * params.strikeStepBps) / BPS + tick / 2n) / tick) * tick;
  if (step === 0n) step = tick;
  const centre = ((share + step / 2n) / step) * step;
  const n = params.strikesPerSide;
  const first = centre > n * step ? centre - n * step : 0n;
  const strikes: bigint[] = [];
  for (let s = first; s <= centre + n * step; s += step) {
    const k = (s * multiplier + UNIT_MULTIPLIER / 2n) / UNIT_MULTIPLIER;
    if (k > capLow && k < capHigh && (strikes.length === 0 || k > strikes[strikes.length - 1]!)) strikes.push(k);
  }
  return { capLow, capHigh, strikes };
}

// ---------------------------------------------------------------- backend instrument names
// The RFQ service names instruments `UNDERLYING-YYYYMMDD-STRIKE-C|P`: the New York calendar date of the expiry and the
// LISTED per-share strike in USD as Python's `f"{usd:g}"` prints it ("200", "202.5"). The per-share strike is the
// stored per-token strike divided by the expiry's snapshotted uiMultiplier (`shareStrikeOf`); with M = 1e18 it is the
// stored strike itself.

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

/**
 * `NVDA-20261030-220-C` for the per-token strike `strikeRaw` of an expiry whose snapshotted uiMultiplier is
 * `multiplier` (default 1e18): the name carries the listed per-share strike.
 */
export function instrumentName(underlying: string, expiry: bigint | number, strikeRaw: bigint, isPut: boolean, multiplier: bigint = UNIT_MULTIPLIER): string {
  return `${underlying.toUpperCase()}-${expiryDateNY(expiry)}-${strikeLabel(shareStrikeOf(strikeRaw, multiplier))}-${isPut ? "P" : "C"}`;
}

/** The backend name of a packed id, given the expiry's snapshotted uiMultiplier. */
export function instrumentNameOf(id: bigint, underlying: string, multiplier: bigint = UNIT_MULTIPLIER): string {
  const d = decodeInstrumentId(id);
  return instrumentName(underlying, d.expiry, d.strike, d.isPut, multiplier);
}

export const INSTRUMENT_NAME_RE = /^([A-Z]{1,8})-(\d{8})-(\d+(?:\.\d+)?)-([CP])$/;

/**
 * Parses `NVDA-20261030-220-C`. `shareStrikeRaw` is the listed per-share strike (USDG raw); the expiry is a date, so
 * the unix expiry and the per-token strike need the market's opened expiries (and their multipliers) to resolve.
 */
export function parseInstrumentName(text: string): { underlying: string; date: string; shareStrikeRaw: bigint; isPut: boolean } {
  const m = INSTRUMENT_NAME_RE.exec(text.trim().toUpperCase());
  if (!m) throw new RangeError(`instrument must look like NVDA-20261030-220-C, got ${text}`);
  const [whole, frac = ""] = m[3]!.split(".");
  if (frac.length > 6) throw new RangeError("strike has more than 6 decimals");
  const shareStrikeRaw = BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0");
  return { underlying: m[1]!, date: m[2]!, shareStrikeRaw, isPut: m[4] === "P" };
}

/** An opened expiry as name resolution needs it: the snapshotted multiplier and, when known, its per-token strikes. */
export interface ExpiryStrikes {
  expiry: bigint;
  uiMultiplier: bigint;
  strikes?: readonly bigint[];
}

/**
 * Resolves a backend instrument name to a packed id given the market's opened expiries: unix seconds (multiplier
 * 1e18 assumed) or `ExpiryStrikes`. With the expiry's strikes known, the per-share strike must match a listed strike
 * (`shareStrikeOf(k, M)`); a name carrying an exact per-token strike is accepted as well. Without strikes the per-token
 * strike is `tokenStrikeOf(shareStrike, M)`.
 */
export function resolveInstrumentName(text: string, expiries: Iterable<bigint | ExpiryStrikes>): bigint {
  const p = parseInstrumentName(text);
  for (const x of expiries) {
    const e: ExpiryStrikes = typeof x === "bigint" ? { expiry: x, uiMultiplier: UNIT_MULTIPLIER } : x;
    if (expiryDateNY(e.expiry) !== p.date) continue;
    if (!e.strikes) return encodeInstrumentId(e.expiry, tokenStrikeOf(p.shareStrikeRaw, e.uiMultiplier), p.isPut);
    const k = e.strikes.find((s) => shareStrikeOf(s, e.uiMultiplier) === p.shareStrikeRaw) ?? e.strikes.find((s) => s === p.shareStrikeRaw);
    if (k === undefined) {
      const listed = e.strikes.map((s) => strikeLabel(shareStrikeOf(s, e.uiMultiplier))).join(", ");
      throw new RangeError(`no strike ${strikeLabel(p.shareStrikeRaw)} on ${p.date} (listed per-share strikes: ${listed})`);
    }
    return encodeInstrumentId(e.expiry, k, p.isPut);
  }
  throw new RangeError(`no opened expiry on ${p.date}`);
}
