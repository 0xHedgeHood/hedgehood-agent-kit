import { currentPremiumRaw, Side, takerFeeFor, type Order } from "./order.js";
import { formatShares, WHOLE_SHARE } from "./units.js";

/**
 * Session budgets of `CashOptionMarketV2` (hedgehood-options PR #58). A TRADE session key draws on two budgets, both
 * cumulative over the session's life and only ever decreasing (re-authorizing resets them):
 *
 * - **short risk** (`riskLeft`, authorized as `maxShortRisk`): every sell leg the key signs or takes is charged the
 *   worst case of the shorts it opens, `ceil(openedShort x maxPayout / 1e18)`, where `openedShort = max(0, qty -
 *   max(0, positionBefore))` (selling a long the account holds is free) and `maxPayout = capHigh - strike` for a call,
 *   `strike - capLow` for a put (per-token strike and caps, USDG raw per 1e18 token units);
 * - **spend** (`spendLeft`, authorized as `maxSpend`): every buy leg is charged its premium + fee less the worst case
 *   of the shorts it closes, `max(0, paid - floor(closedShort x maxPayout / 1e18))`, `closedShort = min(qty,
 *   max(0, -positionBefore))`; buying a long is charged in full, buying back a short at no more than its worst case
 *   is free.
 *
 * A charge above what is left reverts the whole fill with `SessionLimit`. 0 = the key cannot open shorts / may only
 * buy to close; `UNLIMITED` (`type(uint256).max`) is still decremented by each charge but cannot run out.
 */

/** Budgets at or above 2^128 USDG raw are unreachable in practice: what is left of an `UNLIMITED` grant. */
export const EFFECTIVELY_UNLIMITED = 1n << 128n;

const ceilDiv = (a: bigint, d: bigint) => (a + d - 1n) / d;

/** Worst-case payout (USDG raw) of one short whole token: `capHigh - strike` (call) or `strike - capLow` (put). */
export function maxPayoutPerToken(strike: bigint, isPut: boolean, caps: { capLow: bigint; capHigh: bigint }): bigint {
  const v = isPut ? strike - caps.capLow : caps.capHigh - strike;
  if (v <= 0n) throw new RangeError(`strike ${strike} is not strictly inside the caps [${caps.capLow}, ${caps.capHigh}]`);
  return v;
}

/** Shares of a sell leg beyond the long held: the short it opens (`max(0, qty - max(0, positionBefore))`). */
export function openedShortOf(quantityRaw: bigint, positionBeforeRaw: bigint): bigint {
  const held = positionBeforeRaw > 0n ? positionBeforeRaw : 0n;
  return quantityRaw > held ? quantityRaw - held : 0n;
}

/** Shares of a buy leg that close a short held (`min(qty, max(0, -positionBefore))`). */
export function closedShortOf(quantityRaw: bigint, positionBeforeRaw: bigint): bigint {
  const short = positionBeforeRaw < 0n ? -positionBeforeRaw : 0n;
  return quantityRaw < short ? quantityRaw : short;
}

/** Short-risk charge of a session sell leg: `ceil(openedShort x maxPayout / 1e18)`; 0 when it only sells a long. */
export function shortRiskCharge(quantityRaw: bigint, positionBeforeRaw: bigint, maxPayoutRaw: bigint): bigint {
  return ceilDiv(openedShortOf(quantityRaw, positionBeforeRaw) * maxPayoutRaw, WHOLE_SHARE);
}

/** Spend charge of a session buy leg paying `paidRaw` (premium + fee): `max(0, paid - floor(closedShort x maxPayout / 1e18))`. */
export function spendCharge(quantityRaw: bigint, positionBeforeRaw: bigint, maxPayoutRaw: bigint, paidRaw: bigint): bigint {
  const closesWorst = (closedShortOf(quantityRaw, positionBeforeRaw) * maxPayoutRaw) / WHOLE_SHARE;
  return paidRaw > closesWorst ? paidRaw - closesWorst : 0n;
}

/** One leg the session key is about to sign or take for the account. */
export interface SessionLeg {
  /** The account's side of the leg. */
  side: "buy" | "sell";
  /** Shares (1e18). */
  quantityRaw: bigint;
  /** The account's signed position in the instrument before the fill. */
  positionBeforeRaw: bigint;
  /** `maxPayoutPerToken` of the instrument. */
  maxPayoutRaw: bigint;
  /** Buy legs: premium + fee the account pays (USDG raw). Ignored for sells. */
  paidRaw?: bigint;
}

export interface SessionCharge {
  side: "buy" | "sell";
  /** The budget the leg draws on: sells `shortRisk` (riskLeft), buys `spend` (spendLeft). */
  budget: "shortRisk" | "spend";
  quantityRaw: bigint;
  positionBeforeRaw: bigint;
  maxPayoutRaw: bigint;
  /** Sells: shares beyond the long held (the short opened). */
  openedShortRaw: bigint;
  /** Buys: shares that close a short held. */
  closedShortRaw: bigint;
  /** Buys: what was assumed paid (premium + fee). */
  paidRaw?: bigint;
  /** What the market will draw from `budget`. */
  chargeRaw: bigint;
  /** What is left of `budget` before the fill, when the session was read. */
  leftRaw?: bigint;
  /** chargeRaw <= leftRaw; undefined when the session was not read. */
  withinBudget?: boolean;
}

