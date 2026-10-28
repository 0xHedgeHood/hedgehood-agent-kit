import { createPublicClient, encodeFunctionData, http, type Address, type Chain, type Hash, type PublicClient, type Transport } from "viem";
import type { LocalAccount } from "viem/accounts";
import { epochFundAbi } from "./abi/epochFund.js";
import { erc20Abi } from "./abi/erc20.js";
import { openDepositGateAbi } from "./abi/openDepositGate.js";
import { stakeThresholdGateAbi } from "./abi/stakeThresholdGate.js";
import { vaultRegistryAbi } from "./abi/vaultRegistry.js";
import { encodeApprove, type TxRequest } from "./calldata.js";
import { chains, getVaults, type VaultDeployment, type VaultFund } from "./chains.js";
import { sendTxRequest, type SendResult } from "./send.js";
import { formatShares, formatUsdg } from "./units.js";

/**
 * Stock Yield vaults: Hedgehood's v2 `EpochFund`s on Robinhood Chain. A fund holds one tokenized stock and USDG,
 * writes options on it every week through its engines (OptionBooks), and issues transferable NAV shares. Nothing is
 * instant: a deposit queues until the next epoch freeze (Monday 09:25 New York for the mainnet funds), is priced at
 * that moment's NAV and becomes shares; a redemption queues the same way and is paid in kind (stock + USDG, pro rata)
 * at the freeze, after the current option expires; both then wait for `claim`. Requests can be cancelled until their
 * cohort's cutoff. Reads come from the chain (the `VaultRegistry` lists the funds) and, on mainnet, from the public
 * `GET /api/stockyield/funds` snapshot; writes are the owner wallet's own ERC-20 approvals and fund calls, dry run by
 * default. Contract source: hedgehood-vaults `contracts/src/v2/EpochFund.sol` (tag audit-v2-freeze-2026-10-21).
 */

export type VaultPhase = "Collecting" | "Locked" | "Frozen";
/** What the epoch is doing from a depositor's point of view (see `epochState`). */
export type VaultEpochState = "open" | "frozen" | "locked" | "settling";
export type GateKind = "open" | "stake" | "none" | "unknown";

export interface VaultSchedule {
  depositCutoff: bigint;
  tradeStart: bigint;
  tradeEnd: bigint;
  expiry: bigint;
  maxDeviationBps: number;
}

export interface VaultEpochInfo {
  index: bigint;
  /** The contract's `phase`, as deployed: Collecting | Locked | Frozen. */
  phase: VaultPhase;
  /**
   * open: collecting deposits and redemptions for this epoch (until `nextFreezeAt`);
   * frozen: the cutoff passed, the freeze priced the cohort and the engines may lock collateral inside the trade window;
   * locked: an option is written, the epoch runs until `nextSettleAt` (the expiry);
   * settling: expired, waiting for the engines to settle (then the next epoch opens and the cohort can claim).
   */
  state: VaultEpochState;
  schedule: VaultSchedule;
  /** The epoch a request made now would join. */
  nextCohort: bigint;
  /** Cutoff of `nextCohort`: when the next freeze prices queued deposits and pays queued redemptions. Unknown when not scheduled yet. */
  nextFreezeAt?: bigint;
  /** Expiry of the current epoch: when the option expires and the epoch can settle. */
  nextSettleAt?: bigint;
}

export interface VaultNav {
  /** USDG per share (6 decimals) at `priceRaw`; undefined without supply or price. */
  usdgPerShareRaw?: bigint;
  /** NAV in USDG raw (6 decimals), excluding queued and reserved assets. */
  navUsdgRaw: bigint;
  /** Stock price used (18 decimals, USD): the live Oracle price when the market is open, else the fund's last mark. */
  priceRaw: bigint;
  source: "live" | "mark" | "none";
}

export interface VaultLastEpoch {
  index: bigint;
  /** Net premium income that entered NAV at settlement, USDG raw. */
  incomeUsdgRaw: bigint;
  /** NAV the epoch started with: assets at the freeze plus that cohort's deposits, USDG raw. */
  navAtFreezeUsdgRaw: bigint;
  /** income / navAtFreeze in bps; a rough weekly yield, undefined when the base is zero. */
  weeklyYieldBps?: number;
  settledAt: bigint;
  settlementPriceRaw: bigint;
}

export interface VaultPendingDeposit {
  epoch: bigint;
  stockRaw: bigint;
  usdgRaw: bigint;
  /** False once the cohort froze (the deposit is becoming shares; nothing to cancel). */
  cancellable: boolean;
}

export interface VaultPendingRedeem {
  epoch: bigint;
  sharesRaw: bigint;
  cancellable: boolean;
}

export interface VaultAccountInfo {
  account: Address;
  /** Shares held plus shares a frozen deposit cohort owes the account but has not credited yet. */
  sharesRaw: bigint;
  balanceRaw: bigint;
  uncreditedSharesRaw: bigint;
  pendingDeposit?: VaultPendingDeposit;
  pendingRedeem?: VaultPendingRedeem;
  /** Redeemed or refunded assets the account can `claim` now (including frozen cohorts not credited yet). */
  claimableStockRaw: bigint;
  claimableUsdgRaw: bigint;
  /** Shares in escrow for a queued redemption (frozen cohorts are already in `claimable`). */
  canDeposit: boolean;
  walletUsdgRaw: bigint;
  walletStockRaw: bigint;
}

