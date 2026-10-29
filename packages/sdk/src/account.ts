import { createPublicClient, http, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { marketV2Abi } from "./abi/cashOptionMarketV2.js";
import { erc20Abi } from "./abi/erc20.js";
import { encodeApprove, encodeDeposit, encodeWithdraw } from "./calldata.js";
import { chains, getDeployment, MULTICALL3, type MarketDeployment } from "./chains.js";
import { SCOPE_CANCEL, SCOPE_TRADE } from "./order.js";
import type { PlanStep } from "./send.js";
import { formatUsdg } from "./units.js";

/**
 * One account across every market of a chain. Each `CashOptionMarketV2` (one per underlying) keeps its own collateral
 * balance, positions and session keys; nothing moves between them on chain. This module reads them side by side
 * (`readAccount`), says where free balance sits when one market lacks it (`fundingAdvice`), and plans the owner-key
 * moves between them: `planDeposit`, `planWithdrawAll` and `planRebalance` (withdraw from one market, deposit into
 * another). Plans are unsigned; send them with `MarketClient.sendPlan` (dry run by default).
 */

/** How the configured key relates to the account: its own key ("owner"), a session key, or none configured. */
export type KeyRole = "owner" | "session" | "none";

export interface MarketSessionView {
  key: Address;
  expiresAt: bigint;
  authorizedAt: bigint;
  scope: bigint;
  riskLeft: bigint;
  spendLeft: bigint;
  canTrade: boolean;
  canCancel: boolean;
  /** Not expired and some scope granted (as `MarketClient.session`). */
  active: boolean;
}

export interface MarketAccountView {
  underlying: string;
  market: Address;
  orderBook: Address;
  settlementToken: Address;
  /** Set when this market's reads failed; its amounts are then 0 and it is not tradable. The other markets still read. */
  error?: string;
  collateralRaw: bigint;
  /** Collateral locked by open positions (`requirement`). */
  requirementRaw: bigint;
  /** collateral - requirement: what a fill can spend or `withdraw` can take out. */
  freeCollateralRaw: bigint;
  /** The account wallet's settlement-token allowance to this market (wallet-mode fills and deposits pull against it). */
  allowanceRaw: bigint;
  /** Expiries the account touched in this market. */
  expiries: bigint[];
  /** Non-zero positions in expiries still ahead. */
  openPositions: number;
  /** Non-zero positions in expiries already past (waiting for settle / redeem). */
  expiredPositions: number;
  /** The configured session key's grant in this market (sessions are per market). */
  session?: MarketSessionView;
  /** The configured key can fill here in balance mode now: a live TRADE session (or the account's own key) and free balance > 0. */
  canTradeFromBalance: boolean;
}

export interface AccountView {
  chainId: number;
  account: Address;
  key?: Address;
  keyRole: KeyRole;
  /** Unix seconds the view was read at (session expiry and position counts use it). */
  asOf: number;
  /** The account wallet's balance of each settlement token the markets use (one token per chain today). */
  wallet: Array<{ token: Address; balanceRaw: bigint; error?: string }>;
  /** Wallet balance of the first market's settlement token (USDG; TestUSD on the testnet). */
  walletUsdgRaw: bigint;
  totals: { collateralRaw: bigint; requirementRaw: bigint; freeCollateralRaw: bigint; openPositions: number; expiredPositions: number };
  markets: MarketAccountView[];
  /** Underlyings the configured key can fill in balance mode now (`canTradeFromBalance`). */
  tradable: string[];
  /** Underlyings whose reads failed (`error` set). */
  failed: string[];
}

export interface ReadAccountOptions {
  chainId: number;
  account: Address;
  /** The key that will trade: a session key, or the account's own key. Omit for a view without session status. */
  key?: Address;
  rpcUrl?: string;
  /** Default: every market of the chain (`chains.ts`). */
  markets?: MarketDeployment[];
  /** Default: a client on `rpcUrl` (or the chain's RPC) with JSON-RPC batching. */
  publicClient?: PublicClient<Transport, Chain>;
  /** Unix seconds; default now. */
  now?: number;
  multicallAddress?: Address;
}

const errorLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);

