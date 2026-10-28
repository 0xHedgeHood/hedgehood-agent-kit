import { createPublicClient, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, http, keccak256, type Address, type Chain, type Hash, type Hex, type PublicClient, type Transport } from "viem";
import type { LocalAccount } from "viem/accounts";
import { adaptiveCurveIrmAbi } from "./abi/adaptiveCurveIrm.js";
import { erc20Abi } from "./abi/erc20.js";
import { morphoBlueAbi } from "./abi/morphoBlue.js";
import { morphoMarketV1AdapterV2Abi } from "./abi/morphoMarketV1AdapterV2.js";
import { shareRiskOracleAbi } from "./abi/shareRiskOracle.js";
import { vaultV2Abi } from "./abi/vaultV2.js";
import { encodeApprove, type TxRequest } from "./calldata.js";
import { chains, getLending, type LendingDeployment, type LendingMarket } from "./chains.js";
import { sendPlan, sendTxRequest, type PlanStep, type PlanStepResult, type SendResult } from "./send.js";
import { formatShares, formatUsdg } from "./units.js";
import { parseVaultShares } from "./vault.js";

/**
 * Share lending: Hedgehood's USDG lending vault ("hhUSDG", a Morpho Vault V2, ERC-4626) and the Morpho Blue market
 * where Stock Yield fund shares (`hhNVDA-CC`) are collateral for USDG loans. Both sides are instant (no epochs):
 *
 * - LEND: `deposit` USDG into the vault and `withdraw` / `redeem` any time there is liquidity; interest accrues every
 *   second from the market's borrowers, less the vault's performance fee. The vault's curator caps what it supplies.
 * - BORROW: `supplyCollateral` fund shares, `borrow` USDG up to the LLTV (62.5%) of the oracle's share value, `repay`,
 *   `withdrawCollateral`. Below health factor 1 the position can be liquidated by anyone. The collateral oracle is a
 *   `ShareRiskOracle`: a conservative share value, marked once a week after the Monday lock; with no usable price it
 *   reverts, which freezes borrow, withdrawCollateral and liquidate until a price exists (repay and supply still work).
 *
 * The market is discovered from the vault (`liquidityAdapter` / `liquidityData`, the adapter's `marketIds`) and only
 * falls back to the deployment registry, because a new oracle means a new market id (a migration is scheduled on
 * mainnet). Contract sources: hedgehood-vaults `contracts/src/collateral/` (ShareRiskOracle, lens), morpho-org
 * morpho-blue 8e26ca6, vault-v2 10ed1ea. All writes are the owner wallet's own calls, dry run by default.
 */

export const WAD = 10n ** 18n;
export const ORACLE_PRICE_SCALE = 10n ** 36n;
/** Blue's virtual shares / assets (SharesMathLib). */
export const VIRTUAL_SHARES = 10n ** 6n;
export const VIRTUAL_ASSETS = 1n;
const SECONDS_PER_YEAR = 365n * 86400n;
/** The skill's rule: keep the loan-to-value at or below this fraction of the LLTV. */
export const LTV_WARN_FRACTION = 0.7;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** 1e36 price = USDG raw (6d) per 1e18 share raw * 1e36 / 1e18: USDG raw per whole share = price / 1e18. */
const PRICE_TO_USDG_PER_SHARE = 10n ** 18n;

const marketParamsAbi = [
  {
    type: "tuple",
    components: [
      { name: "loanToken", type: "address" },
      { name: "collateralToken", type: "address" },
      { name: "oracle", type: "address" },
      { name: "irm", type: "address" },
      { name: "lltv", type: "uint256" },
    ],
  },
] as const;

export interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

/** Blue's `market(id)` row. */
export interface BlueMarketState {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
}

export type OracleState = "live" | "held" | "unavailable";

/** What the collateral oracle says right now, from the ShareRiskOracle's views. */
export interface OracleStatus {
  address: Address;
  /** live: the fund's own price answers; held: the feed's last print, held or decayed (market closed); unavailable: `price()` reverts (fail-closed) — borrow, withdrawCollateral and liquidate are frozen. */
  state: OracleState;
  /** Blue price (1e36 scale), when available. */
  priceRaw?: bigint;
  /** USDG raw (6 decimals) per whole share at that price. */
  collateralPriceUsdgRaw?: bigint;
  /** Stock price in use, 18 decimals USD (ShareRiskOracle only). */
  spotRaw?: bigint;
  /** Conservative share-owned value, open-call liabilities (USDG raw; ShareRiskOracle only). */
  navRaw?: bigint;
  liabilitiesRaw?: bigint;
  error?: string;
}

export interface DiscoveredMarkets {
  /** vault: read from the lending vault's liquidity adapter and allocations; config: the deployment registry (the vault was unreadable). */
  source: "vault" | "config";
  adapter?: Address;
  /** The market new vault deposits are supplied to: the default market for every borrow tool. */
  liquidityMarketId?: Hex;
  markets: LendingMarket[];
}

export interface BorrowMarketView extends LendingMarket {
  /** Blue price (1e36), null while the oracle is unavailable. */
  oraclePriceRaw: bigint | null;
  collateralPriceUsdgRaw: bigint | null;
  oracleStatus: OracleStatus;
  /** Borrow rate per second, WAD (the IRM's `borrowRateView` on the current state). */
  borrowRatePerSecondRaw: bigint;
  /** Simple annualized borrow rate as a fraction (0.0098 = 0.98% APR; Blue compounds per interaction). */
  borrowRate: number;
  /** totalBorrow / totalSupply, null with no supply. */
  utilization: number | null;
  totalSupplyRaw: bigint;
  totalBorrowRaw: bigint;
  /** Unborrowed liquidity, USDG raw. */
  available: bigint;
  /** Blue's protocol fee on interest, WAD. */
  feeRaw: bigint;
  /** True when this is the market the vault currently supplies. */
  isLiquidityMarket: boolean;
  /** Interest accrued to `asOf` (chain time), not the last on-chain update. */
  asOf: bigint;
}

export interface BorrowPosition {
  account: Address;
  collateralRaw: bigint;
  borrowAssetsRaw: bigint;
  borrowSharesRaw: bigint;
  /** Collateral at the oracle price, USDG raw; null while the oracle is unavailable. */
  collateralValueRaw: bigint | null;
  /** collateralValue * LLTV: the debt at which health factor is 1. */
  maxBorrowRaw: bigint | null;
  /** What can still be borrowed up to the LLTV (0 when at or above it). */
  borrowableRaw: bigint | null;
  /** What can still be borrowed while staying at LTV <= 70% of LLTV. */
  recommendedBorrowableRaw: bigint | null;
  /** maxBorrow / debt; null with no debt (infinite) or no price. */
  healthFactor: number | null;
  /** Debt / collateral value; null with no collateral or no price. */
  ltv: number | null;
  /** Oracle price (1e36) at which the position becomes liquidatable; null with no debt or no collateral. */
  liquidationPriceRaw: bigint | null;
  /** The same in USDG raw per whole share. */
  liquidationPriceUsdgRaw: bigint | null;
  walletSharesRaw: bigint;
  walletUsdgRaw: bigint;
}

