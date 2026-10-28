import {
  createPublicClient,
  http,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import type { LocalAccount } from "viem/accounts";
import { createWalletClient } from "viem";
import { marketV2Abi } from "./abi/cashOptionMarketV2.js";
import { orderBookV2Abi } from "./abi/cashOptionOrderBookV2.js";
import { erc20Abi } from "./abi/erc20.js";
import {
  encodeApprove,
  encodeAuthorizeSession,
  encodeDeposit,
  encodeFillOrderAs,
  encodeRedeem,
  encodeRedeemFor,
  encodeRevokeSession,
  encodeSettle,
  encodeWithdraw,
  type TxRequest,
} from "./calldata.js";
import { chains, getDeployment, getMarket, type MarketDeployment } from "./chains.js";
import { decodeInstrumentId, encodeInstrumentId } from "./instrument.js";
import { orderToTuple, SCOPE_CANCEL, SCOPE_TRADE, type Order } from "./order.js";

export interface MarketClientOptions {
  chainId: number;
  /** Override the chain's default RPC. */
  rpcUrl?: string;
  /** Underlying ticker; defaults to the first market on the chain. */
  underlying?: string;
  /** Or an explicit deployment (a fork, a new listing not in the registry yet). */
  deployment?: MarketDeployment;
  /** The account whose positions and balance are read/traded (the owner). Defaults to the signer's address. */
  account?: Address;
  /** Session key (trades) or owner key (deposits, withdrawals, sessions). Never logged. */
  signer?: LocalAccount;
}

export interface ExpiryInfo {
  expiry: bigint;
  openedAt: bigint;
  settled: boolean;
  settledByOwner: boolean;
  uiMultiplier: bigint;
  anchor: bigint;
  capLow: bigint;
  capHigh: bigint;
  settlementPrice: bigint;
  rawSettlementPrice: bigint;
  strikes: bigint[];
  tradingOpen: boolean;
}

export interface Position {
  instrumentId: bigint;
  expiry: bigint;
  strike: bigint;
  isPut: boolean;
  /** 18-decimal shares, negative = short. */
  quantityRaw: bigint;
}

export interface AccountSnapshot {
  account: Address;
  collateralRaw: bigint;
  requirementRaw: bigint;
  freeCollateralRaw: bigint;
  walletUsdgRaw: bigint;
  expiries: bigint[];
  positions: Position[];
}

export interface SessionInfo {
  key: Address;
  expiresAt: bigint;
  scope: bigint;
  maxRequirement: bigint;
  canTrade: boolean;
  canCancel: boolean;
  active: boolean;
}

export interface SendResult {
  /** True when nothing was sent. */
  dryRun: boolean;
  request: TxRequest;
  hash?: Hash;
  from?: Address;
}

/** Read and write helpers for one CashOptionMarketV2 + its book. Every write defaults to a dry run. */
export class MarketClient {
  readonly chainId: number;
  readonly chain: Chain;
  readonly deployment: MarketDeployment;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly signer?: LocalAccount;
  readonly account: Address | undefined;
  readonly usdg: Address;
  readonly rpcUrl: string;

  constructor(opts: MarketClientOptions) {
    this.chainId = opts.chainId;
    const chain = chains[opts.chainId];
    if (!chain) throw new Error(`unsupported chain id ${opts.chainId}`);
    this.chain = chain;
    const dep = getDeployment(opts.chainId);
    this.deployment = opts.deployment ?? getMarket(opts.chainId, opts.underlying ?? dep.markets[0]?.underlying ?? "NVDA");
    this.usdg = this.deployment.settlementToken;
    this.rpcUrl = opts.rpcUrl ?? chain.rpcUrls.default.http[0]!;
    this.publicClient = createPublicClient({ chain, transport: http(this.rpcUrl) });
    this.signer = opts.signer;
    this.account = opts.account ?? opts.signer?.address;
  }

  get market(): Address {
    return this.deployment.market;
  }
  get orderBook(): Address {
    return this.deployment.orderBook;
  }

  private requireAccount(): Address {
    if (!this.account) throw new Error("no account configured (pass `account` or a signer)");
    return this.account;
  }

  // ---------------------------------------------------------------- reads

  async chainTime(): Promise<bigint> {
    const b = await this.publicClient.getBlock();
    return b.timestamp;
  }

  async openedExpiries(): Promise<bigint[]> {
    const n = await this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "openedExpiryCount" });
    if (n === 0n) return [];
    const page = await this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "openedExpiries", args: [0n, n] });
    return [...page];
  }

  async expiryInfo(expiry: bigint): Promise<ExpiryInfo> {
    const [e, open] = await Promise.all([
      this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "expiryInfo", args: [expiry] }),
      this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "tradingOpen", args: [expiry] }),
    ]);
    return {
      expiry,
      openedAt: BigInt(e.openedAt),
      settled: e.settled,
      settledByOwner: e.settledByOwner,
      uiMultiplier: e.uiMultiplier,
      anchor: e.anchor,
      capLow: e.capLow,
      capHigh: e.capHigh,
      settlementPrice: e.settlementPrice,
      rawSettlementPrice: e.rawSettlementPrice,
      strikes: [...e.strikes],
      tradingOpen: open,
    };
  }

  /** Every instrument id of an expiry: calls then puts per strike, in strike order. */
  async instruments(expiry: bigint): Promise<bigint[]> {
    const info = await this.expiryInfo(expiry);
    const out: bigint[] = [];
    for (const s of info.strikes) out.push(encodeInstrumentId(expiry, s, false), encodeInstrumentId(expiry, s, true));
    return out;
  }

  async uiMultiplier(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.deployment.underlyingToken, abi: erc20Abi, functionName: "uiMultiplier" });
  }

  async protocolFeeBps(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.orderBook, abi: orderBookV2Abi, functionName: "protocolFeeBps" });
  }

  async snapshot(account = this.requireAccount()): Promise<AccountSnapshot> {
    const [collateralRaw, requirementRaw, freeCollateralRaw, walletUsdgRaw, expiries] = await Promise.all([
      this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "collateral", args: [account] }),
      this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "requirement", args: [account] }),
      this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "freeCollateral", args: [account] }),
      this.publicClient.readContract({ address: this.usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "accountExpiries", args: [account] }),
    ]);
    const positions: Position[] = [];
    for (const expiry of expiries) {
      const [strikes, q] = await Promise.all([
        this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "strikesOf", args: [expiry] }),
        this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "positions", args: [account, expiry] }),
      ]);
      strikes.forEach((strike, i) => {
        const call = q[2 * i] ?? 0n;
        const put = q[2 * i + 1] ?? 0n;
        if (call !== 0n) positions.push({ instrumentId: encodeInstrumentId(expiry, strike, false), expiry, strike, isPut: false, quantityRaw: call });
        if (put !== 0n) positions.push({ instrumentId: encodeInstrumentId(expiry, strike, true), expiry, strike, isPut: true, quantityRaw: put });
      });
    }
    return { account, collateralRaw, requirementRaw, freeCollateralRaw, walletUsdgRaw, expiries: [...expiries], positions };
  }

  async session(key: Address, account = this.requireAccount()): Promise<SessionInfo> {
    const [expiresAt, scope, maxRequirement] = await this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "sessions", args: [account, key] });
    const now = BigInt(Math.floor(Date.now() / 1000));
    return {
      key,
      expiresAt: BigInt(expiresAt),
      scope,
      maxRequirement,
      canTrade: (scope & SCOPE_TRADE) !== 0n,
      canCancel: (scope & SCOPE_CANCEL) !== 0n,
      active: BigInt(expiresAt) > now && scope !== 0n,
    };
  }

  async isAuthorized(account: Address, signer: Address, scope = SCOPE_TRADE): Promise<boolean> {
    return this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "isAuthorized", args: [account, signer, scope] });
  }

  /** The requirement the account would carry after buying (delta > 0) or selling (delta < 0) an instrument. */
  async requirementIfTraded(instrumentId: bigint, delta: bigint, account = this.requireAccount()): Promise<bigint> {
    return this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "requirementIfTraded", args: [account, instrumentId, delta] });
  }

  /** On-chain checks of a quote: digest, remaining size, signature validity (covers ERC-1271 and session authority). */
  async checkOrder(order: Order, signature: Hex): Promise<{ digest: Hex; remainingRaw: bigint; signatureValid: boolean; currentPremiumRaw: bigint }> {
    const t = orderToTuple(order);
    const [digest, remainingRaw, signatureValid, currentPremiumRaw] = await Promise.all([
      this.publicClient.readContract({ address: this.orderBook, abi: orderBookV2Abi, functionName: "orderDigest", args: [t] }),
      this.publicClient.readContract({ address: this.orderBook, abi: orderBookV2Abi, functionName: "remaining", args: [t] }),
      this.publicClient.readContract({ address: this.orderBook, abi: orderBookV2Abi, functionName: "isValidOrderSignature", args: [t, signature] }),
      this.publicClient.readContract({ address: this.orderBook, abi: orderBookV2Abi, functionName: "currentPremiumRaw", args: [t] }),
    ]);
    return { digest, remainingRaw, signatureValid, currentPremiumRaw };
  }

  async describe(instrumentId: bigint) {
    return { ...decodeInstrumentId(instrumentId), underlying: this.deployment.underlying };
  }

  // ---------------------------------------------------------------- writes (dry run by default)

  /**
   * Simulates then (unless dryRun) signs and sends `request` from the configured signer. Simulation runs first in
   * both cases so a dry run still reports the revert reason a send would hit.
   */
  async send(request: TxRequest, opts: { dryRun?: boolean; simulate?: boolean } = {}): Promise<SendResult> {
    const dryRun = opts.dryRun ?? true;
    if (!this.signer) throw new Error("no signer configured");
    const from = this.signer.address;
    if (opts.simulate ?? true) {
      await this.publicClient.call({ account: from, to: request.to, data: request.data, value: request.value });
    }
    if (dryRun) return { dryRun: true, request, from };
    const wallet = createWalletClient({ account: this.signer, chain: this.chain, transport: http(this.rpcUrl) });
    const hash = await wallet.sendTransaction({ to: request.to, data: request.data, value: request.value ?? 0n });
    return { dryRun: false, request, hash, from };
  }

  async waitForReceipt(hash: Hash) {
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** Take an RFQ quote for `account` from the session key (balance mode by default: no approvals). */
  fillOrderAs(order: Order, signature: Hex, fillQuantityRaw: bigint, fromBalance = true, account = this.requireAccount()): TxRequest {
    return encodeFillOrderAs(this.orderBook, account, order, signature, fillQuantityRaw, fromBalance);
  }

  /** Deposit USDG into `account`'s market balance from the signer's wallet (needs allowance; see `approveUsdg`). */
  deposit(amountRaw: bigint, account = this.requireAccount()): TxRequest {
    return encodeDeposit(this.market, account, amountRaw);
  }

  approveUsdg(amountRaw: bigint): TxRequest {
    return encodeApprove(this.usdg, this.market, amountRaw);
  }

  async usdgAllowance(owner: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: this.usdg, abi: erc20Abi, functionName: "allowance", args: [owner, this.market] });
  }

  withdraw(amountRaw: bigint, to: Address): TxRequest {
    return encodeWithdraw(this.market, amountRaw, to);
  }

  authorizeSession(key: Address, expiresAt: bigint | number, opts: { trade?: boolean; cancel?: boolean; maxRequirement?: bigint } = {}): TxRequest {
    const scope = ((opts.trade ?? true) ? SCOPE_TRADE : 0n) | (opts.cancel ? SCOPE_CANCEL : 0n);
    return encodeAuthorizeSession(this.market, key, expiresAt, scope, opts.maxRequirement ?? 0n);
  }

  revokeSession(key: Address): TxRequest {
    return encodeRevokeSession(this.market, key);
  }

  redeem(expiry: bigint): TxRequest {
    return encodeRedeem(this.market, expiry);
  }

  redeemFor(account: Address, expiry: bigint): TxRequest {
    return encodeRedeemFor(this.market, account, expiry);
  }

  settle(expiry: bigint, hint: Hex = "0x"): TxRequest {
    return encodeSettle(this.market, expiry, hint);
  }
}