function emptyMarket(dep: MarketDeployment): MarketAccountView {
  return { underlying: dep.underlying, market: dep.market, orderBook: dep.orderBook, settlementToken: dep.settlementToken, collateralRaw: 0n, requirementRaw: 0n, freeCollateralRaw: 0n, allowanceRaw: 0n, expiries: [], openPositions: 0, expiredPositions: 0, canTradeFromBalance: false };
}

async function readMarket(client: PublicClient<Transport, Chain>, dep: MarketDeployment, account: Address, key: Address | undefined, keyRole: KeyRole, now: number, multicallAddress: Address): Promise<MarketAccountView> {
  const view = emptyMarket(dep);
  try {
    const contracts = [
      { address: dep.market, abi: marketV2Abi, functionName: "collateral", args: [account] },
      { address: dep.market, abi: marketV2Abi, functionName: "requirement", args: [account] },
      { address: dep.market, abi: marketV2Abi, functionName: "accountExpiries", args: [account] },
      { address: dep.settlementToken, abi: erc20Abi, functionName: "allowance", args: [account, dep.market] },
      ...(keyRole === "session" && key ? [{ address: dep.market, abi: marketV2Abi, functionName: "sessions", args: [account, key] }] : []),
    ];
    const r = (await client.multicall({ contracts: contracts as never, allowFailure: false, multicallAddress })) as unknown[];
    const collateralRaw = r[0] as bigint;
    const requirementRaw = r[1] as bigint;
    const expiries = [...(r[2] as readonly bigint[])];
    view.collateralRaw = collateralRaw;
    view.requirementRaw = requirementRaw;
    view.freeCollateralRaw = collateralRaw > requirementRaw ? collateralRaw - requirementRaw : 0n;
    view.allowanceRaw = r[3] as bigint;
    view.expiries = expiries;
    if (keyRole === "session" && key) {
      const [expiresAt, authorizedAt, scope, riskLeft, spendLeft] = r[4] as readonly [bigint | number, bigint | number, bigint, bigint, bigint];
      view.session = {
        key,
        expiresAt: BigInt(expiresAt),
        authorizedAt: BigInt(authorizedAt),
        scope,
        riskLeft,
        spendLeft,
        canTrade: (scope & SCOPE_TRADE) !== 0n,
        canCancel: (scope & SCOPE_CANCEL) !== 0n,
        active: BigInt(expiresAt) > BigInt(now) && scope !== 0n,
      };
    }
    if (expiries.length) {
      const q = (await client.multicall({ contracts: expiries.map((e) => ({ address: dep.market, abi: marketV2Abi, functionName: "positions", args: [account, e] })) as never, allowFailure: false, multicallAddress })) as Array<readonly bigint[]>;
      expiries.forEach((e, i) => {
        const n = (q[i] ?? []).filter((x) => x !== 0n).length;
        if (e > BigInt(now)) view.openPositions += n;
        else view.expiredPositions += n;
      });
    }
    const keyCanTrade = keyRole === "owner" || (keyRole === "session" && !!view.session?.active && view.session.canTrade);
    view.canTradeFromBalance = keyCanTrade && view.freeCollateralRaw > 0n;
    return view;
  } catch (e) {
    return { ...emptyMarket(dep), error: errorLine(e) };
  }
}

/**
 * The account in every market of the chain, read in parallel (one Multicall3 batch per market, JSON-RPC batched): per
 * market collateral, locked requirement, free balance, wallet allowance, positions and the configured key's session;
 * the wallet balance; totals; and where the key can fill from the balance now. A market whose reads fail is marked
 * (`error`, listed in `failed`) and counts as empty; the view never fails as a whole on one market.
 */