export interface BorrowStatus {
  chainId: number;
  blue: Address;
  discovery: DiscoveredMarkets["source"];
  market: BorrowMarketView;
  my: BorrowPosition;
  warnings: string[];
}

export interface LendStatus {
  chainId: number;
  vault: Address;
  name: string;
  symbol: string;
  asset: Address;
  discovery: DiscoveredMarkets["source"];
  totalAssetsRaw: bigint;
  /** USDG sitting in the vault, not supplied to a market. */
  idleRaw: bigint;
  /** Supplied to the liquidity market (the adapter's expected supply assets). */
  allocatedRaw: bigint;
  /** The vault's absolute cap on the liquidity market, USDG raw. */
  capRaw: bigint;
  /** Room left under the tightest of the market's caps (adapter, collateral token, market). */
  capLeftRaw: bigint;
  /** Withdrawable right now: idle + the market's unborrowed liquidity (bounded by the allocation). */
  liquidityRaw: bigint;
  /** Of the liquidity market. */
  utilization: number | null;
  /** Simple annualized supply rate as a fraction after the vault's performance fee, or null with a note. */
  supplyApy: number | null;
  supplyApyNote?: string;
  /** Performance fee as a fraction (0.1 = 10% of interest). */
  performanceFee: number;
  /** The vault's maxRate (per second, WAD): the share price never grows faster than this. */
  maxRatePerSecondRaw: bigint;
  market?: BorrowMarketView;
  oracle?: OracleStatus;
  my?: {
    account: Address;
    sharesRaw: bigint;
    /** `previewRedeem(shares)`: what the shares are worth now, USDG raw. */
    assetsRaw: bigint;
    walletUsdgRaw: bigint;
    canDeposit: boolean;
    canWithdraw: boolean;
  };
}

export type LendingStepKind = "approve" | "deposit" | "withdraw" | "redeem" | "supplyCollateral" | "borrow" | "repay" | "withdrawCollateral";

export interface LendingTxStep extends PlanStep {
  kind: LendingStepKind;
}

export interface LendingPlan {
  action: "lendDeposit" | "lendWithdraw" | "supplyCollateral" | "borrow" | "repay" | "withdrawCollateral";
  account: Address;
  market?: LendingMarket;
  steps: LendingTxStep[];
  summary: string;
  /** Things the agent should tell the user (high LTV, oracle held, thin liquidity). The plan still runs. */
  warnings: string[];
  /** The borrow position after the action, at today's oracle price (borrow-side plans). */
  after?: { collateralRaw: bigint; borrowAssetsRaw: bigint; healthFactor: number | null; ltv: number | null; liquidationPriceUsdgRaw: bigint | null };
}

export type LendingStepResult = PlanStepResult<LendingStepKind>;

export interface LendingClientOptions {
  chainId: number;
  rpcUrl?: string;
  /** The account whose vault shares and Blue position are read and acted on; defaults to the signer's address. */
  account?: Address;
  /** The owner wallet: it holds the USDG and the fund shares. A market session key cannot act here. */
  signer?: LocalAccount;
  deployment?: LendingDeployment;
  fetch?: typeof fetch;
}

// ---------------------------------------------------------------- Blue math (SharesMathLib, MathLib, MorphoBalancesLib)

const mulDivDown = (x: bigint, y: bigint, d: bigint) => (x * y) / d;
const mulDivUp = (x: bigint, y: bigint, d: bigint) => (x * y + d - 1n) / d;
const wMulDown = (x: bigint, y: bigint) => mulDivDown(x, y, WAD);

export function toSharesDown(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
}
export function toAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}
export function toSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
}
export function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}

/** Blue's `wTaylorCompounded`: the continuous-compounding approximation used for interest accrual. */
export function wTaylorCompounded(ratePerSecond: bigint, elapsed: bigint): bigint {
  const first = ratePerSecond * elapsed;
  const second = mulDivDown(first, first, 2n * WAD);
  const third = mulDivDown(second, first, 3n * WAD);
  return first + second + third;
}

/** The market totals as Blue's `accrueInterest` would leave them at `now` (MorphoBalancesLib.expectedMarketBalances). */
export function accrueInterestView(m: BlueMarketState, borrowRatePerSecond: bigint, now: bigint): BlueMarketState {
  const elapsed = now > m.lastUpdate ? now - m.lastUpdate : 0n;
  if (elapsed === 0n || m.totalBorrowAssets === 0n) return { ...m, lastUpdate: now };
  const interest = wMulDown(m.totalBorrowAssets, wTaylorCompounded(borrowRatePerSecond, elapsed));
  const out: BlueMarketState = { ...m, totalBorrowAssets: m.totalBorrowAssets + interest, totalSupplyAssets: m.totalSupplyAssets + interest, lastUpdate: now };
  if (m.fee !== 0n) {
    const feeAmount = wMulDown(interest, m.fee);
    out.totalSupplyShares += toSharesDown(feeAmount, out.totalSupplyAssets - feeAmount, m.totalSupplyShares);
  }
  return out;
}

/** `keccak256(abi.encode(marketParams))`: Blue's market id. */
export function marketIdOf(p: MarketParams): Hex {
  return keccak256(encodeAbiParameters(marketParamsAbi, [p]));
}

/** Collateral in loan units at a Blue price: `collateral * price / 1e36`. */
export function collateralValueRaw(collateralRaw: bigint, priceRaw: bigint): bigint {
  return mulDivDown(collateralRaw, priceRaw, ORACLE_PRICE_SCALE);
}

/** Blue's `_isHealthy` bound: the debt at which the position becomes liquidatable. */
export function maxBorrowRaw(collateralRaw: bigint, priceRaw: bigint, lltv: bigint): bigint {
  return wMulDown(collateralValueRaw(collateralRaw, priceRaw), lltv);
}

/** Debt in assets from borrow shares, rounded up as Blue does for health checks. */
export function borrowAssetsOf(borrowShares: bigint, m: BlueMarketState): bigint {
  return toAssetsUp(borrowShares, m.totalBorrowAssets, m.totalBorrowShares);
}

const ratio = (num: bigint, den: bigint, digits = 6): number => Number((num * 10n ** BigInt(digits)) / den) / 10 ** digits;

/** maxBorrow / debt (4 decimals); null with no debt. */
export function healthFactor(maxBorrow: bigint, debtRaw: bigint): number | null {
  return debtRaw === 0n ? null : ratio(maxBorrow, debtRaw, 4);
}

/** debt / collateral value (4 decimals); null with no collateral value. */
export function loanToValue(debtRaw: bigint, collateralValue: bigint): number | null {
  return collateralValue === 0n ? null : ratio(debtRaw, collateralValue, 4);
}