export interface VaultInfo {
  chainId: number;
  vault: Address;
  name: string;
  symbol: string;
  strategy: { code: string; name: string };
  stock: { address: Address; symbol: string; decimals: 18 };
  usdg: Address;
  gate: { address: Address; kind: GateKind };
  paused: boolean;
  /** Admission limit in USDG raw of estimated value (NAV + queued + unclaimed). */
  depositCapUsdgRaw: bigint;
  /** Estimated value counted against the cap at `nav.priceRaw`, USDG raw. */
  capUsedUsdgRaw: bigint;
  totalSharesRaw: bigint;
  stockHeldRaw: bigint;
  usdgHeldRaw: bigint;
  nav: VaultNav;
  epoch: VaultEpochInfo;
  lastEpoch?: VaultLastEpoch;
  /** The desk's fee on premium, bps (mainnet API only). */
  feeBps?: number;
  /** Where the fund-level fields came from. */
  source: "chain" | "api";
  my?: VaultAccountInfo;
}

/** A plan of one or more unsigned transactions the owner wallet sends in order. */
export interface VaultTxStep extends TxRequest {
  kind: "approve" | "requestDeposit" | "requestRedeem" | "cancelDeposit" | "cancelRedeem" | "claim";
  /** False for a step that only succeeds after an earlier step of the plan is mined (a dry run cannot simulate it). */
  simulate: boolean;
}

export interface VaultPlan {
  vault: Address;
  symbol: string;
  account: Address;
  steps: VaultTxStep[];
  /** What the plan does, for confirmations. */
  summary: string;
}

export interface VaultStepResult extends SendResult {
  kind: VaultTxStep["kind"];
  status?: "success" | "reverted";
  blockNumber?: bigint;
}

export interface VaultClientOptions {
  chainId: number;
  rpcUrl?: string;
  /** The account whose shares and queues are read and acted on; defaults to the signer's address. */
  account?: Address;
  /** The owner wallet: it holds the stock/USDG and the shares. A market session key cannot act on a vault. */
  signer?: LocalAccount;
  deployment?: VaultDeployment;
  /** Public read API for fund snapshots; `false` disables it (chain only). Default: the chain's registry entry. */
  apiUrl?: string | false;
  /** Timeout for the API, ms (default 6000). */
  apiTimeoutMs?: number;
  fetch?: typeof fetch;
}

/** The mainnet `GET /api/stockyield/funds` row shape (hedgehood.app, rhsvc/stockyield_funds.py); integers are decimal strings. */
export interface StockYieldApiFund {
  chainId: number;
  vault: Address;
  name?: string;
  symbol?: string;
  stock?: Address;
  stockSymbol?: string;
  usdg?: Address;
  strategy?: { address: Address; name: string; code: string; legs?: string[] } | null;
  depositGate?: Address;
  paused?: boolean;
  phase?: string;
  effectivePhase?: string;
  currentEpoch?: string;
  schedules?: Record<string, { depositCutoff: number; tradeStart: number; tradeEnd: number; expiry: number; maxAtmDeviationBps: number }>;
  depositCapUsdg?: string;
  stockHeld?: string;
  usdgHeld?: string;
  pendingStock?: string;
  pendingUsdg?: string;
  reservedStock?: string;
  reservedUsdg?: string;
  totalSupply?: string;
  markPrice?: string;
  /** Live Oracle price, "0" while the market is closed. */
  price?: string;
  readAt?: number;
  epochs?: Array<{ navUsdg: string; income: string; settledAt: string; navPrice?: string; depositStock?: string; depositUsdg?: string; depositsRefunded?: boolean }>;
  stake?: number | null;
  feeBps?: number | null;
  error?: string;
}

export interface StockYieldApiResponse {
  chainId: number;
  funds: StockYieldApiFund[];
  builtAt: number;
}

const VALUE_SCALE = 10n ** 30n; // 18d stock * 18d price -> 6d USDG
const ONE_SHARE = 10n ** 18n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const PHASES: VaultPhase[] = ["Collecting", "Locked", "Frozen"];

/** `IEpochFundOracle.price()`: the live stock price (18 decimals); reverts `ClosedMarket` outside trading hours. */
const oracleAbi = [{ type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }] as const;

/** The depositor's view of an epoch from the contract's phase and schedule. */
export function epochState(phase: VaultPhase, schedule: VaultSchedule, now: bigint): VaultEpochState {
  const effective: VaultPhase = phase === "Collecting" && schedule.depositCutoff !== 0n && now >= schedule.depositCutoff ? "Frozen" : phase;
  if (effective === "Collecting") return "open";
  if (effective === "Frozen") return "frozen";
  return schedule.expiry !== 0n && now >= schedule.expiry ? "settling" : "locked";
}

/** NAV per share in USDG raw (6 decimals) from the fund's held assets, a price and the supply. */
export function navPerShareRaw(stockHeldRaw: bigint, usdgHeldRaw: bigint, priceRaw: bigint, totalSharesRaw: bigint): bigint | undefined {
  if (totalSharesRaw === 0n || priceRaw === 0n) return undefined;
  return ((stockHeldRaw * priceRaw) / VALUE_SCALE + usdgHeldRaw) * ONE_SHARE / totalSharesRaw;
}