export async function readAccount(opts: ReadAccountOptions): Promise<AccountView> {
  const chain = chains[opts.chainId];
  if (!chain) throw new Error(`unsupported chain id ${opts.chainId}`);
  const markets = opts.markets ?? getDeployment(opts.chainId).markets;
  const client = opts.publicClient ?? createPublicClient({ chain, transport: http(opts.rpcUrl ?? chain.rpcUrls.default.http[0]!, { batch: true }) });
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const { account, key } = opts;
  const keyRole: KeyRole = !key ? "none" : key.toLowerCase() === account.toLowerCase() ? "owner" : "session";
  const multicallAddress = opts.multicallAddress ?? MULTICALL3;
  const tokens: Address[] = [];
  for (const m of markets) if (!tokens.some((t) => t.toLowerCase() === m.settlementToken.toLowerCase())) tokens.push(m.settlementToken);
  const [wallet, rows] = await Promise.all([
    Promise.all(
      tokens.map(async (token) => {
        try {
          return { token, balanceRaw: await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }) };
        } catch (e) {
          return { token, balanceRaw: 0n, error: errorLine(e) };
        }
      }),
    ),
    Promise.all(markets.map((m) => readMarket(client, m, account, key, keyRole, now, multicallAddress))),
  ]);
  const totals = { collateralRaw: 0n, requirementRaw: 0n, freeCollateralRaw: 0n, openPositions: 0, expiredPositions: 0 };
  for (const r of rows) {
    totals.collateralRaw += r.collateralRaw;
    totals.requirementRaw += r.requirementRaw;
    totals.freeCollateralRaw += r.freeCollateralRaw;
    totals.openPositions += r.openPositions;
    totals.expiredPositions += r.expiredPositions;
  }
  return {
    chainId: opts.chainId,
    account,
    key,
    keyRole,
    asOf: now,
    wallet,
    walletUsdgRaw: wallet[0]?.balanceRaw ?? 0n,
    totals,
    markets: rows,
    tradable: rows.filter((r) => r.canTradeFromBalance).map((r) => r.underlying),
    failed: rows.filter((r) => r.error).map((r) => r.underlying),
  };
}

/** A market row of a view by ticker (any case) or market address. */
export function marketOfView(view: AccountView, ref: string): MarketAccountView {
  const r = ref.trim().toLowerCase();
  const m = view.markets.find((x) => x.underlying.toLowerCase() === r || x.market.toLowerCase() === r || x.orderBook.toLowerCase() === r);
  if (!m) throw new Error(`no market ${ref} on chain ${view.chainId} (known: ${view.markets.map((x) => x.underlying).join(", ") || "none"})`);
  return m;
}

export interface FundingAdvice {
  underlying: string;
  shortfallRaw: bigint;
  /** This market's free balance now. */
  freeRaw: bigint;
  /** Other markets with free balance, largest first. */
  freeElsewhere: Array<{ underlying: string; freeCollateralRaw: bigint }>;
  /** The market with the most free balance, when it covers the shortfall. */
  rebalanceFrom?: string;
  walletUsdgRaw: bigint;
  /** Owner commands that fix it (the first is the suggested one), as CLI lines and as MCP tool calls. */
  cli: string[];
  mcp: string[];
  message: string;
}

/**
 * Why a session-key fill in `underlying` cannot be paid and what the owner can do: the shortfall, the markets where the
 * account has free balance, and the exact commands (`hedgehood rebalance --from Y --to X --amount N`, or `hedgehood
 * deposit N --market X --wallet`). A session key itself never moves funds: it fills from that market's balance only.
 */