/** The Blue price (1e36) at which health factor reaches 1: `debt * 1e36 * WAD / (collateral * lltv)`, rounded up. */
export function liquidationPriceRaw(collateralRaw: bigint, debtRaw: bigint, lltv: bigint): bigint | null {
  if (collateralRaw === 0n || debtRaw === 0n) return null;
  return mulDivUp(debtRaw * ORACLE_PRICE_SCALE, WAD, collateralRaw * lltv);
}

/** Whether `debt` against `collateralValue` is above the skill's comfort line (LTV > 70% of LLTV). */
export function aboveLtvWarnLine(debtRaw: bigint, collateralValue: bigint, lltv: bigint): boolean {
  if (collateralValue === 0n) return debtRaw > 0n;
  return debtRaw * WAD * 10n > collateralValue * lltv * BigInt(Math.round(LTV_WARN_FRACTION * 10));
}

/** Per-second WAD rate -> simple annual fraction. */
export function annualize(ratePerSecond: bigint): number {
  return Number(ratePerSecond * SECONDS_PER_YEAR) / 1e18;
}

const pct = (x: number | null) => (x === null ? "-" : `${(x * 100).toFixed(2)}%`);
const usdgPerShare = (priceRaw: bigint) => priceRaw / PRICE_TO_USDG_PER_SHARE;

/** Read and write helpers for share lending on one chain. Every write defaults to a dry run. */
export class LendingClient {
  readonly chainId: number;
  readonly chain: Chain;
  readonly deployment: LendingDeployment;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly signer?: LocalAccount;
  readonly account: Address | undefined;
  readonly rpcUrl: string;
  readonly fetch?: typeof fetch;
  private discovered?: { at: number; value: DiscoveredMarkets };

  constructor(opts: LendingClientOptions) {
    this.chainId = opts.chainId;
    const chain = chains[opts.chainId];
    if (!chain) throw new Error(`unsupported chain id ${opts.chainId}`);
    this.chain = chain;
    this.deployment = opts.deployment ?? getLending(opts.chainId);
    this.rpcUrl = opts.rpcUrl ?? chain.rpcUrls.default.http[0]!;
    this.fetch = opts.fetch;
    this.publicClient = createPublicClient({ chain, transport: http(this.rpcUrl, opts.fetch ? { fetchFn: opts.fetch } : {}) });
    this.signer = opts.signer;
    this.account = opts.account ?? opts.signer?.address;
  }

  get blue(): Address {
    return this.deployment.blue;
  }
  get vault(): Address {
    return this.deployment.vault;
  }
  get usdg(): Address {
    return this.deployment.usdg;
  }

  private requireAccount(): Address {
    if (!this.account) throw new Error("no account configured (pass `account` or a signer)");
    return this.account;
  }

  private requireSigner(): LocalAccount {
    if (!this.signer) throw new Error("no signer configured: lending actions are sent from the owner wallet");
    return this.signer;
  }

  async chainTime(): Promise<bigint> {
    return (await this.publicClient.getBlock()).timestamp;
  }

  // ---------------------------------------------------------------- discovery

  /**
   * The markets the lending vault supplies, read from the chain: the vault's liquidity adapter + data name the market
   * new deposits go to; the adapter's `marketIds` list every market with an allocation. Falls back to the deployment
   * registry when the vault cannot be read. Cached for 30 s per client.
   */
  async discoverMarkets(): Promise<DiscoveredMarkets> {
    if (this.discovered && Date.now() - this.discovered.at < 30_000) return this.discovered.value;
    const value = await this.readMarkets();
    this.discovered = { at: Date.now(), value };
    return value;
  }

