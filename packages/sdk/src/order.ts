import {
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import type { LocalAccount } from "viem/accounts";
import { expiryOf } from "./instrument.js";

/** Order side as the contract enumerates it. */
export const Side = { Bid: 0, Ask: 1 } as const;
export type Side = (typeof Side)[keyof typeof Side];

/** Session scopes of CashOptionMarketV2. */
export const SCOPE_TRADE = 1n;
export const SCOPE_CANCEL = 2n;

/**
 * The exact EIP-712 struct string of `CashOptionOrderBookV2.ORDER_TYPEHASH`. Any deviation (field order, a type name)
 * changes the digest, so this string is tested against the known typehash in test/order.test.ts.
 */
export const ORDER_TYPE_STRING =
  "Order(address maker,address signer,address taker,uint256 chainId,address settlement,address market,uint256 instrumentId,uint8 side,uint256 quantityRaw,uint256 minFillRaw,uint256 premiumStartRaw,uint256 premiumEndRaw,uint256 startTime,uint256 validUntil,uint256 stockMultiplier,uint256 nonce,bool fromBalance)";

export const ORDER_TYPEHASH: Hex = keccak256(toHex(ORDER_TYPE_STRING));

export const ORDER_TYPES = {
  Order: [
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "settlement", type: "address" },
    { name: "market", type: "address" },
    { name: "instrumentId", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "quantityRaw", type: "uint256" },
    { name: "minFillRaw", type: "uint256" },
    { name: "premiumStartRaw", type: "uint256" },
    { name: "premiumEndRaw", type: "uint256" },
    { name: "startTime", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "stockMultiplier", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "fromBalance", type: "bool" },
  ],
} as const;

export const ORDER_BOOK_EIP712 = { name: "CashOptionOrderBook", version: "2" } as const;

/** A V2 order, bigint fields, as signed and as passed to `fillOrderAs`. */
export interface Order {
  maker: Address;
  signer: Address;
  /** zero = anyone; an RFQ quote names the requesting account here. */
  taker: Address;
  chainId: bigint;
  /** The order book (EIP-712 verifying contract). */
  settlement: Address;
  market: Address;
  instrumentId: bigint;
  side: Side;
  /** 18-decimal shares. */
  quantityRaw: bigint;
  minFillRaw: bigint;
  /** Total premium for quantityRaw in USDG raw, fee-free, at/before startTime. */
  premiumStartRaw: bigint;
  /** Total premium at validUntil (equal to start = flat quote). */
  premiumEndRaw: bigint;
  startTime: bigint;
  validUntil: bigint;
  stockMultiplier: bigint;
  nonce: bigint;
  fromBalance: boolean;
}

/** Wire form of an order: every integer a decimal string, as the RFQ service returns it. */
export interface OrderJson {
  maker: string;
  signer: string;
  taker: string;
  chainId: string;
  settlement: string;
  market: string;
  instrumentId: string;
  side: number | "Bid" | "Ask";
  quantityRaw: string;
  minFillRaw: string;
  premiumStartRaw: string;
  premiumEndRaw: string;
  startTime: string;
  validUntil: string;
  stockMultiplier: string;
  nonce: string;
  fromBalance: boolean;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;

function asAddress(v: unknown, field: string): Address {
  if (typeof v !== "string" || !ADDRESS_RE.test(v)) throw new TypeError(`order.${field}: not an address`);
  return v as Address;
}
function asUint(v: unknown, field: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && UINT_RE.test(v)) return BigInt(v);
  throw new TypeError(`order.${field}: not an unsigned integer string`);
}

export function parseSide(v: unknown): Side {
  if (v === 0 || v === "0" || v === "Bid" || v === "bid") return Side.Bid;
  if (v === 1 || v === "1" || v === "Ask" || v === "ask") return Side.Ask;
  throw new TypeError("order.side: expected 0/Bid or 1/Ask");
}