export function fundingAdvice(view: AccountView, underlying: string, shortfallRaw: bigint): FundingAdvice {
  const target = marketOfView(view, underlying);
  const x = target.underlying;
  const amount = formatUsdg(shortfallRaw);
  const freeElsewhere = view.markets
    .filter((m) => m.underlying !== x && !m.error && m.freeCollateralRaw > 0n)
    .map((m) => ({ underlying: m.underlying, freeCollateralRaw: m.freeCollateralRaw }))
    .sort((a, b) => (a.freeCollateralRaw === b.freeCollateralRaw ? 0 : a.freeCollateralRaw > b.freeCollateralRaw ? -1 : 1));
  const rebalanceFrom = freeElsewhere[0] && freeElsewhere[0].freeCollateralRaw >= shortfallRaw ? freeElsewhere[0].underlying : undefined;
  const cli: string[] = [];
  const mcp: string[] = [];
  if (rebalanceFrom) {
    cli.push(`hedgehood rebalance --from ${rebalanceFrom} --to ${x} --amount ${amount} --send`);
    mcp.push(`rebalance { from: "${rebalanceFrom}", to: "${x}", amount: "${amount}", confirm: true, dryRun: false }`);
  }
  cli.push(`hedgehood deposit ${amount} --market ${x} --wallet --send`);
  mcp.push(`deposit { market: "${x}", amount: "${amount}", confirm: true, dryRun: false }`);
  const elsewhere = freeElsewhere.length ? freeElsewhere.map((m) => `${m.underlying} ${formatUsdg(m.freeCollateralRaw)}`).join(", ") : "none";
  const message =
    `the ${x} market balance is short by ${amount} USDG for this fill (free there: ${formatUsdg(target.freeCollateralRaw)}). ` +
    `A session key fills from the ${x} market balance only: it never draws on the owner's wallet or on another market's balance. ` +
    `Free balance in other markets: ${elsewhere}; owner wallet: ${formatUsdg(view.walletUsdgRaw)}. ` +
    `Owner fix: \`${cli[0]}\`${cli[1] ? ` or \`${cli[1]}\`` : ""} (MCP: ${mcp.join(" or ")}), then retry the fill.`;
  return { underlying: x, shortfallRaw, freeRaw: target.freeCollateralRaw, freeElsewhere, rebalanceFrom, walletUsdgRaw: view.walletUsdgRaw, cli, mcp, message };
}

// ---------------------------------------------------------------- owner plans (deposit, withdraw, rebalance)

const MAX_UINT256 = (1n << 256n) - 1n;

export type AccountStepKind = "approve" | "deposit" | "withdraw";

export interface AccountStep extends PlanStep {
  kind: AccountStepKind;
  underlying: string;
  market: Address;
  amountRaw: bigint;
}

export interface AccountPlan {
  account: Address;
  summary: string;
  steps: AccountStep[];
}

export interface DepositPlanRequest {
  market: MarketDeployment;
  /** The account credited (`deposit(account, amount)`); the owner wallet pays. */
  account: Address;
  amountRaw: bigint;
  /** The paying wallet's current allowance to the market. */
  allowanceRaw: bigint;
  /** The paying wallet's balance, when known: a deposit it cannot cover is refused here. */
  walletRaw?: bigint;
  /** "exact" (default): approve the amount; "max": unlimited allowance. */
  approve?: "exact" | "max";
}

function approveStep(dep: MarketDeployment, amountRaw: bigint, mode: "exact" | "max" = "exact"): AccountStep {
  const value = mode === "max" ? MAX_UINT256 : amountRaw;
  const tx = encodeApprove(dep.settlementToken, dep.market, value);
  return { ...tx, summary: `${tx.summary} [${dep.underlying} market may pull ${mode === "max" ? "unlimited" : formatUsdg(value)} USDG from the wallet]`, kind: "approve", underlying: dep.underlying, market: dep.market, amountRaw: value, simulate: true };
}

/** approve (only when the allowance is short) + `deposit(account, amount)` into one market, from the owner wallet. */
export function planDeposit(req: DepositPlanRequest): AccountPlan {
  const { market: dep, account, amountRaw } = req;
  if (amountRaw <= 0n) throw new RangeError("deposit amount must be positive");
  if (req.walletRaw !== undefined && req.walletRaw < amountRaw) throw new Error(`the wallet holds ${formatUsdg(req.walletRaw)} USDG, less than the ${formatUsdg(amountRaw)} to deposit into ${dep.underlying}`);
  const steps: AccountStep[] = [];
  if (req.allowanceRaw < amountRaw) steps.push(approveStep(dep, amountRaw, req.approve));
  const tx = encodeDeposit(dep.market, account, amountRaw);
  steps.push({ ...tx, summary: `${tx.summary} [${dep.underlying}]`, kind: "deposit", underlying: dep.underlying, market: dep.market, amountRaw, simulate: steps.length === 0 });
  return { account, summary: `deposit ${formatUsdg(amountRaw)} USDG into the ${dep.underlying} market for ${account}`, steps };
}

/** Every market's free balance back to `to` (default: the account's wallet), one `withdraw` per market; owner key only. */
export function planWithdrawAll(view: AccountView, to: Address = view.account): AccountPlan {
  const steps: AccountStep[] = view.markets
    .filter((m) => !m.error && m.freeCollateralRaw > 0n)
    .map((m) => {
      const tx = encodeWithdraw(m.market, m.freeCollateralRaw, to);
      return { ...tx, summary: `${tx.summary} [${m.underlying}]`, kind: "withdraw" as const, underlying: m.underlying, market: m.market, amountRaw: m.freeCollateralRaw, simulate: true };
    });
  const total = steps.reduce((s, x) => s + x.amountRaw, 0n);
  const skipped = view.failed.length ? `; not read, skipped: ${view.failed.join(", ")}` : "";
  return { account: view.account, summary: steps.length ? `withdraw ${formatUsdg(total)} USDG free balance from ${steps.length} market(s) (${steps.map((s) => s.underlying).join(", ")}) to ${to}${skipped}` : `no free balance to withdraw${skipped}`, steps };
}

export interface RebalanceRequest {
  from: string;
  to: string;
  amountRaw: bigint;
  approve?: "exact" | "max";
}

/**
 * Moves free balance between two markets of the account: `withdraw(amount, account)` from one, then (approve if the
 * allowance is short and) `deposit(account, amount)` into the other. Owner key only (withdraw is the account's own call).
 */
export function planRebalance(view: AccountView, req: RebalanceRequest): AccountPlan {
  const from = marketOfView(view, req.from);
  const to = marketOfView(view, req.to);
  if (from.market.toLowerCase() === to.market.toLowerCase()) throw new RangeError("--from and --to are the same market");
  if (req.amountRaw <= 0n) throw new RangeError("rebalance amount must be positive");
  for (const m of [from, to]) if (m.error) throw new Error(`cannot read the ${m.underlying} market (${m.error}); nothing planned`);
  if (from.freeCollateralRaw < req.amountRaw) throw new Error(`the ${from.underlying} market has ${formatUsdg(from.freeCollateralRaw)} USDG free (collateral ${formatUsdg(from.collateralRaw)}, locked ${formatUsdg(from.requirementRaw)}), less than ${formatUsdg(req.amountRaw)}`);
  const toDep: MarketDeployment = { underlying: to.underlying, market: to.market, orderBook: to.orderBook, underlyingToken: "0x0000000000000000000000000000000000000000", settlementToken: to.settlementToken };
  const w = encodeWithdraw(from.market, req.amountRaw, view.account);
  const steps: AccountStep[] = [{ ...w, summary: `${w.summary} [${from.underlying}]`, kind: "withdraw", underlying: from.underlying, market: from.market, amountRaw: req.amountRaw, simulate: true }];
  const needsApprove = to.allowanceRaw < req.amountRaw;
  if (needsApprove) steps.push(approveStep(toDep, req.amountRaw, req.approve));
  const d = encodeDeposit(to.market, view.account, req.amountRaw);
  // the deposit spends what the withdraw returns: simulated alone only when the wallet already holds it and no approve precedes
  steps.push({ ...d, summary: `${d.summary} [${to.underlying}]`, kind: "deposit", underlying: to.underlying, market: to.market, amountRaw: req.amountRaw, simulate: !needsApprove && view.walletUsdgRaw >= req.amountRaw });
  return { account: view.account, summary: `move ${formatUsdg(req.amountRaw)} USDG from the ${from.underlying} market to the ${to.underlying} market (withdraw, ${needsApprove ? "approve, " : ""}deposit)`, steps };
}