  private async readMarkets(): Promise<DiscoveredMarkets> {
    const pc = this.publicClient;
    const configured = this.deployment.markets;
    try {
      const [adapter, data] = await Promise.all([
        pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "liquidityAdapter" }),
        pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "liquidityData" }),
      ]);
      const found = new Map<string, LendingMarket>();
      let liquidityMarketId: Hex | undefined;
      if (adapter !== ZERO && data && data.length >= 2 + 5 * 64) {
        const [p] = decodeAbiParameters(marketParamsAbi, data);
        const params: MarketParams = { loanToken: p.loanToken, collateralToken: p.collateralToken, oracle: p.oracle, irm: p.irm, lltv: p.lltv };
        liquidityMarketId = marketIdOf(params);
        found.set(liquidityMarketId.toLowerCase(), { id: liquidityMarketId, ...params, note: "the vault's liquidity market (read from the vault)" });
      }
      if (adapter !== ZERO) {
        const n = await pc.readContract({ address: adapter, abi: morphoMarketV1AdapterV2Abi, functionName: "marketIdsLength" });
        const ids = await Promise.all(Array.from({ length: Number(n) }, (_, i) => pc.readContract({ address: adapter, abi: morphoMarketV1AdapterV2Abi, functionName: "marketIds", args: [BigInt(i)] })));
        for (const id of ids) {
          if (found.has(id.toLowerCase())) continue;
          const [loanToken, collateralToken, oracle, irm, lltv] = await pc.readContract({ address: this.blue, abi: morphoBlueAbi, functionName: "idToMarketParams", args: [id] });
          found.set(id.toLowerCase(), { id, loanToken, collateralToken, oracle, irm, lltv, note: "allocated by the vault's adapter (read from the vault)" });
        }
      }
      if (found.size === 0) throw new Error("the vault names no market");
      for (const m of configured) if (!found.has(m.id.toLowerCase())) found.set(m.id.toLowerCase(), { ...m, note: `${m.note ? m.note + "; " : ""}from the deployment registry, not currently supplied by the vault` });
      return { source: "vault", adapter: adapter === ZERO ? undefined : adapter, liquidityMarketId, markets: [...found.values()] };
    } catch {
      return { source: "config", adapter: this.deployment.adapter, liquidityMarketId: configured[0]?.id, markets: configured };
    }
  }

  /** A market by id, or the default (the vault's liquidity market, else the first known). */
  async resolveMarket(ref?: string): Promise<{ market: LendingMarket; discovery: DiscoveredMarkets }> {
    const discovery = await this.discoverMarkets();
    if (!ref) {
      const m = discovery.markets.find((x) => x.id.toLowerCase() === discovery.liquidityMarketId?.toLowerCase()) ?? discovery.markets[0];
      if (!m) throw new Error(`no share lending market known on chain ${this.chainId}`);
      return { market: m, discovery };
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(ref)) throw new Error(`a market is its 32-byte id (0x…), got ${ref}`);
    const known = discovery.markets.find((x) => x.id.toLowerCase() === ref.toLowerCase());
    if (known) return { market: known, discovery };
    // not known to the vault or the registry: ask Blue
    const [loanToken, collateralToken, oracle, irm, lltv] = await this.publicClient.readContract({ address: this.blue, abi: morphoBlueAbi, functionName: "idToMarketParams", args: [ref as Hex] });
    if (loanToken === ZERO && collateralToken === ZERO && lltv === 0n) throw new Error(`market ${ref} does not exist on Blue ${this.blue} (chain ${this.chainId})`);
    return { market: { id: ref as Hex, loanToken, collateralToken, oracle, irm, lltv, note: "unknown to the vault and the registry: read from Blue; check it before using it" }, discovery };
  }

  // ---------------------------------------------------------------- reads

  private params(m: LendingMarket): MarketParams {
    return { loanToken: m.loanToken, collateralToken: m.collateralToken, oracle: m.oracle, irm: m.irm, lltv: m.lltv };
  }

  async blueMarket(id: Hex): Promise<BlueMarketState> {
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = await this.publicClient.readContract({ address: this.blue, abi: morphoBlueAbi, functionName: "market", args: [id] });
    return { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee };
  }

  /** The oracle's state from the ShareRiskOracle views; a plain IOracle is read with `price()` only. */
  async oracleStatus(oracle: Address): Promise<OracleStatus> {
    const pc = this.publicClient;
    const out: OracleStatus = { address: oracle, state: "unavailable" };
    try {
      const priceRaw = await pc.readContract({ address: oracle, abi: shareRiskOracleAbi, functionName: "price" });
      out.priceRaw = priceRaw;
      out.collateralPriceUsdgRaw = usdgPerShare(priceRaw);
      out.state = "live";
    } catch (e) {
      out.error = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);
      return out;
    }
    try {
      const [[spot, live], [nav, , liabilities]] = await Promise.all([
        pc.readContract({ address: oracle, abi: shareRiskOracleAbi, functionName: "spot" }),
        pc.readContract({ address: oracle, abi: shareRiskOracleAbi, functionName: "valuation" }),
      ]);
      out.spotRaw = spot;
      out.navRaw = nav;
      out.liabilitiesRaw = liabilities;
      out.state = live ? "live" : "held";
    } catch {
      /* not a ShareRiskOracle: price() answered, that is all we know */
    }
    return out;
  }

  /** The accrued totals behind a view (the share counts the view does not carry), for exact debt math. */
  private totals = new WeakMap<BorrowMarketView, BlueMarketState>();
  private totalsFor(view: BorrowMarketView): BlueMarketState {
    return this.totals.get(view) ?? { totalSupplyAssets: view.totalSupplyRaw, totalSupplyShares: 0n, totalBorrowAssets: view.totalBorrowRaw, totalBorrowShares: 0n, lastUpdate: view.asOf, fee: view.feeRaw };
  }

  /** The market with interest accrued to now, its rate, utilization, liquidity and oracle state, plus the accrued totals. */
  async marketAndTotals(market: LendingMarket, ctx: { now?: bigint; liquidityMarketId?: Hex } = {}): Promise<{ view: BorrowMarketView; totals: BlueMarketState }> {
    const now = ctx.now ?? (await this.chainTime());
    const stored = await this.blueMarket(market.id);
    const rate = market.irm === ZERO ? 0n : await this.publicClient.readContract({ address: market.irm, abi: adaptiveCurveIrmAbi, functionName: "borrowRateView", args: [this.params(market), stored] }).catch(() => 0n);
    const totals = accrueInterestView(stored, rate, now);
    const oracleStatus = await this.oracleStatus(market.oracle);
    const view: BorrowMarketView = {
      ...market,
      oraclePriceRaw: oracleStatus.priceRaw ?? null,
      collateralPriceUsdgRaw: oracleStatus.collateralPriceUsdgRaw ?? null,
      oracleStatus,
      borrowRatePerSecondRaw: rate,
      borrowRate: annualize(rate),
      utilization: totals.totalSupplyAssets === 0n ? null : ratio(totals.totalBorrowAssets, totals.totalSupplyAssets),
      totalSupplyRaw: totals.totalSupplyAssets,
      totalBorrowRaw: totals.totalBorrowAssets,
      available: totals.totalSupplyAssets > totals.totalBorrowAssets ? totals.totalSupplyAssets - totals.totalBorrowAssets : 0n,
      feeRaw: totals.fee,
      isLiquidityMarket: !!ctx.liquidityMarketId && ctx.liquidityMarketId.toLowerCase() === market.id.toLowerCase(),
      asOf: now,
    };
    this.totals.set(view, totals);
    return { view, totals };
  }

  private async rawPosition(marketId: Hex, account: Address) {
    const [, borrowShares, collateral] = await this.publicClient.readContract({ address: this.blue, abi: morphoBlueAbi, functionName: "position", args: [marketId, account] });
    return { borrowShares, collateral };
  }

  private async wallets(account: Address, shareToken: Address) {
    const [sharesRaw, usdgRaw] = await Promise.all([
      this.publicClient.readContract({ address: shareToken, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      this.publicClient.readContract({ address: this.usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    ]);
    return { sharesRaw, usdgRaw };
  }

  /** The borrow side: the market (default: the vault's liquidity market) and the account's position in it. */
  async borrowStatus(account = this.requireAccount(), marketId?: string): Promise<BorrowStatus> {
    const { market, discovery } = await this.resolveMarket(marketId);
    const [{ view, totals }, pos, wallet] = await Promise.all([this.marketAndTotals(market, { liquidityMarketId: discovery.liquidityMarketId }), this.rawPosition(market.id, account), this.wallets(account, market.collateralToken)]);
    const my = derivePosition(account, view, pos.collateral, pos.borrowShares, totals, wallet);
    const warnings: string[] = [];
    if (view.oracleStatus.state === "unavailable") warnings.push(`the collateral oracle ${market.oracle} has no usable price (${view.oracleStatus.error ?? "reverts"}): borrow, withdrawCollateral and liquidate are frozen until it answers; repay and supplyCollateral still work`);
    else if (view.oracleStatus.state === "held") warnings.push("the stock market is closed: the oracle holds the feed's last print (it decays after a long outage in trading hours)");
    if (my.healthFactor !== null && my.healthFactor < 1) warnings.push(`health factor ${my.healthFactor} < 1: the position can be liquidated now; repay or add collateral`);
    else if (my.collateralValueRaw !== null && aboveLtvWarnLine(my.borrowAssetsRaw, my.collateralValueRaw, market.lltv)) warnings.push(`LTV ${pct(my.ltv)} is above ${LTV_WARN_FRACTION * 100}% of the LLTV (${pct(Number(market.lltv) / 1e18)}): a weekly mark or a stock drop can liquidate it; repay or add collateral`);
    if (discovery.source === "config") warnings.push("the lending vault could not be read: market taken from the deployment registry; it may have migrated");
    return { chainId: this.chainId, blue: this.blue, discovery: discovery.source, market: view, my, warnings };
  }

  /** The lend side: the vault's size, caps, liquidity and rate, and the account's shares. */
  async lendStatus(account: Address | null | undefined = this.account): Promise<LendStatus> {
    const pc = this.publicClient;
    const discovery = await this.discoverMarkets();
    const [name, symbol, asset, totalAssetsRaw, performanceFeeRaw, maxRatePerSecondRaw, idleRaw, now] = await Promise.all([
      pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "name" }),
      pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "symbol" }),
      pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "asset" }),
      pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "totalAssets" }),
      pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "performanceFee" }),
      pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "maxRate" }),
      pc.readContract({ address: this.usdg, abi: erc20Abi, functionName: "balanceOf", args: [this.vault] }),
      this.chainTime(),
    ]);
    const performanceFee = Number(performanceFeeRaw) / 1e18;
    const out: LendStatus = {
      chainId: this.chainId,
      vault: this.vault,
      name,
      symbol,
      asset,
      discovery: discovery.source,
      totalAssetsRaw,
      idleRaw,
      allocatedRaw: 0n,
      capRaw: 0n,
      capLeftRaw: 0n,
      liquidityRaw: idleRaw,
      utilization: null,
      supplyApy: null,
      performanceFee,
      maxRatePerSecondRaw: BigInt(maxRatePerSecondRaw),
    };
    const liq = discovery.liquidityMarketId ? discovery.markets.find((m) => m.id.toLowerCase() === discovery.liquidityMarketId!.toLowerCase()) : undefined;
    if (liq && discovery.adapter) {
      const adapter = discovery.adapter;
      const p = this.params(liq);
      const idAdapter = keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }], ["this", adapter]));
      const idCollateral = keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }], ["collateralToken", liq.collateralToken]));
      const idMarket = keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }, ...marketParamsAbi], ["this/marketParams", adapter, p]));
      const [{ view }, allocated, caps, allocs] = await Promise.all([
        this.marketAndTotals(liq, { now, liquidityMarketId: liq.id }),
        pc.readContract({ address: adapter, abi: morphoMarketV1AdapterV2Abi, functionName: "expectedSupplyAssets", args: [liq.id] }).catch(() => 0n),
        Promise.all([idAdapter, idCollateral, idMarket].map((id) => pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "absoluteCap", args: [id] }))),
        Promise.all([idAdapter, idCollateral, idMarket].map((id) => pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "allocation", args: [id] }))),
      ]);
      out.market = view;
      out.oracle = view.oracleStatus;
      out.allocatedRaw = allocated;
      out.capRaw = caps[2]!;
      out.capLeftRaw = caps.reduce((min, cap, i) => {
        const left = cap > allocs[i]! ? cap - allocs[i]! : 0n;
        return left < min ? left : min;
      }, caps[2]! > allocs[2]! ? caps[2]! - allocs[2]! : 0n);
      out.liquidityRaw = idleRaw + (view.available < allocated ? view.available : allocated);
      out.utilization = view.utilization;
      if (view.utilization !== null && totalAssetsRaw > 0n) {
        // supply rate = borrow rate x utilization x (1 - Blue fee), earned on the allocated part, after the performance fee
        const gross = view.borrowRate * view.utilization * (1 - Number(view.feeRaw) / 1e18) * (Number(allocated) / Number(totalAssetsRaw));
        const net = gross * (1 - performanceFee);
        const cap = annualize(BigInt(maxRatePerSecondRaw));
        out.supplyApy = Math.min(net, cap);
        out.supplyApyNote = `borrow rate ${pct(view.borrowRate)} x utilization ${pct(view.utilization)} x allocated share ${pct(Number(allocated) / Number(totalAssetsRaw))} x (1 - ${pct(performanceFee)} fee)${net > cap ? `, capped by the vault's maxRate ${pct(cap)}` : ""}; simple annualized, not compounded`;
      } else {
        out.supplyApyNote = "no borrowers: nothing accrues until someone borrows against fund shares";
      }
    } else {
      out.supplyApyNote = "the vault names no liquidity market; rate unknown";
    }
    if (account) {
      const [sharesRaw, walletUsdgRaw, canDeposit, canWithdraw] = await Promise.all([
        pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "balanceOf", args: [account] }),
        pc.readContract({ address: this.usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "canReceiveShares", args: [account] }).catch(() => true),
        pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "canSendShares", args: [account] }).catch(() => true),
      ]);
      const assetsRaw = sharesRaw === 0n ? 0n : await pc.readContract({ address: this.vault, abi: vaultV2Abi, functionName: "previewRedeem", args: [sharesRaw] });
      out.my = { account, sharesRaw, assetsRaw, walletUsdgRaw, canDeposit, canWithdraw };
    }
    return out;
  }

  // ---------------------------------------------------------------- lend plans (owner wallet, dry run by default)

  /** Approve the vault for the shortfall, then `deposit(assets, receiver)`. Checks the wallet, the gate and the caps first. */
  async planLendDeposit(req: { usdgRaw: bigint; receiver?: Address }): Promise<LendingPlan> {
    const signer = this.requireSigner();
    const receiver = req.receiver ?? this.requireAccount();
    if (req.usdgRaw <= 0n) throw new RangeError("deposit a positive USDG amount");
    const pc = this.publicClient;
    const [status, bal, allowance] = await Promise.all([
      this.lendStatus(receiver),
      pc.readContract({ address: this.usdg, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] }),
      pc.readContract({ address: this.usdg, abi: erc20Abi, functionName: "allowance", args: [signer.address, this.vault] }),
    ]);
    if (bal < req.usdgRaw) throw new Error(`wallet ${signer.address} holds ${formatUsdg(bal)} USDG, less than ${formatUsdg(req.usdgRaw)}`);
    if (status.my && !status.my.canDeposit) throw new Error(`${receiver} may not receive ${status.symbol} shares (the vault's receive-shares gate refuses it)`);
    if (status.market && req.usdgRaw > status.capLeftRaw) throw new Error(`the vault's cap leaves room for ${formatUsdg(status.capLeftRaw)} USDG (cap ${formatUsdg(status.capRaw)}, allocated ${formatUsdg(status.allocatedRaw)}); deposit at most that`);
    const warnings: string[] = [];
    if (!status.market) warnings.push("the vault names no liquidity market: the deposit stays idle and earns nothing until the curator allocates it");
    else if (status.supplyApy !== null && status.supplyApy === 0) warnings.push("no borrowers right now: the deposit earns nothing until someone borrows");
    const steps: LendingTxStep[] = [];
    if (allowance < req.usdgRaw) steps.push({ ...encodeApprove(this.usdg, this.vault, req.usdgRaw), kind: "approve", simulate: true });
    steps.push({ to: this.vault, data: encodeFunctionData({ abi: vaultV2Abi, functionName: "deposit", args: [req.usdgRaw, receiver] }), summary: `deposit(${formatUsdg(req.usdgRaw)} USDG, onBehalf ${receiver}) on ${status.symbol}`, kind: "deposit", simulate: steps.length === 0 });
    return { action: "lendDeposit", account: receiver, steps, warnings, summary: `lend ${formatUsdg(req.usdgRaw)} USDG into ${status.symbol} ${this.vault} for ${receiver} (instant; withdraw any time there is liquidity; ${pct(status.supplyApy)} now)` };
  }

  /** `withdraw(assets, receiver, account)` for an amount, `redeem(allShares, receiver, account)` for "all". Checks balance and liquidity. */
  async planLendWithdraw(req: { usdg: bigint | string; receiver?: Address; account?: Address }): Promise<LendingPlan> {
    const signer = this.requireSigner();
    const account = req.account ?? this.requireAccount();
    if (signer.address.toLowerCase() !== account.toLowerCase()) throw new Error(`the signer ${signer.address} is not the account ${account}: vault shares are withdrawn by their holder`);
    const receiver = req.receiver ?? signer.address;
    const status = await this.lendStatus(account);
    const my = status.my!;
    const all = typeof req.usdg === "string" && req.usdg.trim().toLowerCase() === "all";
    const usdgRaw = all ? my.assetsRaw : typeof req.usdg === "bigint" ? req.usdg : parseUsdgAmount(req.usdg);
    if (my.sharesRaw === 0n || usdgRaw <= 0n) throw new RangeError(`nothing to withdraw: ${account} holds no ${status.symbol}`);
    if (usdgRaw > my.assetsRaw) throw new RangeError(`${account}'s ${status.symbol} is worth ${formatUsdg(my.assetsRaw)} USDG, less than ${formatUsdg(usdgRaw)}; use "all"`);
    if (!my.canWithdraw) throw new Error(`${account} may not send ${status.symbol} shares (the vault's send-shares gate refuses it)`);
    if (usdgRaw > status.liquidityRaw) throw new Error(`only ${formatUsdg(status.liquidityRaw)} USDG can be withdrawn right now (idle ${formatUsdg(status.idleRaw)} + unborrowed ${formatUsdg(status.market?.available ?? 0n)}); the rest is lent out until borrowers repay`);
    const warnings: string[] = [];
    if (status.liquidityRaw - usdgRaw < status.totalAssetsRaw / 100n) warnings.push("this takes nearly all of the vault's free liquidity; later withdrawals wait for repayments");
    const step: LendingTxStep = all
      ? { to: this.vault, data: encodeFunctionData({ abi: vaultV2Abi, functionName: "redeem", args: [my.sharesRaw, receiver, account] }), summary: `redeem(${formatShares(my.sharesRaw)} ${status.symbol} = ${formatUsdg(usdgRaw)} USDG, to ${receiver}, onBehalf ${account})`, kind: "redeem", simulate: true }
      : { to: this.vault, data: encodeFunctionData({ abi: vaultV2Abi, functionName: "withdraw", args: [usdgRaw, receiver, account] }), summary: `withdraw(${formatUsdg(usdgRaw)} USDG, to ${receiver}, onBehalf ${account}) from ${status.symbol}`, kind: "withdraw", simulate: true };
    return { action: "lendWithdraw", account, steps: [step], warnings, summary: `withdraw ${formatUsdg(usdgRaw)} of ${formatUsdg(my.assetsRaw)} USDG from ${status.symbol} to ${receiver} (instant)` };
  }

  // ---------------------------------------------------------------- borrow plans

  private async borrowContext(account: Address, marketId?: string) {
    const status = await this.borrowStatus(account, marketId);
    const market = status.market;
    const totals = this.totalsFor(market);
    return { status, market, totals };
  }

  /** Blue acts `onBehalf` of the account only for the account itself or an address it authorized. */
  private async authorizedOnBlue(account: Address): Promise<LocalAccount> {
    const s = this.requireSigner();
    if (s.address.toLowerCase() === account.toLowerCase()) return s;
    const ok = await this.publicClient.readContract({ address: this.blue, abi: morphoBlueAbi, functionName: "isAuthorized", args: [account, s.address] });
    if (!ok) throw new Error(`the signer ${s.address} is not ${account} nor authorized on Blue for it; sign with the account's owner key`);
    return s;
  }

  private after(view: BorrowMarketView, collateralRaw: bigint, debtRaw: bigint): NonNullable<LendingPlan["after"]> {
    const price = view.oraclePriceRaw;
    const value = price === null ? null : collateralValueRaw(collateralRaw, price);
    const lp = liquidationPriceRaw(collateralRaw, debtRaw, view.lltv);
    return { collateralRaw, borrowAssetsRaw: debtRaw, healthFactor: price === null ? null : healthFactor(maxBorrowRaw(collateralRaw, price, view.lltv), debtRaw), ltv: value === null ? null : loanToValue(debtRaw, value), liquidationPriceUsdgRaw: lp === null ? null : usdgPerShare(lp) };
  }

  /** Guard shared by borrow and withdrawCollateral: oracle usable, HF >= 1 after, warn above the LTV line. */
  private guard(view: BorrowMarketView, collateralAfter: bigint, debtAfter: bigint, warnings: string[], what: string) {
    if (debtAfter === 0n) return;
    if (view.oracleStatus.state === "unavailable") throw new Error(`refusing to ${what}: the collateral oracle ${view.oracle} has no usable price (${view.oracleStatus.error ?? "reverts"}); Blue would revert, and liquidations are frozen too. Try again when it answers`);
    const price = view.oraclePriceRaw!;
    const max = maxBorrowRaw(collateralAfter, price, view.lltv);
    if (debtAfter > max) throw new Error(`refusing to ${what}: debt ${formatUsdg(debtAfter)} USDG would exceed the LLTV bound ${formatUsdg(max)} USDG (health factor ${healthFactor(max, debtAfter)} < 1; Blue reverts "insufficient collateral")`);
    const value = collateralValueRaw(collateralAfter, price);
    if (aboveLtvWarnLine(debtAfter, value, view.lltv)) warnings.push(`WARNING: LTV after ${pct(loanToValue(debtAfter, value))} is above ${LTV_WARN_FRACTION * 100}% of the LLTV ${pct(Number(view.lltv) / 1e18)} (health factor ${healthFactor(max, debtAfter)}); the oracle is re-marked every Monday and a stock drop or a wide mark can liquidate the position. Stay at or below ${pct((Number(view.lltv) / 1e18) * LTV_WARN_FRACTION)}`);
    if (view.oracleStatus.state === "held") warnings.push("the oracle is holding the last print (stock market closed): the live price at the open may differ");
  }

  /** Approve Blue for the shortfall, then `supplyCollateral(params, shares, account, 0x)`. The shares must already be in the wallet (claimed from the fund). */
  async planSupplyCollateral(req: { shares: bigint | string; marketId?: string; account?: Address }): Promise<LendingPlan> {
    const signer = this.requireSigner();
    const account = req.account ?? this.requireAccount();
    const { status, market } = await this.borrowContext(account, req.marketId);
    const sharesRaw = parseVaultShares(req.shares, status.my.walletSharesRaw);
    if (sharesRaw <= 0n) throw new RangeError(`nothing to pledge: ${account} holds no ${market.collateralToken} shares in its wallet (claim them from the fund first: vault_claim)`);
    const pc = this.publicClient;
    const [bal, allowance] = await Promise.all([
      pc.readContract({ address: market.collateralToken, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] }),
      pc.readContract({ address: market.collateralToken, abi: erc20Abi, functionName: "allowance", args: [signer.address, this.blue] }),
    ]);
    if (bal < sharesRaw) throw new Error(`wallet ${signer.address} holds ${formatShares(bal)} fund shares, less than ${formatShares(sharesRaw)} (shares still in the fund's escrow or a queued deposit are not pledgeable; vault_status / vault_claim)`);
    const warnings = [...status.warnings];
    const steps: LendingTxStep[] = [];
    if (allowance < sharesRaw) steps.push({ ...encodeApprove(market.collateralToken, this.blue, sharesRaw), kind: "approve", simulate: true });
    steps.push({ to: this.blue, data: encodeFunctionData({ abi: morphoBlueAbi, functionName: "supplyCollateral", args: [this.params(market), sharesRaw, account, "0x"] }), summary: `supplyCollateral(market ${market.id.slice(0, 10)}…, ${formatShares(sharesRaw)} shares, onBehalf ${account})`, kind: "supplyCollateral", simulate: steps.length === 0 });
    const after = this.after(market, status.my.collateralRaw + sharesRaw, status.my.borrowAssetsRaw);
    return { action: "supplyCollateral", account, market, steps, warnings, after, summary: `pledge ${formatShares(sharesRaw)} fund shares as collateral on Blue market ${market.id} for ${account} (collateral after ${formatShares(after.collateralRaw)}; worth ${market.collateralPriceUsdgRaw === null ? "unknown" : formatUsdg(collateralValueRaw(after.collateralRaw, market.oraclePriceRaw!)) + " USDG"} at the oracle)` };
  }

  /** `borrow(params, usdg, 0, account, receiver)`: refuses when the oracle is unavailable or the health factor after would be below 1; warns above 70% of LLTV. */
  async planBorrow(req: { usdgRaw: bigint; receiver?: Address; marketId?: string; account?: Address }): Promise<LendingPlan> {
    const account = req.account ?? this.requireAccount();
    const signer = await this.authorizedOnBlue(account);
    const receiver = req.receiver ?? signer.address;
    if (req.usdgRaw <= 0n) throw new RangeError("borrow a positive USDG amount");
    const { status, market } = await this.borrowContext(account, req.marketId);
    if (status.my.collateralRaw === 0n) throw new Error(`${account} has no collateral on market ${market.id}; pledge fund shares first (borrow_supply_collateral)`);
    if (req.usdgRaw > market.available) throw new Error(`the market has ${formatUsdg(market.available)} USDG unborrowed, less than ${formatUsdg(req.usdgRaw)}`);
    const warnings: string[] = [];
    const debtAfter = status.my.borrowAssetsRaw + req.usdgRaw;
    this.guard(market, status.my.collateralRaw, debtAfter, warnings, `borrow ${formatUsdg(req.usdgRaw)} USDG`);
    const step: LendingTxStep = { to: this.blue, data: encodeFunctionData({ abi: morphoBlueAbi, functionName: "borrow", args: [this.params(market), req.usdgRaw, 0n, account, receiver] }), summary: `borrow(market ${market.id.slice(0, 10)}…, ${formatUsdg(req.usdgRaw)} USDG, onBehalf ${account}, to ${receiver})`, kind: "borrow", simulate: true };
    const after = this.after(market, status.my.collateralRaw, debtAfter);
    return { action: "borrow", account, market, steps: [step], warnings, after, summary: `borrow ${formatUsdg(req.usdgRaw)} USDG against ${formatShares(status.my.collateralRaw)} fund shares to ${receiver} (debt after ${formatUsdg(debtAfter)} USDG, LTV ${pct(after.ltv)}, health factor ${after.healthFactor ?? "-"}, liquidation at ${after.liquidationPriceUsdgRaw === null ? "-" : formatUsdg(after.liquidationPriceUsdgRaw)} USDG/share, rate ${pct(market.borrowRate)} APR)` };
  }

  /** Approve Blue, then `repay` by assets (an amount) or by shares ("all", so the accruing debt is cleared exactly). */
  async planRepay(req: { usdg: bigint | string; marketId?: string; account?: Address }): Promise<LendingPlan> {
    const signer = this.requireSigner();
    const account = req.account ?? this.requireAccount();
    const { status, market } = await this.borrowContext(account, req.marketId);
    const debt = status.my.borrowAssetsRaw;
    if (debt === 0n) throw new RangeError(`nothing to repay: ${account} has no debt on market ${market.id}`);
    const all = typeof req.usdg === "string" && req.usdg.trim().toLowerCase() === "all";
    const usdgRaw = all ? debt : typeof req.usdg === "bigint" ? req.usdg : parseUsdgAmount(req.usdg);
    if (usdgRaw <= 0n) throw new RangeError("repay a positive USDG amount");
    if (!all && usdgRaw > debt) throw new RangeError(`debt is ${formatUsdg(debt)} USDG, less than ${formatUsdg(usdgRaw)}; use "all" to clear it exactly`);
    // interest keeps accruing until the transaction mines: approve a small margin for a full repayment
    const margin = all ? (debt * market.borrowRatePerSecondRaw * 3600n) / WAD + 1n : 0n;
    const needed = usdgRaw + margin;
    const pc = this.publicClient;
    const [bal, allowance] = await Promise.all([
      pc.readContract({ address: this.usdg, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] }),
      pc.readContract({ address: this.usdg, abi: erc20Abi, functionName: "allowance", args: [signer.address, this.blue] }),
    ]);
    if (bal < usdgRaw) throw new Error(`wallet ${signer.address} holds ${formatUsdg(bal)} USDG, less than ${formatUsdg(usdgRaw)}`);
    const warnings = [...status.warnings.filter((w) => !w.startsWith("LTV") && !w.startsWith("health"))];
    if (all && bal < needed) warnings.push(`the wallet holds ${formatUsdg(bal)} USDG, barely the debt: interest accrued before the transaction mines (about ${formatUsdg(margin)} per hour) could make a full repayment revert`);
    const approveFor = bal < needed ? bal : needed;
    const steps: LendingTxStep[] = [];
    if (allowance < approveFor) steps.push({ ...encodeApprove(this.usdg, this.blue, approveFor), kind: "approve", simulate: true });
    const args = all ? ([this.params(market), 0n, status.my.borrowSharesRaw, account, "0x"] as const) : ([this.params(market), usdgRaw, 0n, account, "0x"] as const);
    steps.push({ to: this.blue, data: encodeFunctionData({ abi: morphoBlueAbi, functionName: "repay", args: args as unknown as [MarketParams, bigint, bigint, Address, Hex] }), summary: all ? `repay(market ${market.id.slice(0, 10)}…, all ${status.my.borrowSharesRaw} borrow shares ≈ ${formatUsdg(debt)} USDG, onBehalf ${account})` : `repay(market ${market.id.slice(0, 10)}…, ${formatUsdg(usdgRaw)} USDG, onBehalf ${account})`, kind: "repay", simulate: steps.length === 0 });
    const debtAfter = all ? 0n : debt - usdgRaw;
    const after = this.after(market, status.my.collateralRaw, debtAfter);
    return { action: "repay", account, market, steps, warnings, after, summary: all ? `repay the whole debt (${formatUsdg(debt)} USDG + accrual) of ${account} on Blue market ${market.id}` : `repay ${formatUsdg(usdgRaw)} of ${formatUsdg(debt)} USDG for ${account} (debt after ${formatUsdg(debtAfter)}, health factor ${after.healthFactor ?? "-"})` };
  }

  /** `withdrawCollateral(params, shares, account, receiver)`: refuses when the remaining debt would be unhealthy or the oracle is unavailable (with debt). */
  async planWithdrawCollateral(req: { shares: bigint | string; receiver?: Address; marketId?: string; account?: Address }): Promise<LendingPlan> {
    const account = req.account ?? this.requireAccount();
    const signer = await this.authorizedOnBlue(account);
    const receiver = req.receiver ?? signer.address;
    const { status, market } = await this.borrowContext(account, req.marketId);
    const sharesRaw = parseVaultShares(req.shares, status.my.collateralRaw);
    if (status.my.collateralRaw === 0n || sharesRaw <= 0n) throw new RangeError(`nothing to withdraw: ${account} has no collateral on market ${market.id}`);
    if (sharesRaw > status.my.collateralRaw) throw new RangeError(`collateral is ${formatShares(status.my.collateralRaw)} shares, less than ${formatShares(sharesRaw)}; use "all"`);
    const collateralAfter = status.my.collateralRaw - sharesRaw;
    const warnings: string[] = [];
    if (status.my.borrowAssetsRaw > 0n && collateralAfter === 0n) throw new Error(`refusing: ${formatUsdg(status.my.borrowAssetsRaw)} USDG is still owed; repay first (borrow_repay "all"), then withdraw the collateral`);
    this.guard(market, collateralAfter, status.my.borrowAssetsRaw, warnings, `withdraw ${formatShares(sharesRaw)} shares of collateral`);
    const step: LendingTxStep = { to: this.blue, data: encodeFunctionData({ abi: morphoBlueAbi, functionName: "withdrawCollateral", args: [this.params(market), sharesRaw, account, receiver] }), summary: `withdrawCollateral(market ${market.id.slice(0, 10)}…, ${formatShares(sharesRaw)} shares, onBehalf ${account}, to ${receiver})`, kind: "withdrawCollateral", simulate: true };
    const after = this.after(market, collateralAfter, status.my.borrowAssetsRaw);
    return { action: "withdrawCollateral", account, market, steps: [step], warnings, after, summary: `withdraw ${formatShares(sharesRaw)} of ${formatShares(status.my.collateralRaw)} collateral shares to ${receiver} (collateral after ${formatShares(collateralAfter)}, debt ${formatUsdg(status.my.borrowAssetsRaw)} USDG, health factor ${after.healthFactor ?? "-"})` };
  }

  // ---------------------------------------------------------------- sending

  async send(request: TxRequest, opts: { dryRun?: boolean; simulate?: boolean } = {}): Promise<SendResult> {
    return sendTxRequest(this, request, opts);
  }

  async waitForReceipt(hash: Hash) {
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** Dry run (default): simulate what can be simulated and return the unsigned transactions; else send in order. */
  async sendPlan(plan: LendingPlan, opts: { dryRun?: boolean } = {}): Promise<LendingStepResult[]> {
    return sendPlan(this, plan, opts);
  }

  async lendDeposit(req: { usdgRaw: bigint; receiver?: Address; dryRun?: boolean }) {
    const plan = await this.planLendDeposit(req);
    return { plan, results: await this.sendPlan(plan, { dryRun: req.dryRun }) };
  }
  async lendWithdraw(req: { usdg: bigint | string; receiver?: Address; dryRun?: boolean }) {
    const plan = await this.planLendWithdraw(req);
    return { plan, results: await this.sendPlan(plan, { dryRun: req.dryRun }) };
  }
  async supplyCollateral(req: { shares: bigint | string; marketId?: string; dryRun?: boolean }) {
    const plan = await this.planSupplyCollateral(req);
    return { plan, results: await this.sendPlan(plan, { dryRun: req.dryRun }) };
  }
  async borrow(req: { usdgRaw: bigint; receiver?: Address; marketId?: string; dryRun?: boolean }) {
    const plan = await this.planBorrow(req);
    return { plan, results: await this.sendPlan(plan, { dryRun: req.dryRun }) };
  }
  async repay(req: { usdg: bigint | string; marketId?: string; dryRun?: boolean }) {
    const plan = await this.planRepay(req);
    return { plan, results: await this.sendPlan(plan, { dryRun: req.dryRun }) };
  }
  async withdrawCollateral(req: { shares: bigint | string; receiver?: Address; marketId?: string; dryRun?: boolean }) {
    const plan = await this.planWithdrawCollateral(req);
    return { plan, results: await this.sendPlan(plan, { dryRun: req.dryRun }) };
  }
}