/** Parses the wire form; throws on any malformed field. */
export function orderFromJson(j: OrderJson | Record<string, unknown>): Order {
  const o = j as Record<string, unknown>;
  return {
    maker: asAddress(o.maker, "maker"),
    signer: asAddress(o.signer, "signer"),
    taker: asAddress(o.taker, "taker"),
    chainId: asUint(o.chainId, "chainId"),
    settlement: asAddress(o.settlement, "settlement"),
    market: asAddress(o.market, "market"),
    instrumentId: asUint(o.instrumentId, "instrumentId"),
    side: parseSide(o.side),
    quantityRaw: asUint(o.quantityRaw, "quantityRaw"),
    minFillRaw: asUint(o.minFillRaw, "minFillRaw"),
    premiumStartRaw: asUint(o.premiumStartRaw, "premiumStartRaw"),
    premiumEndRaw: asUint(o.premiumEndRaw, "premiumEndRaw"),
    startTime: asUint(o.startTime, "startTime"),
    validUntil: asUint(o.validUntil, "validUntil"),
    stockMultiplier: asUint(o.stockMultiplier, "stockMultiplier"),
    nonce: asUint(o.nonce, "nonce"),
    fromBalance: o.fromBalance === true || o.fromBalance === "true",
  };
}

export function orderToJson(o: Order): OrderJson {
  return {
    maker: o.maker,
    signer: o.signer,
    taker: o.taker,
    chainId: o.chainId.toString(),
    settlement: o.settlement,
    market: o.market,
    instrumentId: o.instrumentId.toString(),
    side: o.side,
    quantityRaw: o.quantityRaw.toString(),
    minFillRaw: o.minFillRaw.toString(),
    premiumStartRaw: o.premiumStartRaw.toString(),
    premiumEndRaw: o.premiumEndRaw.toString(),
    startTime: o.startTime.toString(),
    validUntil: o.validUntil.toString(),
    stockMultiplier: o.stockMultiplier.toString(),
    nonce: o.nonce.toString(),
    fromBalance: o.fromBalance,
  };
}

/** The order as the ABI tuple `fillOrderAs` / `orderDigest` take (side as a number). */
export function orderToTuple(o: Order) {
  return {
    maker: o.maker,
    signer: o.signer,
    taker: o.taker,
    chainId: o.chainId,
    settlement: o.settlement,
    market: o.market,
    instrumentId: o.instrumentId,
    side: o.side,
    quantityRaw: o.quantityRaw,
    minFillRaw: o.minFillRaw,
    premiumStartRaw: o.premiumStartRaw,
    premiumEndRaw: o.premiumEndRaw,
    startTime: o.startTime,
    validUntil: o.validUntil,
    stockMultiplier: o.stockMultiplier,
    nonce: o.nonce,
    fromBalance: o.fromBalance,
  } as const;
}

/** EIP-712 domain of a CashOptionOrderBookV2 at `orderBook` on `chainId`. */
export function orderBookDomain(chainId: bigint | number, orderBook: Address): TypedDataDomain {
  return { ...ORDER_BOOK_EIP712, chainId: Number(chainId), verifyingContract: orderBook };
}

/** The typed data a wallet signs; `order.settlement` is the verifying contract. */
export function orderTypedData(order: Order) {
  return {
    domain: orderBookDomain(order.chainId, order.settlement),
    types: ORDER_TYPES,
    primaryType: "Order" as const,
    message: orderToTuple(order),
  };
}

/** `CashOptionOrderBookV2.orderDigest(order)`, computed locally. */
export function orderDigest(order: Order): Hex {
  return hashTypedData(orderTypedData(order));
}

/** Signs an order with a viem local account (an EOA session key or the owner). The account must be `order.signer`. */
export async function signOrder(account: LocalAccount, order: Order): Promise<Hex> {
  if (account.address.toLowerCase() !== order.signer.toLowerCase()) {
    throw new Error(`signOrder: account ${account.address} is not order.signer ${order.signer}`);
  }
  return account.signTypedData(orderTypedData(order));
}

/** Recovers the EOA that signed `order`; ERC-1271 signers need an on-chain `isValidOrderSignature` call instead. */
export async function recoverOrderSigner(order: Order, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...orderTypedData(order), signature });
}

/** True when `signature` is an EOA signature of `order` by `order.signer`. */
export async function verifyOrderSignature(order: Order, signature: Hex): Promise<boolean> {
  try {
    const who = await recoverOrderSigner(order, signature);
    return who.toLowerCase() === order.signer.toLowerCase();
  } catch {
    return false;
  }
}

