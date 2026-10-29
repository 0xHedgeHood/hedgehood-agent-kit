import { encodeFunctionData, type Address, type Hex } from "viem";
import { marketV2Abi } from "./abi/cashOptionMarketV2.js";
import { orderBookV2Abi } from "./abi/cashOptionOrderBookV2.js";
import { erc20Abi } from "./abi/erc20.js";
import { orderToTuple, type Order } from "./order.js";

/** An unsigned transaction request: what every write helper produces before anything is signed. */
export interface TxRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  /** Human description for dry-run output and confirmations. */
  summary: string;
}

// ---------------------------------------------------------------- order book

/** `fillOrderAs(account, order, signature, fillQuantityRaw, fromBalance)`: the agent's trade call. */
export function encodeFillOrderAs(
  orderBook: Address,
  account: Address,
  order: Order,
  signature: Hex,
  fillQuantityRaw: bigint,
  fromBalance = true,
): TxRequest {
  return {
    to: orderBook,
    data: encodeFunctionData({
      abi: orderBookV2Abi,
      functionName: "fillOrderAs",
      args: [account, orderToTuple(order), signature, fillQuantityRaw, fromBalance],
    }),
    summary: `fillOrderAs(${account}, instrument ${order.instrumentId}, qty ${fillQuantityRaw}, fromBalance=${fromBalance})`,
  };
}

/** `fillOrder(order, signature, fillQuantityRaw)`: wallet mode, msg.sender is the taker. */
export function encodeFillOrder(orderBook: Address, order: Order, signature: Hex, fillQuantityRaw: bigint): TxRequest {
  return {
    to: orderBook,
    data: encodeFunctionData({ abi: orderBookV2Abi, functionName: "fillOrder", args: [orderToTuple(order), signature, fillQuantityRaw] }),
    summary: `fillOrder(instrument ${order.instrumentId}, qty ${fillQuantityRaw})`,
  };
}

export function encodeCancelOrder(orderBook: Address, nonce: bigint): TxRequest {
  return { to: orderBook, data: encodeFunctionData({ abi: orderBookV2Abi, functionName: "cancelOrder", args: [nonce] }), summary: `cancelOrder(${nonce})` };
}

export function encodeCancelOrderFor(orderBook: Address, account: Address, nonce: bigint): TxRequest {
  return { to: orderBook, data: encodeFunctionData({ abi: orderBookV2Abi, functionName: "cancelOrderFor", args: [account, nonce] }), summary: `cancelOrderFor(${account}, ${nonce})` };
}

/** `invalidateNonces(slot, mask)`: one bit per nonce in slot `nonce >> 8`. */
export function encodeInvalidateNonces(orderBook: Address, slot: bigint, mask: bigint): TxRequest {
  return { to: orderBook, data: encodeFunctionData({ abi: orderBookV2Abi, functionName: "invalidateNonces", args: [slot, mask] }), summary: `invalidateNonces(slot ${slot}, mask 0x${mask.toString(16)})` };
}

/** The (slot, mask) that voids every nonce in `nonces` of one slot. */
export function nonceMask(nonces: bigint[]): { slot: bigint; mask: bigint } {
  if (nonces.length === 0) throw new RangeError("no nonces");
  const slot = nonces[0]! >> 8n;
  let mask = 0n;
  for (const n of nonces) {
    if (n >> 8n !== slot) throw new RangeError("nonces span several slots; call once per slot");
    mask |= 1n << (n & 0xffn);
  }
  return { slot, mask };
}

// ---------------------------------------------------------------- market

export function encodeDeposit(market: Address, account: Address, amountRaw: bigint): TxRequest {
  return { to: market, data: encodeFunctionData({ abi: marketV2Abi, functionName: "deposit", args: [account, amountRaw] }), summary: `deposit(${account}, ${amountRaw} USDG raw)` };
}

/** Owner only: a session key cannot withdraw. */
export function encodeWithdraw(market: Address, amountRaw: bigint, to: Address): TxRequest {
  return { to: market, data: encodeFunctionData({ abi: marketV2Abi, functionName: "withdraw", args: [amountRaw, to] }), summary: `withdraw(${amountRaw} USDG raw, to ${to})` };
}

const MAX_UINT256 = (1n << 256n) - 1n;
const capText = (v: bigint) => (v === MAX_UINT256 ? "unlimited" : v.toString());

/**
 * `authorizeSession(key, expiresAt, scope, maxShortRisk, maxSpend)`; sent by the account (owner key). Both are
 * cumulative budgets over the session (USDG raw): `maxShortRisk` the worst case of the shorts the key opens (0: it
 * cannot sell to open), `maxSpend` the premium + fee it pays as buyer beyond the worst case of the shorts it closes
 * (0: it may only buy to close); `type(uint256).max` means unlimited. See `session.ts` for the charges.
 */
export function encodeAuthorizeSession(market: Address, key: Address, expiresAt: bigint | number, scope: bigint, maxShortRisk: bigint, maxSpend: bigint): TxRequest {
  return {
    to: market,
    data: encodeFunctionData({ abi: marketV2Abi, functionName: "authorizeSession", args: [key, BigInt(expiresAt), scope, maxShortRisk, maxSpend] }),
    summary: `authorizeSession(${key}, until ${expiresAt}, scope ${scope}, maxShortRisk ${capText(maxShortRisk)}, maxSpend ${capText(maxSpend)})`,
  };
}

export function encodeRevokeSession(market: Address, key: Address): TxRequest {
  return { to: market, data: encodeFunctionData({ abi: marketV2Abi, functionName: "revokeSession", args: [key] }), summary: `revokeSession(${key})` };
}

export function encodeRedeem(market: Address, expiry: bigint): TxRequest {
  return { to: market, data: encodeFunctionData({ abi: marketV2Abi, functionName: "redeem", args: [expiry] }), summary: `redeem(${expiry})` };
}

export function encodeRedeemFor(market: Address, account: Address, expiry: bigint): TxRequest {
  return { to: market, data: encodeFunctionData({ abi: marketV2Abi, functionName: "redeemFor", args: [account, expiry] }), summary: `redeemFor(${account}, ${expiry})` };
}

/** `settle(expiry, hint)`; `hint` is `abi.encode(stockRoundId, quoteRoundId)` for a ChainlinkExpirySource. */
export function encodeSettle(market: Address, expiry: bigint, hint: Hex = "0x"): TxRequest {
  return { to: market, data: encodeFunctionData({ abi: marketV2Abi, functionName: "settle", args: [expiry, hint] }), summary: `settle(${expiry})` };
}

export function encodeOpenExpiry(market: Address, expiry: bigint): TxRequest {
  return { to: market, data: encodeFunctionData({ abi: marketV2Abi, functionName: "openExpiry", args: [expiry] }), summary: `openExpiry(${expiry})` };
}

// ---------------------------------------------------------------- erc20

/** Wallet-mode only: `deposit` pulls from msg.sender, so the depositor approves the market first. */
export function encodeApprove(token: Address, spender: Address, amountRaw: bigint): TxRequest {
  return { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amountRaw] }), summary: `approve(${spender}, ${amountRaw})` };
}