/** "12.5" -> 12500000n (USDG raw); "all" is handled by the callers. */
function parseUsdgAmount(v: string): bigint {
  const s = v.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new RangeError(`not a USDG amount with at most 6 decimals, or "all": ${v}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole!) * 10n ** 6n + BigInt((frac + "000000").slice(0, 6));
}

/** The derived position fields from the raw Blue position and the accrued market. */
export function derivePosition(account: Address, view: BorrowMarketView, collateralRaw: bigint, borrowSharesRaw: bigint, totals: BlueMarketState, wallet: { sharesRaw: bigint; usdgRaw: bigint }): BorrowPosition {
  const borrowAssetsRaw = borrowSharesRaw === 0n ? 0n : borrowAssetsOf(borrowSharesRaw, totals);
  const price = view.oraclePriceRaw;
  const value = price === null ? null : collateralValueRaw(collateralRaw, price);
  const max = price === null ? null : maxBorrowRaw(collateralRaw, price, view.lltv);
  const recommended = value === null ? null : (value * view.lltv * BigInt(Math.round(LTV_WARN_FRACTION * 100))) / (WAD * 100n);
  const lp = liquidationPriceRaw(collateralRaw, borrowAssetsRaw, view.lltv);
  return {
    account,
    collateralRaw,
    borrowAssetsRaw,
    borrowSharesRaw,
    collateralValueRaw: value,
    maxBorrowRaw: max,
    borrowableRaw: max === null ? null : max > borrowAssetsRaw ? max - borrowAssetsRaw : 0n,
    recommendedBorrowableRaw: recommended === null ? null : recommended > borrowAssetsRaw ? recommended - borrowAssetsRaw : 0n,
    healthFactor: max === null ? null : healthFactor(max, borrowAssetsRaw),
    ltv: value === null ? null : loanToValue(borrowAssetsRaw, value),
    liquidationPriceRaw: lp,
    liquidationPriceUsdgRaw: lp === null ? null : usdgPerShare(lp),
    walletSharesRaw: wallet.sharesRaw,
    walletUsdgRaw: wallet.usdgRaw,
  };
}
