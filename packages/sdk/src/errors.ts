import { decodeErrorResult, type Hex } from "viem";
import { marketV2Abi } from "./abi/cashOptionMarketV2.js";
import { orderBookV2Abi } from "./abi/cashOptionOrderBookV2.js";

/** What an agent should do about a market / order book revert, by custom error name. */
export const MARKET_ERROR_HINTS: Record<string, string> = {
  SessionWalletMode:
    "a leg signed or taken by a session key must settle from the account's deposited balance (fromBalance = true); the market never lets a session key pull from or pay to the account's wallet. Fill with fromBalance true (the kit's default), or sign with the account key itself for wallet mode.",
  SessionLimit:
    "the session's limits would be exceeded: either the premium + fee is more than the session's remaining spend budget (spendLeft; 0 = the key may not buy), or the trade would raise the account's collateral requirement above the session's maxRequirement (0 = no new requirement). Check `session status`; the owner re-authorizes the key with a larger --max-spend / --max-requirement (re-authorizing resets the budget and voids orders the key signed before).",
  NotAuthorized: "the signing key holds no live session with SCOPE_TRADE for this account (expired, revoked or never authorized).",
  NotAuthorizedSigner:
    "the order's signer is not the maker and holds no live TRADE session for it, or the order's startTime is earlier than the session's authorizedAt (orders signed before a re-authorization stay void). Ask for a fresh quote.",
  InvalidSignature: "the quote's signature does not verify against order.signer; ask for a fresh quote.",
  InsufficientCollateral: "the account's deposited balance does not cover the premium, fee or new requirement; deposit more USDG first.",
  StockMultiplierChanged:
    "the token's uiMultiplier moved beyond MULTIPLIER_TOLERANCE_BPS (1%) of the expiry's snapshot (a split): that expiry no longer trades and settles through the owner.",
  StockControlsPaused: "the stock token's oracle is paused; trading and settlement of this market are halted.",
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

const ERROR_ABI = [...marketV2Abi, ...orderBookV2Abi].filter((x) => x.type === "error");

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