/** The charge of one session leg, and (with the session's budgets) whether it fits or will revert `SessionLimit`. */
export function sessionChargeOf(leg: SessionLeg, budgets?: { riskLeft: bigint; spendLeft: bigint }): SessionCharge {
  if (leg.quantityRaw <= 0n) throw new RangeError("quantity must be positive");
  const sell = leg.side === "sell";
  if (!sell && leg.paidRaw === undefined) throw new Error("a buy leg needs paidRaw (premium + fee) to price its spend charge");
  const chargeRaw = sell
    ? shortRiskCharge(leg.quantityRaw, leg.positionBeforeRaw, leg.maxPayoutRaw)
    : spendCharge(leg.quantityRaw, leg.positionBeforeRaw, leg.maxPayoutRaw, leg.paidRaw!);
  const leftRaw = budgets === undefined ? undefined : sell ? budgets.riskLeft : budgets.spendLeft;
  return {
    side: leg.side,
    budget: sell ? "shortRisk" : "spend",
    quantityRaw: leg.quantityRaw,
    positionBeforeRaw: leg.positionBeforeRaw,
    maxPayoutRaw: leg.maxPayoutRaw,
    openedShortRaw: sell ? openedShortOf(leg.quantityRaw, leg.positionBeforeRaw) : 0n,
    closedShortRaw: sell ? 0n : closedShortOf(leg.quantityRaw, leg.positionBeforeRaw),
    paidRaw: sell ? undefined : leg.paidRaw,
    chargeRaw,
    leftRaw,
    withinBudget: leftRaw === undefined ? undefined : chargeRaw <= leftRaw,
  };
}

/**
 * The most a taker buying `fillQuantityRaw` of an ask can be made to pay (premium + fee) from now until the quote's
 * `validUntil`: the premium moves linearly between its start and end, so the larger endpoint bounds it. A bid (the
 * taker sells) pays nothing: 0.
 */
export function maxPaidUntilExpiry(order: Order, fillQuantityRaw: bigint, protocolFeeBps: bigint | number, now: bigint | number): bigint {
  if (order.side !== Side.Ask) return 0n;
  const at = (t: bigint | number) => {
    const p = currentPremiumRaw(order, t);
    const pro = (p * fillQuantityRaw + order.quantityRaw - 1n) / order.quantityRaw; // an ask rounds up, as premiumFor
    return pro + takerFeeFor(pro, protocolFeeBps);
  };
  const a = at(now);
  const b = at(order.validUntil);
  return a > b ? a : b;
}

const BUDGET_NAME = { shortRisk: "short-risk budget (riskLeft, authorized as maxShortRisk)", spend: "spend budget (spendLeft, authorized as maxSpend)" } as const;

/** A session cap for display: "unlimited" (also what is left of an UNLIMITED grant), "none (0)" or the USDG amount. */
export function formatSessionCap(raw: bigint): string {
  if (raw >= EFFECTIVELY_UNLIMITED) return "unlimited";
  if (raw === 0n) return "none (0)";
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** One line: what the leg draws from which budget, and whether it fits. */
export function describeSessionCharge(c: SessionCharge): string {
  const what =
    c.side === "sell"
      ? c.openedShortRaw === 0n
        ? "sells a long the account holds: free"
        : `opens a short of ${formatShares(c.openedShortRaw)} sh (worst case ${formatSessionCap(c.maxPayoutRaw)}/token)`
      : c.closedShortRaw === 0n
        ? "buys to open: charged premium + fee in full"
        : `closes a short of ${formatShares(c.closedShortRaw)} sh (free up to its worst case)`;
  const charge = `${c.chargeRaw === 0n ? "0" : formatSessionCap(c.chargeRaw)} USDG from the ${c.budget === "shortRisk" ? "short-risk budget" : "spend budget"}`;
  const left = c.leftRaw === undefined ? "" : `; left ${formatSessionCap(c.leftRaw)}${c.withinBudget ? "" : " -> the fill will revert SessionLimit"}`;
  return `session charge: ${charge} (${what})${left}`;
}

/** Why a planned leg hit (or will hit) `SessionLimit`: which budget, how much it needs and how much is left. */
export function sessionLimitDetail(c: SessionCharge): string {
  const flag = c.budget === "shortRisk" ? "--max-short-risk / maxShortRisk" : "--max-spend / maxSpend";
  return `this ${c.side} leg draws ${formatSessionCap(c.chargeRaw)} USDG from the ${BUDGET_NAME[c.budget]}${c.leftRaw === undefined ? "" : `, ${formatSessionCap(c.leftRaw)} left`}; trade a smaller size, or the owner re-authorizes with a larger ${flag}`;
}