function mulDiv(a: bigint, b: bigint, d: bigint, roundUp: boolean): bigint {
  const p = a * b;
  const q = p / d;
  return roundUp && p % d !== 0n ? q + 1n : q;
}

/**
 * `currentPremiumRaw(order)` at unix time `now`: premiumStartRaw up to startTime, premiumEndRaw at validUntil,
 * linear in between, rounded in the maker's favour (an ask rounds a rise up and a fall down; a bid the opposite).
 */
export function currentPremiumRaw(order: Order, now: bigint | number): bigint {
  const t = BigInt(now);
  const { premiumStartRaw: start, premiumEndRaw: end } = order;
  if (start === end || t <= order.startTime) return start;
  if (t >= order.validUntil) return end;
  const elapsed = t - order.startTime;
  const duration = order.validUntil - order.startTime;
  const rising = end > start;
  const span = rising ? end - start : start - end;
  const roundUp = (order.side === Side.Ask) === rising;
  const moved = mulDiv(span, elapsed, duration, roundUp);
  return rising ? start + moved : start - moved;
}

/** `premiumFor(order, fillQuantityRaw)` at `now`: pro rata, rounded up. */
export function premiumFor(order: Order, fillQuantityRaw: bigint, now: bigint | number): bigint {
  if (fillQuantityRaw <= 0n || fillQuantityRaw > order.quantityRaw) throw new RangeError("invalid fill quantity");
  return mulDiv(currentPremiumRaw(order, now), fillQuantityRaw, order.quantityRaw, true);
}

/** `takerFeeFor(premium)`: protocolFeeBps of it, rounded up. */
export function takerFeeFor(premium: bigint, protocolFeeBps: bigint | number): bigint {
  return mulDiv(premium, BigInt(protocolFeeBps), 10_000n, true);
}

/** What the taker pays (ask lifted) or receives (bid hit) for a fill, fee included. */
export function takerCashflow(
  order: Order,
  fillQuantityRaw: bigint,
  protocolFeeBps: bigint | number,
  now: bigint | number,
): { premium: bigint; fee: bigint; /** positive = taker pays, negative = taker receives */ net: bigint } {
  const premium = premiumFor(order, fillQuantityRaw, now);
  const fee = takerFeeFor(premium, protocolFeeBps);
  return { premium, fee, net: order.side === Side.Ask ? premium + fee : -(premium - fee) };
}

/** Static checks the book makes before a signature is even looked at; returns the reasons, empty when fine. */
export function orderProblems(order: Order, expect?: { chainId?: bigint | number; orderBook?: Address; market?: Address; taker?: Address; now?: bigint | number }): string[] {
  const out: string[] = [];
  const zero = "0x0000000000000000000000000000000000000000";
  if (order.maker === zero || order.signer === zero) out.push("maker/signer is zero");
  if (order.quantityRaw === 0n) out.push("quantityRaw is zero");
  if (order.premiumStartRaw === 0n || order.premiumEndRaw === 0n) out.push("premium is zero");
  if (order.premiumStartRaw !== order.premiumEndRaw && order.startTime >= order.validUntil) out.push("decay window invalid (startTime >= validUntil)");
  if (order.minFillRaw > order.quantityRaw) out.push("minFillRaw > quantityRaw");
  if (order.stockMultiplier === 0n) out.push("stockMultiplier is zero");
  if (order.validUntil > expiryOf(order.instrumentId)) out.push("validUntil after the instrument's expiry");
  if (expect?.chainId !== undefined && order.chainId !== BigInt(expect.chainId)) out.push(`chainId ${order.chainId} != ${expect.chainId}`);
  if (expect?.orderBook && order.settlement.toLowerCase() !== expect.orderBook.toLowerCase()) out.push("settlement is not the expected order book");
  if (expect?.market && order.market.toLowerCase() !== expect.market.toLowerCase()) out.push("market is not the expected market");
  if (expect?.taker && order.taker !== zero && order.taker.toLowerCase() !== expect.taker.toLowerCase()) out.push(`taker ${order.taker} is not ${expect.taker}`);
  if (expect?.now !== undefined && BigInt(expect.now) >= order.validUntil) out.push("order expired (validUntil passed)");
  return out;
}