/** "Hedgehood Covered Call NVDA" + "hhNVDA-CC" -> { code: "CC", name: "Covered Call" }. */
export function strategyFromNames(name: string, symbol: string, stockSymbol?: string): { code: string; name: string } {
  const code = symbol.includes("-") ? symbol.slice(symbol.lastIndexOf("-") + 1) : symbol;
  let n = name.replace(/^Hedgehood\s+/, "");
  if (stockSymbol && n.endsWith(` ${stockSymbol}`)) n = n.slice(0, -stockSymbol.length - 1);
  else n = n.replace(/\s+\S+$/, "");
  return { code, name: n || code };
}

/** "all" or a share amount string -> raw shares (1e18), capped at `available` for "all". */
export function parseVaultShares(v: string | bigint, available: bigint): bigint {
  if (typeof v === "bigint") return v;
  if (v.trim().toLowerCase() === "all") return available;
  const s = v.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new RangeError(`not a share quantity with at most 18 decimals, or "all": ${v}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole!) * ONE_SHARE + BigInt((frac + "0".repeat(18)).slice(0, 18));
}

/** Read and write helpers for the Stock Yield vaults of one chain. Every write defaults to a dry run. */
export class VaultClient {
  readonly chainId: number;
  readonly chain: Chain;
  readonly deployment: VaultDeployment;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly signer?: LocalAccount;
  readonly account: Address | undefined;
  readonly rpcUrl: string;
  readonly apiUrl?: string;
  readonly apiTimeoutMs: number;
  readonly fetch?: typeof fetch;

  constructor(opts: VaultClientOptions) {
    this.chainId = opts.chainId;
    const chain = chains[opts.chainId];
    if (!chain) throw new Error(`unsupported chain id ${opts.chainId}`);
    this.chain = chain;
    this.deployment = opts.deployment ?? getVaults(opts.chainId);
    this.rpcUrl = opts.rpcUrl ?? chain.rpcUrls.default.http[0]!;
    this.fetch = opts.fetch;
    this.publicClient = createPublicClient({ chain, transport: http(this.rpcUrl, opts.fetch ? { fetchFn: opts.fetch } : {}) });
    this.signer = opts.signer;
    this.account = opts.account ?? opts.signer?.address;
    this.apiUrl = opts.apiUrl === false ? undefined : (opts.apiUrl ?? this.deployment.api);
    this.apiTimeoutMs = opts.apiTimeoutMs ?? 6000;
  }

  get registry(): Address {
    return this.deployment.registry;
  }
  get usdg(): Address {
    return this.deployment.usdg;
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

  /** Active funds listed by the registry (the on-chain source of truth). */
  async registeredVaults(): Promise<Address[]> {
    const all = await this.publicClient.readContract({ address: this.registry, abi: vaultRegistryAbi, functionName: "vaults" });
    const active = await Promise.all(all.map((v) => this.publicClient.readContract({ address: this.registry, abi: vaultRegistryAbi, functionName: "isVault", args: [v] })));
    return all.filter((_, i) => active[i]);
  }

  /** Address, share symbol ("hhNVDA-CC", "NVDA-CC") or stock ticker when unique ("GOOGL") -> the fund's address. */
  async resolveVault(ref: string): Promise<Address> {
    if (/^0x[0-9a-fA-F]{40}$/.test(ref)) return ref as Address;
    const want = ref.trim().toUpperCase().replace(/^HH/, "");
    const known = this.deployment.funds;
    const bySymbol = known.filter((f) => f.symbol.toUpperCase().replace(/^HH/, "") === want);
    if (bySymbol.length === 1) return bySymbol[0]!.vault;
    const byStock = known.filter((f) => f.stockSymbol.toUpperCase() === want);
    if (byStock.length === 1) return byStock[0]!.vault;
    if (byStock.length > 1) throw new Error(`${ref} names several funds (${byStock.map((f) => f.symbol).join(", ")}); give the full symbol or the address`);
    // not in the static list: ask the registry
    const vaults = await this.registeredVaults();
    const symbols = await Promise.all(vaults.map((v) => this.publicClient.readContract({ address: v, abi: epochFundAbi, functionName: "symbol" })));
    const i = symbols.findIndex((s) => s.toUpperCase().replace(/^HH/, "") === want);
    if (i === -1) throw new Error(`unknown vault ${ref} on chain ${this.chainId} (known: ${symbols.join(", ")})`);
    return vaults[i]!;
  }

  async schedule(vault: Address, epoch: bigint): Promise<VaultSchedule> {
    const [depositCutoff, tradeStart, tradeEnd, expiry, maxDeviationBps] = await this.publicClient.readContract({ address: vault, abi: epochFundAbi, functionName: "epochSchedules", args: [epoch] });
    return { depositCutoff: BigInt(depositCutoff), tradeStart: BigInt(tradeStart), tradeEnd: BigInt(tradeEnd), expiry: BigInt(expiry), maxDeviationBps: Number(maxDeviationBps) };
  }

  /** The gate's kind: known deployment addresses first, then a probe of its surface. */
  async gateKind(gate: Address): Promise<GateKind> {
    if (gate === ZERO) return "none";
    const g = gate.toLowerCase();
    if (this.deployment.openGate?.toLowerCase() === g) return "open";
    if (this.deployment.stakeGate?.toLowerCase() === g) return "stake";
    try {
      await this.publicClient.readContract({ address: gate, abi: openDepositGateAbi, functionName: "banned", args: [ZERO] });
      return "open";
    } catch {
      /* not an OpenDepositGate */
    }
    try {
      await this.publicClient.readContract({ address: gate, abi: stakeThresholdGateAbi, functionName: "staking" });
      return "stake";
    } catch {
      return "unknown";
    }
  }

  /** The fund-level snapshot from the chain. */
  async vaultInfo(vault: Address, opts: { now?: bigint; account?: Address | null } = {}): Promise<VaultInfo> {
    const pc = this.publicClient;
    const r = <F extends string>(functionName: F, args: readonly unknown[] = []) => pc.readContract({ address: vault, abi: epochFundAbi, functionName, args } as never) as never;
    const [name, symbol, stock, usdg, gate, paused, phaseIdx, currentEpoch, depositCapUsdgRaw, stockHeldRaw, usdgHeldRaw, pendingStock, pendingUsdg, reservedStock, reservedUsdg, totalSharesRaw, markPriceRaw, oracle] = (await Promise.all([
      r("name"), r("symbol"), r("stock"), r("usdg"), r("depositGate"), r("paused"), r("phase"), r("currentEpoch"), r("depositCapUsdg"), r("stockHeld"), r("usdgHeld"), r("pendingStock"), r("pendingUsdg"), r("reservedStock"), r("reservedUsdg"), r("totalSupply"), r("markPrice"), r("oracle"),
    ])) as [string, string, Address, Address, Address, boolean, number, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, Address];
    const now = opts.now ?? (await this.chainTime());
    const [schedule, next, stockSymbol, livePrice, lastEpochRaw, gateKind] = await Promise.all([
      this.schedule(vault, currentEpoch),
      this.schedule(vault, currentEpoch + 1n),
      pc.readContract({ address: stock, abi: erc20Abi, functionName: "symbol" }).catch(() => "stock"),
      pc.readContract({ address: oracle, abi: oracleAbi, functionName: "price" }).catch(() => 0n),
      currentEpoch > 1n ? pc.readContract({ address: vault, abi: epochFundAbi, functionName: "getEpoch", args: [currentEpoch - 1n] }) : Promise.resolve(undefined),
      this.gateKind(gate),
    ]);
    const base = {
      chainId: this.chainId,
      vault,
      name,
      symbol,
      strategy: strategyFromNames(name, symbol, stockSymbol),
      stock: { address: stock, symbol: stockSymbol, decimals: 18 as const },
      usdg,
      gate: { address: gate, kind: gateKind },
      paused,
      depositCapUsdgRaw,
      totalSharesRaw,
      stockHeldRaw,
      usdgHeldRaw,
      source: "chain" as const,
    };
    const info = assembleInfo(base, {
      phase: PHASES[Number(phaseIdx)] ?? "Collecting",
      currentEpoch,
      schedule,
      next,
      livePriceRaw: livePrice,
      markPriceRaw,
      pendingStock,
      pendingUsdg,
      reservedStock,
      reservedUsdg,
      now,
      lastEpoch: lastEpochRaw
        ? { index: currentEpoch - 1n, income: lastEpochRaw.income, navUsdg: lastEpochRaw.navUsdg, navPrice: lastEpochRaw.navPrice, depositStock: lastEpochRaw.depositStock, depositUsdg: lastEpochRaw.depositUsdg, settledAt: BigInt(lastEpochRaw.settledAt), settlementPrice: lastEpochRaw.settlementPrice }
        : undefined,
    });
    const account = opts.account === null ? undefined : (opts.account ?? this.account);
    if (account) info.my = await this.accountInfo(vault, account, { now, schedule, next, currentEpoch, stock, usdg });
    return info;
  }

  /** The account's shares, queues and claimables in one fund. */
  async accountInfo(vault: Address, account = this.requireAccount(), ctx: { now?: bigint; schedule?: VaultSchedule; next?: VaultSchedule; currentEpoch?: bigint; stock?: Address; usdg?: Address } = {}): Promise<VaultAccountInfo> {
    const pc = this.publicClient;
    const [stock, usdg] = await Promise.all([
      ctx.stock ?? pc.readContract({ address: vault, abi: epochFundAbi, functionName: "stock" }),
      ctx.usdg ?? pc.readContract({ address: vault, abi: epochFundAbi, functionName: "usdg" }),
    ]);
    const [balanceRaw, acct, preview, canDeposit, walletUsdgRaw, walletStockRaw, now] = await Promise.all([
      pc.readContract({ address: vault, abi: epochFundAbi, functionName: "balanceOf", args: [account] }),
      pc.readContract({ address: vault, abi: epochFundAbi, functionName: "getAccount", args: [account] }),
      pc.readContract({ address: vault, abi: epochFundAbi, functionName: "previewAccount", args: [account] }),
      pc.readContract({ address: vault, abi: epochFundAbi, functionName: "canDeposit", args: [account] }),
      pc.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      pc.readContract({ address: stock, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      ctx.now ?? this.chainTime(),
    ]);
    const [uncredited, claimableStockRaw, claimableUsdgRaw] = preview;
    const cancellable = async (epoch: bigint): Promise<boolean> => {
      const [e, s] = await Promise.all([
        pc.readContract({ address: vault, abi: epochFundAbi, functionName: "getEpoch", args: [epoch] }),
        epoch === ctx.currentEpoch && ctx.schedule ? ctx.schedule : epoch === (ctx.currentEpoch ?? -1n) + 1n && ctx.next ? ctx.next : this.schedule(vault, epoch),
      ]);
      return BigInt(e.frozenAt) === 0n && (s.depositCutoff === 0n || now < s.depositCutoff);
    };
    const out: VaultAccountInfo = {
      account,
      sharesRaw: balanceRaw + uncredited,
      balanceRaw,
      uncreditedSharesRaw: uncredited,
      claimableStockRaw,
      claimableUsdgRaw,
      canDeposit,
      walletUsdgRaw,
      walletStockRaw,
    };
    if (acct.depositEpoch !== 0n) {
      const c = await cancellable(acct.depositEpoch);
      // a frozen deposit cohort is already counted in `uncredited` shares (or in claimable, when refunded)
      if (c) out.pendingDeposit = { epoch: acct.depositEpoch, stockRaw: acct.depositStock, usdgRaw: acct.depositUsdg, cancellable: true };
      else if (uncredited === 0n && (acct.depositStock !== 0n || acct.depositUsdg !== 0n)) out.pendingDeposit = { epoch: acct.depositEpoch, stockRaw: acct.depositStock, usdgRaw: acct.depositUsdg, cancellable: false };
    }
    if (acct.redeemEpoch !== 0n) {
      const c = await cancellable(acct.redeemEpoch);
      out.pendingRedeem = { epoch: acct.redeemEpoch, sharesRaw: acct.redeemShares, cancellable: c };
    }
    return out;
  }

  /** The public snapshot API, or undefined when disabled, unreachable or not for this chain. */
  async apiSnapshot(): Promise<StockYieldApiResponse | undefined> {
    if (!this.apiUrl) return undefined;
    const f = this.fetch ?? globalThis.fetch;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.apiTimeoutMs);
    try {
      const res = await f(this.apiUrl, { headers: { accept: "application/json" }, signal: ctl.signal });
      if (!res.ok) return undefined;
      const body = (await res.json()) as StockYieldApiResponse;
      if (body.chainId !== this.chainId || !Array.isArray(body.funds)) return undefined;
      return body;
    } catch {
      return undefined;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Every active fund of the registry with its snapshot (from the API when it answers for this chain, else the chain)
   * and, when an account is known, that account's position in it.
   */
  async listVaults(opts: { account?: Address | null; vaults?: Address[] } = {}): Promise<VaultInfo[]> {
    const [vaults, api, now] = await Promise.all([opts.vaults ?? this.registeredVaults(), this.apiSnapshot(), this.chainTime()]);
    const rows = new Map<string, StockYieldApiFund>();
    for (const f of api?.funds ?? []) if (!f.error && f.vault) rows.set(f.vault.toLowerCase(), f);
    const account = opts.account === null ? undefined : (opts.account ?? this.account);
    return Promise.all(
      vaults.map(async (vault) => {
        const row = rows.get(vault.toLowerCase());
        const info = row ? await this.fromApiRow(vault, row, now).catch(() => undefined) : undefined;
        if (info) {
          if (account) info.my = await this.accountInfo(vault, account, { now, schedule: info.epoch.schedule, currentEpoch: info.epoch.index, stock: info.stock.address, usdg: info.usdg });
          return info;
        }
        return this.vaultInfo(vault, { now, account: account ?? null });
      }),
    );
  }

  private async fromApiRow(vault: Address, f: StockYieldApiFund, now: bigint): Promise<VaultInfo | undefined> {
    if (!f.name || !f.symbol || !f.stock || !f.usdg || !f.currentEpoch || !f.schedules || f.totalSupply === undefined || f.stockHeld === undefined || f.usdgHeld === undefined || f.depositCapUsdg === undefined) return undefined;
    const currentEpoch = BigInt(f.currentEpoch);
    const sched = (e: bigint): VaultSchedule => {
      const s = f.schedules![e.toString()];
      return s ? { depositCutoff: BigInt(s.depositCutoff), tradeStart: BigInt(s.tradeStart), tradeEnd: BigInt(s.tradeEnd), expiry: BigInt(s.expiry), maxDeviationBps: s.maxAtmDeviationBps } : { depositCutoff: 0n, tradeStart: 0n, tradeEnd: 0n, expiry: 0n, maxDeviationBps: 0 };
    };
    const gate = f.depositGate ?? ZERO;
    const phase = PHASES.includes(f.phase as VaultPhase) ? (f.phase as VaultPhase) : "Collecting";
    const last = f.epochs?.[0];
    const stockSymbol = f.stockSymbol ?? "stock";
    const base = {
      chainId: this.chainId,
      vault,
      name: f.name,
      symbol: f.symbol,
      strategy: f.strategy ? { code: f.strategy.code, name: f.strategy.name } : strategyFromNames(f.name, f.symbol, stockSymbol),
      stock: { address: f.stock, symbol: stockSymbol, decimals: 18 as const },
      usdg: f.usdg,
      gate: { address: gate, kind: await this.gateKind(gate) },
      paused: f.paused ?? false,
      depositCapUsdgRaw: BigInt(f.depositCapUsdg),
      totalSharesRaw: BigInt(f.totalSupply),
      stockHeldRaw: BigInt(f.stockHeld),
      usdgHeldRaw: BigInt(f.usdgHeld),
      source: "api" as const,
      feeBps: f.feeBps ?? undefined,
    };
    return assembleInfo(base, {
      phase,
      currentEpoch,
      schedule: sched(currentEpoch),
      next: sched(currentEpoch + 1n),
      livePriceRaw: BigInt(f.price ?? "0"),
      markPriceRaw: BigInt(f.markPrice ?? "0"),
      pendingStock: BigInt(f.pendingStock ?? "0"),
      pendingUsdg: BigInt(f.pendingUsdg ?? "0"),
      reservedStock: BigInt(f.reservedStock ?? "0"),
      reservedUsdg: BigInt(f.reservedUsdg ?? "0"),
      now,
      lastEpoch:
        last && currentEpoch > 1n
          ? { index: currentEpoch - 1n, income: BigInt(last.income), navUsdg: BigInt(last.navUsdg), navPrice: BigInt(last.navPrice ?? "0"), depositStock: BigInt(last.depositStock ?? "0"), depositUsdg: BigInt(last.depositUsdg ?? "0"), settledAt: BigInt(last.settledAt), settlementPrice: 0n }
          : undefined,
    });
  }

  /** The account's position in every fund it touched (shares, queues or claimables), plus the funds it can deposit into. */
  async status(account = this.requireAccount(), opts: { vaults?: Address[] } = {}): Promise<VaultInfo[]> {
    return this.listVaults({ account, vaults: opts.vaults });
  }

  // ---------------------------------------------------------------- writes (dry run by default)

  private requireSigner(): LocalAccount {
    if (!this.signer) throw new Error("no signer configured: vault actions are sent from the owner wallet");
    return this.signer;
  }

  /** Vault calls act on `account`; the contract only lets the account itself or an approved position manager do that. */
  private async authorized(vault: Address, account: Address): Promise<void> {
    const s = this.requireSigner();
    if (s.address.toLowerCase() === account.toLowerCase()) return;
    const ok = await this.publicClient.readContract({ address: vault, abi: epochFundAbi, functionName: "isPositionManager", args: [account, s.address] });
    if (!ok) throw new Error(`the signer ${s.address} is neither the account ${account} nor one of its position managers; sign with the owner key of the account`);
  }

  /**
   * Queue a deposit of USDG and/or stock from the signer's wallet for `receiver` (default: the account): the needed
   * ERC-20 approvals to the fund, then `requestDeposit(stock, usdg, receiver)`. Checks the gate, pause, cap and minimums
   * first so a dry run explains a refusal instead of simulating a revert.
   */
  async planDeposit(req: { vault: Address; usdgRaw?: bigint; stockRaw?: bigint; receiver?: Address }): Promise<VaultPlan> {
    const signer = this.requireSigner();
    const receiver = req.receiver ?? this.requireAccount();
    const usdgRaw = req.usdgRaw ?? 0n;
    const stockRaw = req.stockRaw ?? 0n;
    if (usdgRaw < 0n || stockRaw < 0n || (usdgRaw === 0n && stockRaw === 0n)) throw new RangeError("deposit at least some USDG or stock");
    if (usdgRaw !== 0n && usdgRaw < 1000n) throw new RangeError("USDG deposits must be at least 0.001 USDG (MIN_USDG)");
    if (stockRaw !== 0n && stockRaw < 10n ** 12n) throw new RangeError("stock deposits must be at least 1e-6 share (MIN_STOCK)");
    const pc = this.publicClient;
    const [symbol, stock, usdg, paused, canDeposit, acct, currentEpoch, phaseIdx] = await Promise.all([
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "symbol" }),
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "stock" }),
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "usdg" }),
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "paused" }),
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "canDeposit", args: [receiver] }),
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "getAccount", args: [receiver] }),
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "currentEpoch" }),
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "phase" }),
    ]);
    if (paused) throw new Error(`${symbol} is paused: no new deposits`);
    if (!canDeposit) throw new Error(`${receiver} is not admitted by ${symbol}'s deposit gate (NotEligible)`);
    void acct;
    void currentEpoch;
    void phaseIdx;
    const [usdgBal, stockBal, usdgAllowance, stockAllowance] = await Promise.all([
      usdgRaw ? pc.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] }) : 0n,
      stockRaw ? pc.readContract({ address: stock, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] }) : 0n,
      usdgRaw ? pc.readContract({ address: usdg, abi: erc20Abi, functionName: "allowance", args: [signer.address, req.vault] }) : 0n,
      stockRaw ? pc.readContract({ address: stock, abi: erc20Abi, functionName: "allowance", args: [signer.address, req.vault] }) : 0n,
    ]);
    if (usdgRaw && usdgBal < usdgRaw) throw new Error(`wallet ${signer.address} holds ${formatUsdg(usdgBal)} USDG, less than ${formatUsdg(usdgRaw)}`);
    if (stockRaw && stockBal < stockRaw) throw new Error(`wallet ${signer.address} holds ${formatShares(stockBal)} stock, less than ${formatShares(stockRaw)}`);
    const steps: VaultTxStep[] = [];
    if (usdgRaw && usdgAllowance < usdgRaw) steps.push({ ...encodeApprove(usdg, req.vault, usdgRaw), kind: "approve", simulate: true });
    if (stockRaw && stockAllowance < stockRaw) steps.push({ ...encodeApprove(stock, req.vault, stockRaw), kind: "approve", simulate: true });
    steps.push({
      to: req.vault,
      data: encodeFunctionData({ abi: epochFundAbi, functionName: "requestDeposit", args: [stockRaw, usdgRaw, receiver] }),
      summary: `requestDeposit(${formatShares(stockRaw)} stock, ${formatUsdg(usdgRaw)} USDG, receiver ${receiver}) on ${symbol}`,
      kind: "requestDeposit",
      simulate: steps.length === 0,
    });
    const what = [usdgRaw ? `${formatUsdg(usdgRaw)} USDG` : "", stockRaw ? `${formatShares(stockRaw)} stock` : ""].filter(Boolean).join(" + ");
    return { vault: req.vault, symbol, account: receiver, steps, summary: `deposit ${what} into ${symbol} for ${receiver} (queued until the next freeze)` };
  }

  /** Queue a redemption of `sharesRaw` (or "all") for the account; paid in kind at the cohort's freeze, then claimable. */
  async planRedeem(req: { vault: Address; shares: bigint | string; account?: Address }): Promise<VaultPlan> {
    const account = req.account ?? this.requireAccount();
    await this.authorized(req.vault, account);
    const pc = this.publicClient;
    const [symbol, balance, preview] = await Promise.all([
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "symbol" }),
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "balanceOf", args: [account] }),
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "previewAccount", args: [account] }),
    ]);
    const available = balance + preview[0];
    const sharesRaw = parseVaultShares(req.shares, available);
    if (sharesRaw <= 0n) throw new RangeError(`nothing to redeem: ${account} holds no ${symbol} shares`);
    if (sharesRaw > available) throw new RangeError(`${account} holds ${formatShares(available)} ${symbol}, less than ${formatShares(sharesRaw)}`);
    const step: VaultTxStep = {
      to: req.vault,
      data: encodeFunctionData({ abi: epochFundAbi, functionName: "requestRedeem", args: [sharesRaw, account] }),
      summary: `requestRedeem(${formatShares(sharesRaw)} ${symbol}, ${account})`,
      kind: "requestRedeem",
      simulate: true,
    };
    return { vault: req.vault, symbol, account, steps: [step], summary: `redeem ${formatShares(sharesRaw)} of ${formatShares(available)} ${symbol} (paid in stock + USDG at the next freeze, after the current option expires; then claim)` };
  }

  /** Return the account's queued (not yet frozen) deposit to `to` (default: the signer). */
  async planCancelDeposit(req: { vault: Address; to?: Address; account?: Address }): Promise<VaultPlan> {
    const account = req.account ?? this.requireAccount();
    await this.authorized(req.vault, account);
    const to = req.to ?? this.requireSigner().address;
    const symbol = await this.publicClient.readContract({ address: req.vault, abi: epochFundAbi, functionName: "symbol" });
    const step: VaultTxStep = { to: req.vault, data: encodeFunctionData({ abi: epochFundAbi, functionName: "cancelDeposit", args: [account, to] }), summary: `cancelDeposit(${account}, to ${to}) on ${symbol}`, kind: "cancelDeposit", simulate: true };
    return { vault: req.vault, symbol, account, steps: [step], summary: `cancel the queued deposit of ${account} in ${symbol}, returning it to ${to}` };
  }

  /** Return the account's queued (not yet frozen) redemption to its share balance. */
  async planCancelRedeem(req: { vault: Address; account?: Address }): Promise<VaultPlan> {
    const account = req.account ?? this.requireAccount();
    await this.authorized(req.vault, account);
    const symbol = await this.publicClient.readContract({ address: req.vault, abi: epochFundAbi, functionName: "symbol" });
    const step: VaultTxStep = { to: req.vault, data: encodeFunctionData({ abi: epochFundAbi, functionName: "cancelRedeem", args: [account] }), summary: `cancelRedeem(${account}) on ${symbol}`, kind: "cancelRedeem", simulate: true };
    return { vault: req.vault, symbol, account, steps: [step], summary: `cancel the queued redemption of ${account} in ${symbol}` };
  }

  /** Pay the account's redeemed or refunded stock and USDG to `to` (default: the signer). */
  async planClaim(req: { vault: Address; to?: Address; account?: Address }): Promise<VaultPlan> {
    const account = req.account ?? this.requireAccount();
    await this.authorized(req.vault, account);
    const to = req.to ?? this.requireSigner().address;
    const pc = this.publicClient;
    const [symbol, preview] = await Promise.all([
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "symbol" }),
      pc.readContract({ address: req.vault, abi: epochFundAbi, functionName: "previewAccount", args: [account] }),
    ]);
    const [, stockAmt, usdgAmt] = preview;
    if (stockAmt === 0n && usdgAmt === 0n) throw new Error(`nothing to claim in ${symbol} for ${account} (a queued redemption becomes claimable at its cohort's freeze)`);
    const step: VaultTxStep = { to: req.vault, data: encodeFunctionData({ abi: epochFundAbi, functionName: "claim", args: [account, to] }), summary: `claim(${account}, to ${to}) on ${symbol}: ${formatShares(stockAmt)} stock + ${formatUsdg(usdgAmt)} USDG`, kind: "claim", simulate: true };
    return { vault: req.vault, symbol, account, steps: [step], summary: `claim ${formatShares(stockAmt)} stock + ${formatUsdg(usdgAmt)} USDG from ${symbol} to ${to}` };
  }

  async send(request: TxRequest, opts: { dryRun?: boolean; simulate?: boolean } = {}): Promise<SendResult> {
    return sendTxRequest(this, request, opts);
  }

  async waitForReceipt(hash: Hash) {
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  /**
   * Runs a plan: dry run (default) simulates every step that can be simulated and returns the unsigned transactions;
   * otherwise sends them in order, waiting for each receipt, and stops at the first revert.
   */
  async sendPlan(plan: VaultPlan, opts: { dryRun?: boolean } = {}): Promise<VaultStepResult[]> {
    const dryRun = opts.dryRun ?? true;
    const out: VaultStepResult[] = [];
    for (const step of plan.steps) {
      if (dryRun) {
        out.push({ ...(await this.send(step, { dryRun: true, simulate: step.simulate })), kind: step.kind });
        continue;
      }
      const r = await this.send(step, { dryRun: false });
      const receipt = await this.waitForReceipt(r.hash!);
      out.push({ ...r, kind: step.kind, status: receipt.status, blockNumber: receipt.blockNumber });
      if (receipt.status !== "success") break;
    }
    return out;
  }

  // ---------------------------------------------------------------- one-call conveniences

  async requestDeposit(req: { vault: Address; usdgRaw?: bigint; stockRaw?: bigint; receiver?: Address; dryRun?: boolean }) {
    const plan = await this.planDeposit(req);
    return { plan, results: await this.sendPlan(plan, { dryRun: req.dryRun }) };
  }

  async requestRedeem(req: { vault: Address; shares: bigint | string; account?: Address; dryRun?: boolean }) {
    const plan = await this.planRedeem(req);
    return { plan, results: await this.sendPlan(plan, { dryRun: req.dryRun }) };
  }

  async cancelDeposit(req: { vault: Address; to?: Address; account?: Address; dryRun?: boolean }) {
    const plan = await this.planCancelDeposit(req);
    return { plan, results: await this.sendPlan(plan, { dryRun: req.dryRun }) };
  }

  async cancelRedeem(req: { vault: Address; account?: Address; dryRun?: boolean }) {
    const plan = await this.planCancelRedeem(req);
    return { plan, results: await this.sendPlan(plan, { dryRun: req.dryRun }) };
  }

  async claim(req: { vault: Address; to?: Address; account?: Address; dryRun?: boolean }) {
    const plan = await this.planClaim(req);
    return { plan, results: await this.sendPlan(plan, { dryRun: req.dryRun }) };
  }
}

