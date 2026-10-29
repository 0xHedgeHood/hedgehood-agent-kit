import { decodeErrorResult, type Hex } from "viem";
import { marketV2Abi } from "./abi/cashOptionMarketV2.js";
import { orderBookV2Abi } from "./abi/cashOptionOrderBookV2.js";
import { chainlinkExpirySourceAbi } from "./abi/chainlinkExpirySource.js";

/** What an agent should do about a market / order book revert, by custom error name. */
export const MARKET_ERROR_HINTS: Record<string, string> = {
  SessionWalletMode:
    "a leg signed or taken by a session key must settle from the account's deposited balance (fromBalance = true); the market never lets a session key pull from or pay to the account's wallet. Fill with fromBalance true (the kit's default), or sign with the account key itself for wallet mode.",
  SessionLimit:
    "a session budget is exhausted. A SELL leg draws the short-risk budget (riskLeft): ceil(opened short x maxPayout / 1e18), opened short = shares beyond the long held, maxPayout = capHigh - strike (call) or strike - capLow (put) per token; 0 = the key cannot sell to open, selling a long held is free. A BUY leg draws the spend budget (spendLeft): premium + fee less the worst case of the shorts it buys back; 0 = buy to close only. Check `session status` (riskLeft, spendLeft); trade a smaller size, or the owner re-authorizes with a larger --max-short-risk / --max-spend (re-authorizing resets both budgets and voids orders the key signed before).",
  NotAuthorized: "the signing key holds no live session with SCOPE_TRADE for this account (expired, revoked or never authorized).",
  NotAuthorizedSigner:
    "the order's signer is not the maker and holds no live TRADE session for it, or the order's startTime is earlier than the session's authorizedAt (orders signed before a re-authorization stay void). Ask for a fresh quote.",
  InvalidSignature: "the quote's signature does not verify against order.signer; ask for a fresh quote.",
  InsufficientCollateral: "the account's deposited balance does not cover the premium, fee or new requirement; deposit more USDG first.",
  StockMultiplierChanged:
    "the token's uiMultiplier moved beyond MULTIPLIER_TOLERANCE_BPS (1%) of the expiry's snapshot (a split): that expiry no longer trades and settles through the owner.",
  StockControlsPaused:
    "the stock token's oracle is paused, or its controls (oraclePaused / uiMultiplier) cannot be read (a token upgrade removed or broke them): trading, opening expiries and settle are halted until they read again; an expiry stuck there settles through the owner (settleWithPrice) or settleLate.",
  InvalidRoundHint:
    "the settlement round hint is not the round in effect at the expiry (a round after it, a round whose successor is at or before it, or beyond the latest round), or settleLate / failingAt walked back to a Chainlink aggregator phase boundary with an empty hint: pass hint = abi.encode(stockRoundId, quoteRoundId) of the rounds in effect at the expiry (in the earlier phase).",
  OracleUnavailable: "the settlement source has no healthy price for that time (feed unhealthy, or the USDG quote outside its band); settle later, or the expiry settles through the owner fallback.",
  RoundWalkExhausted: "the walk back from the latest round did not reach the expiry within MAX_ROUND_WALK rounds: pass a round hint, abi.encode(stockRoundId, quoteRoundId).",
  TradingUnavailable:
    "trading on this expiry is closed (it closes tradingCloseBefore the expiry, or the stock is paused), or the quote was written under another uiMultiplier than the live one (quotes are re-signed after a dividend adjustment); ask for a fresh quote.",
  WrongTaker: "the quote is addressed to another account.",
  OrderUnavailable: "the quote's nonce was cancelled or the order is fully filled; ask for a fresh quote.",
  OrderExpired: "the quote expired (validUntil passed); ask for a fresh quote.",
  InvalidFill: "the fill quantity is zero, above what is left of the order, or below its minimum fill.",
  WrongTime: "not allowed yet: settlement opens the second after the expiry; settleLate 90 days after it.",
};

export interface DecodedMarketError {
  errorName: string;
  args: readonly unknown[];
  /** What to do about it, when the kit knows. */
  hint?: string;
}

const ERROR_ABI = [...marketV2Abi, ...orderBookV2Abi, ...chainlinkExpirySourceAbi].filter((x) => x.type === "error");

function revertDataOf(e: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as { data?: unknown; cause?: unknown };
    const d = typeof o.data === "object" && o.data !== null ? (o.data as { data?: unknown }).data : o.data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8}/.test(d)) return d as Hex;
    cur = o.cause;
  }
  return undefined;
}

/**
 * Decodes a market or order book custom error from a viem error (or any error whose `data` / `cause` chain carries
 * the revert data), with a hint for the ones an agent can act on. Undefined when there is no decodable revert data;
 * a node that only returns the message (`execution reverted: SessionLimit()`) is matched by name as a fallback.
 */
export function decodeMarketError(e: unknown): DecodedMarketError | undefined {
  const data = revertDataOf(e);
  if (data) {
    try {
      const d = decodeErrorResult({ abi: ERROR_ABI, data });
      return { errorName: d.errorName, args: (d.args ?? []) as readonly unknown[], hint: MARKET_ERROR_HINTS[d.errorName] };
    } catch {
      /* not one of ours */
    }
  }
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  for (const name of Object.keys(MARKET_ERROR_HINTS)) {
    if (new RegExp(`\\b${name}\\b`).test(msg)) return { errorName: name, args: [], hint: MARKET_ERROR_HINTS[name] };
  }
  return undefined;
}

/** A simulated or sent market / book call reverted with a known custom error. */
export class MarketRevertError extends Error {
  readonly errorName: string;
  readonly args: readonly unknown[];
  readonly hint?: string;
  constructor(summary: string, decoded: DecodedMarketError, cause: unknown) {
    super(`${summary} reverted ${decoded.errorName}${decoded.hint ? `: ${decoded.hint}` : ""}`, { cause });
    this.name = "MarketRevertError";
    this.errorName = decoded.errorName;
    this.args = decoded.args;
    this.hint = decoded.hint;
  }
}
