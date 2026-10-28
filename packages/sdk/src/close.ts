import type { Address } from "viem";
import type { TxRequest } from "./calldata.js";
import { expiryOf, instrumentNameOf } from "./instrument.js";
import type { MarketClient, Position, SendResult } from "./market.js";
import type { RfqClient, VerifiedQuote } from "./rfq.js";
import type { SessionCharge } from "./session.js";

/**
 * Closing a position before expiry. Positions are signed and net out on chain, and the maker quotes both sides of
 * every instrument, so an exit is a fill of the opposite side of the same instrument: a long is closed by selling to the
 * maker's bid, a short by buying its ask. `planClose` reads the account's on-chain position, picks the side, asks the
 * desk for a quote of min(|position|, quantity) and builds the same `fillOrderAs(account, ..., fromBalance)` the fill
 * path uses; `closePosition` sends it through `MarketClient.send` (dry run unless told otherwise).
 *
 * Filled by a session key, a close is normally free of both session budgets: selling a long held does not draw the
 * short-risk budget, and buying back a short draws the spend budget only for what it pays above the short's worst
 * case. The plan carries that charge (`sessionCharge`, with `withinBudget`) so a caller knows before sending whether
 * the fill would hit `SessionLimit`.
 */
export interface CloseRequest {
  /** Carries the chain, the deployment, the account and the signing key (the session key, as for a fill). */
  market: MarketClient;
  rfq: RfqClient;
  instrumentId: bigint;
  /** Shares to close (1e18); default and upper bound: the whole position. */
  quantityRaw?: bigint;
  /**
   * Settle premium, fee and collateral inside the deposited balance (default true, as the fill path). A session key
   * must keep it true (the market reverts `SessionWalletMode`); false is only for a signer that is the account itself.
   */
  fromBalance?: boolean;
  /** The session key that will send the fill: the desk's SessionLimit preview, and the plan's `sessionCharge`. */
  sessionKey?: Address;
  /** The book's taker fee, if already read; otherwise read on chain. */
  protocolFeeBps?: bigint | number;
  /** Account whose position is closed; default: the market client's account. */
  account?: Address;
}

export interface ClosePlan {
  account: Address;
  instrumentId: bigint;
  instrument: string;
  position: Position;
  /** The taker side of the closing fill: `sell` closes a long, `buy` closes a short. */
  side: "buy" | "sell";
  /** Shares the plan closes (<= |position|). */
  quantityRaw: bigint;
  /** Signed position left after the fill. */
  remainingRaw: bigint;
  quote: VerifiedQuote;
  request: TxRequest;
  /** With a session key: what the fill draws from the session's budgets and whether it fits (else `SessionLimit`). */
  sessionCharge?: SessionCharge;
}

export interface CloseResult extends ClosePlan {
  result: SendResult;
}

/** The account's signed on-chain position in one instrument (0 when none). */
export async function positionOf(market: MarketClient, instrumentId: bigint, account?: Address): Promise<Position | undefined> {
  const snap = await market.snapshot(account);
  return snap.positions.find((p) => p.instrumentId === instrumentId);
}

/** Reads the position, picks the opposite side, quotes min(|position|, quantity) and builds the closing fill. Sends nothing. */
export async function planClose(req: CloseRequest): Promise<ClosePlan> {
  const { market, rfq } = req;
  const account = req.account ?? market.account;
  if (!account) throw new Error("no account configured (pass `account` or a signer)");
  const underlying = market.deployment.underlying;
  const position = await positionOf(market, req.instrumentId, account);
  const uiMultiplier = position?.uiMultiplier ?? (await market.expiryMultiplier(expiryOf(req.instrumentId)));
  const name = instrumentNameOf(req.instrumentId, underlying, uiMultiplier);
  if (!position || position.quantityRaw === 0n) throw new Error(`no open position in ${name} for ${account}; nothing to close`);
  const size = position.quantityRaw < 0n ? -position.quantityRaw : position.quantityRaw;
  if (req.quantityRaw !== undefined && req.quantityRaw <= 0n) throw new RangeError("quantity to close must be positive");
  const quantityRaw = req.quantityRaw === undefined || req.quantityRaw > size ? size : req.quantityRaw;
  const side: "buy" | "sell" = position.quantityRaw > 0n ? "sell" : "buy";
  const protocolFeeBps = req.protocolFeeBps ?? (await market.protocolFeeBps());
  const quote = await rfq.getQuote(
    { chainId: market.chainId, market: market.market, instrumentId: req.instrumentId, side, quantityRaw, taker: account, sessionKey: req.sessionKey, underlying, uiMultiplier },
    { orderBook: market.orderBook, protocolFeeBps },
  );
  const request = market.fillOrderAs(quote.order, quote.signature, quantityRaw, req.fromBalance ?? true, account);
  const remainingRaw = side === "sell" ? position.quantityRaw - quantityRaw : position.quantityRaw + quantityRaw;
  // best effort: a failed read leaves the charge out rather than blocking the exit (the simulation still checks it)
  const sessionCharge = req.sessionKey
    ? await market.sessionCharge({ instrumentId: req.instrumentId, side, quantityRaw, order: quote.order, protocolFeeBps, key: req.sessionKey, account, positionBeforeRaw: position.quantityRaw }).catch(() => undefined)
    : undefined;
  return { account, instrumentId: req.instrumentId, instrument: quote.instrument, position, side, quantityRaw, remainingRaw, quote, request, sessionCharge };
}

/**
 * Plans the close and fills it like `fillOrderAs` from the market client's signer: simulated and returned unsigned
 * unless `dryRun: false`. A backend dry-run quote (placeholder signature) is refused, as in the fill path.
 */
export async function closePosition(req: CloseRequest & { dryRun?: boolean }): Promise<CloseResult> {
  const plan = await planClose(req);
  if (!plan.quote.fillable) throw new Error("backend dry-run quote (placeholder signature): nothing to fill");
  const result = await req.market.send(plan.request, { dryRun: req.dryRun ?? true, sessionCharge: plan.sessionCharge });
  return { ...plan, result };
}