interface EpochInputs {
  phase: VaultPhase;
  currentEpoch: bigint;
  schedule: VaultSchedule;
  next: VaultSchedule;
  livePriceRaw: bigint;
  markPriceRaw: bigint;
  pendingStock: bigint;
  pendingUsdg: bigint;
  reservedStock: bigint;
  reservedUsdg: bigint;
  now: bigint;
  lastEpoch?: { index: bigint; income: bigint; navUsdg: bigint; navPrice: bigint; depositStock: bigint; depositUsdg: bigint; settledAt: bigint; settlementPrice: bigint };
}

/** The derived fields (nav, epoch state, cap use, last epoch yield) shared by the chain and API paths. */
function assembleInfo(base: Omit<VaultInfo, "nav" | "epoch" | "capUsedUsdgRaw" | "lastEpoch" | "my">, e: EpochInputs): VaultInfo {
  const priceRaw = e.livePriceRaw !== 0n ? e.livePriceRaw : e.markPriceRaw;
  const navUsdgRaw = (base.stockHeldRaw * priceRaw) / VALUE_SCALE + base.usdgHeldRaw;
  const nav: VaultNav = { navUsdgRaw, priceRaw, source: e.livePriceRaw !== 0n ? "live" : priceRaw !== 0n ? "mark" : "none" };
  const per = navPerShareRaw(base.stockHeldRaw, base.usdgHeldRaw, priceRaw, base.totalSharesRaw);
  if (per !== undefined) nav.usdgPerShareRaw = per;
  const state = epochState(e.phase, e.schedule, e.now);
  let nextCohort = state === "open" ? e.currentEpoch : e.currentEpoch + 1n;
  let cohortSchedule = nextCohort === e.currentEpoch ? e.schedule : e.next;
  if (nextCohort === e.currentEpoch + 1n && e.next.depositCutoff !== 0n && e.now >= e.next.depositCutoff) {
    nextCohort += 1n; // the next epoch's cutoff passed too (freeze overdue); the cohort after it is unknown
    cohortSchedule = { depositCutoff: 0n, tradeStart: 0n, tradeEnd: 0n, expiry: 0n, maxDeviationBps: 0 };
  }
  const epoch: VaultEpochInfo = { index: e.currentEpoch, phase: e.phase, state, schedule: e.schedule, nextCohort };
  if (cohortSchedule.depositCutoff !== 0n) epoch.nextFreezeAt = cohortSchedule.depositCutoff;
  if (e.schedule.expiry !== 0n) epoch.nextSettleAt = e.schedule.expiry;
  const capUsedUsdgRaw = ((base.stockHeldRaw + e.pendingStock + e.reservedStock) * priceRaw) / VALUE_SCALE + base.usdgHeldRaw + e.pendingUsdg + e.reservedUsdg;
  const info: VaultInfo = { ...base, nav, epoch, capUsedUsdgRaw };
  if (e.lastEpoch && e.lastEpoch.settledAt !== 0n) {
    const l = e.lastEpoch;
    const navAtFreeze = l.navUsdg + (l.depositStock * l.navPrice) / VALUE_SCALE + l.depositUsdg;
    info.lastEpoch = { index: l.index, incomeUsdgRaw: l.income, navAtFreezeUsdgRaw: navAtFreeze, settledAt: l.settledAt, settlementPriceRaw: l.settlementPrice };
    if (navAtFreeze > 0n) info.lastEpoch.weeklyYieldBps = Number((l.income * 10_000n) / navAtFreeze);
  }
  return info;
}
