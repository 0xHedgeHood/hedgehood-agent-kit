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
import { decodeMarketError, MarketRevertError } from "./errors.js";
import { decodeInstrumentId, encodeInstrumentId, expiryDateNY, expiryOf, instrumentNameOf, parseInstrumentName, resolveInstrumentName, shareStrikeOf, UNIT_MULTIPLIER } from "./instrument.js";
import { orderToTuple, SCOPE_CANCEL, SCOPE_TRADE, type Order } from "./order.js";
import { sendTxRequest, type SendResult } from "./send.js";

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
  /** Per-token strikes (USDG raw per 1e18 token units), as stored and as packed into instrument ids. */
  strikes: bigint[];
  /** The listed per-share strikes, `shareStrikeOf(strike, uiMultiplier)`, in the same order. */
  shareStrikes: bigint[];
  tradingOpen: boolean;
}

export interface Position {
  instrumentId: bigint;
  expiry: bigint;
  /** Per-token strike, as in the instrument id. */
  strike: bigint;
  /** The listed per-share strike (what names and labels show). */
  shareStrike: bigint;
  /** The expiry's snapshotted uiMultiplier. */
  uiMultiplier: bigint;
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

/** `type(uint256).max`: the "unlimited" value of a session's maxRequirement / maxSpend. */
export const UNLIMITED = (1n << 256n) - 1n;

export interface SessionInfo {
  key: Address;
  expiresAt: bigint;
  /** When the session was (re-)authorized: orders the key signed with an earlier startTime are void. */
  authorizedAt: bigint;
  scope: bigint;
  /** Cap on the account's total requirement a session trade may push it to: 0 = no new requirement, UNLIMITED = no cap. */
  maxRequirement: bigint;
  /** Premium + fee (USDG raw) the key may still make the account pay as buyer: 0 = cannot buy, UNLIMITED = no cap. */
  spendLeft: bigint;
  canTrade: boolean;
  canCancel: boolean;
  active: boolean;
}

/** A session cap for display: "unlimited", "none (0)" or the USDG amount. */
export function formatSessionCap(raw: bigint): string {
  if (raw === UNLIMITED) return "unlimited";
  if (raw === 0n) return "none (0)";
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Options of `authorizeSession`; both caps are explicit because 0 means "none", not "unlimited". */
export interface AuthorizeSessionOptions {
  trade?: boolean;
  cancel?: boolean;
  /** USDG raw cap on the account's total requirement after a session trade: 0 = no new requirement (default), UNLIMITED = no cap. */
  maxRequirement?: bigint;
  /** USDG raw premium + fee the key may make the account pay over the session: 0 = it cannot buy, UNLIMITED = no cap. Required. */
  maxSpend: bigint;
}

export type { SendResult } from "./send.js";

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
  /** Snapshotted uiMultiplier per opened expiry (immutable once the expiry is open). */
  private readonly multipliers = new Map<bigint, bigint>();

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
    if (BigInt(e.openedAt) !== 0n && e.uiMultiplier !== 0n) this.multipliers.set(expiry, e.uiMultiplier);
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
      shareStrikes: e.strikes.map((k) => shareStrikeOf(k, e.uiMultiplier === 0n ? UNIT_MULTIPLIER : e.uiMultiplier)),
      tradingOpen: open,
    };
  }

  /** The uiMultiplier an opened expiry snapshotted (cached; 1e18 for an expiry that is not open). */
  async expiryMultiplier(expiry: bigint): Promise<bigint> {
    const hit = this.multipliers.get(expiry);
    if (hit !== undefined) return hit;
    const info = await this.expiryInfo(expiry);
    return info.openedAt === 0n || info.uiMultiplier === 0n ? UNIT_MULTIPLIER : info.uiMultiplier;
  }

  /** Backend name of an instrument (`NVDA-20261030-220-C`) with the listed per-share strike of its expiry. */
  async instrumentName(instrumentId: bigint): Promise<string> {
    return instrumentNameOf(instrumentId, this.deployment.underlying, await this.expiryMultiplier(expiryOf(instrumentId)));
  }

  /**
   * A backend name (`NVDA-20261030-220-C`, per-share strike) to a packed id: finds the opened expiry of that New York
   * date and maps the per-share strike to the per-token strike it lists (see `resolveInstrumentName`).
   */
  async resolveInstrumentName(text: string): Promise<bigint> {
    const p = parseInstrumentName(text);
    const expiry = (await this.openedExpiries()).find((e) => expiryDateNY(e) === p.date);
    if (expiry === undefined) throw new RangeError(`no opened expiry on ${p.date}`);
    const info = await this.expiryInfo(expiry);
    return resolveInstrumentName(text, [{ expiry, uiMultiplier: info.uiMultiplier === 0n ? UNIT_MULTIPLIER : info.uiMultiplier, strikes: info.strikes }]);
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
      const [e, q] = await Promise.all([
        this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "expiryInfo", args: [expiry] }),
        this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "positions", args: [account, expiry] }),
      ]);
      const uiMultiplier = e.uiMultiplier === 0n ? UNIT_MULTIPLIER : e.uiMultiplier;
      this.multipliers.set(expiry, uiMultiplier);
      e.strikes.forEach((strike, i) => {
        const call = q[2 * i] ?? 0n;
        const put = q[2 * i + 1] ?? 0n;
        const shareStrike = shareStrikeOf(strike, uiMultiplier);
        if (call !== 0n) positions.push({ instrumentId: encodeInstrumentId(expiry, strike, false), expiry, strike, shareStrike, uiMultiplier, isPut: false, quantityRaw: call });
        if (put !== 0n) positions.push({ instrumentId: encodeInstrumentId(expiry, strike, true), expiry, strike, shareStrike, uiMultiplier, isPut: true, quantityRaw: put });
      });
    }
    return { account, collateralRaw, requirementRaw, freeCollateralRaw, walletUsdgRaw, expiries: [...expiries], positions };
  }

  async session(key: Address, account = this.requireAccount()): Promise<SessionInfo> {
    const [expiresAt, authorizedAt, scope, maxRequirement, spendLeft] = await this.publicClient.readContract({ address: this.market, abi: marketV2Abi, functionName: "sessions", args: [account, key] });
    const now = BigInt(Math.floor(Date.now() / 1000));
    return {
      key,
      expiresAt: BigInt(expiresAt),
      authorizedAt: BigInt(authorizedAt),
      scope,
      maxRequirement,
      spendLeft,
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
    const d = decodeInstrumentId(instrumentId);
    const uiMultiplier = await this.expiryMultiplier(d.expiry);
    return { ...d, shareStrike: shareStrikeOf(d.strike, uiMultiplier), uiMultiplier, underlying: this.deployment.underlying };
  }

  // ---------------------------------------------------------------- writes (dry run by default)

  /**
   * Simulates then (unless dryRun) signs and sends `request` from the configured signer. Simulation runs first in
   * both cases so a dry run still reports the revert reason a send would hit.
   */
  async send(request: TxRequest, opts: { dryRun?: boolean; simulate?: boolean } = {}): Promise<SendResult> {
    try {
      return await sendTxRequest(this, request, opts);
    } catch (e) {
      const decoded = decodeMarketError(e);
      if (decoded) throw new MarketRevertError(request.summary, decoded, e);
      throw e;
    }
  }

  async waitForReceipt(hash: Hash) {
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** True when the configured signer is a session key acting for another account (not the account itself). */
  get signsAsSession(): boolean {
    return !!this.signer && !!this.account && this.signer.address.toLowerCase() !== this.account.toLowerCase();
  }

  /**
   * Take an RFQ quote for `account` from the session key, in balance mode (premium, fee and collateral settle from the
   * deposited balance; no approvals). A session key must fill in balance mode: the market reverts `SessionWalletMode`
   * on a session leg in wallet mode, so `fromBalance = false` is refused here unless the signer is the account itself.
   */
  fillOrderAs(order: Order, signature: Hex, fillQuantityRaw: bigint, fromBalance = true, account = this.requireAccount()): TxRequest {
    if (!fromBalance && this.signer && this.signer.address.toLowerCase() !== account.toLowerCase()) {
      throw new Error(`a session key must fill in balance mode: the market reverts SessionWalletMode on a session leg with fromBalance = false (signer ${this.signer.address} is not the account ${account}); keep fromBalance true, or sign with the account key for wallet mode`);
    }
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

  /**
   * `authorizeSession(key, expiresAt, scope, maxRequirement, maxSpend)` from the owner. `maxSpend` is required: the
   * total premium + fee the key may make the account pay (0 = it cannot buy, `UNLIMITED` = no cap). `maxRequirement`
   * defaults to 0 (the key cannot raise the account's requirement, i.e. cannot write options). Re-authorizing resets
   * the budget and voids every order the key signed before.
   */
  authorizeSession(key: Address, expiresAt: bigint | number, opts: AuthorizeSessionOptions): TxRequest {
    if (opts?.maxSpend === undefined) throw new Error("authorizeSession: maxSpend is required (USDG raw the key may spend on premium + fees; 0 = cannot buy, UNLIMITED = no cap)");
    const scope = ((opts.trade ?? true) ? SCOPE_TRADE : 0n) | (opts.cancel ? SCOPE_CANCEL : 0n);
    return encodeAuthorizeSession(this.market, key, expiresAt, scope, opts.maxRequirement ?? 0n, opts.maxSpend);
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
