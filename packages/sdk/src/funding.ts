import type { Address, Hex } from "viem";
import { marketV2Abi } from "./abi/cashOptionMarketV2.js";
import { erc20Abi } from "./abi/erc20.js";
import { fundingAdvice, type AccountView, type FundingAdvice } from "./account.js";
import { encodeApprove, encodeDeposit } from "./calldata.js";
import type { MarketClient } from "./market.js";
import { premiumFor, Side, takerFeeFor, type Order } from "./order.js";
import type { PlanStep } from "./send.js";
import { maxPaidUntilExpiry } from "./session.js";
import { formatUsdg } from "./units.js";

/**
 * How a fill is paid, and the transactions that make it payable. Two modes, as the market defines them:
 *
 * - **wallet** (`fromBalance = false`, the account's own key only): premium and fee are pulled from the account's
 *   wallet and a collateral shortfall is pulled into that market's balance, against the wallet's allowance to the
 *   MARKET; a sale's premium goes to the wallet. No deposit is needed in any market. A session key can never do this
 *   (the market reverts `SessionWalletMode`), by design: an agent's key must not pull from the owner's wallet.
 * - **balance** (`fromBalance = true`): premium, fee and collateral settle inside that market's deposited balance.
 *   The only mode for a session key. With `autoDeposit` (owner key) the shortfall is deposited first.
 *
 * `planFillFunding` reads the market balance, the requirement after the fill, the wallet and its allowance, and returns
 * the steps to send in order (approve, deposit, fill) with what each mode needs; `problems` lists what blocks it.
 */
export type FillMode = "wallet" | "balance";
export type FillStepKind = "approve" | "deposit" | "fill";

export interface FillStep extends PlanStep {
  kind: FillStepKind;
}

export interface FillFundingRequest {
  /** Carries the chain, the market, the account and the signing key. */
  market: MarketClient;
  order: Order;
  signature: Hex;
  quantityRaw: bigint;
  mode: FillMode;
  /** Balance mode, account's own key only: deposit the shortfall into this market before filling. */
  autoDeposit?: boolean;
  /** Allowance to grant when one is needed: "exact" (default, just what this fill can pull) or "max" (unlimited). */
  approve?: "exact" | "max";
  /** The book's taker fee, if already read. */
  protocolFeeBps?: bigint | number;
  /** Unix seconds; default now. */
  now?: number;
  account?: Address;
}

export interface FillFundingPlan {
  account: Address;
  underlying: string;
  market: Address;
  mode: FillMode;
  /** The account's side of the fill. */
  side: "buy" | "sell";
  /** The market balance now and the account's requirement now / after the fill. */
  collateralRaw: bigint;
  requirementRaw: bigint;
  requirementAfterRaw: bigint;
  walletUsdgRaw: bigint;
  allowanceRaw: bigint;
  /** Buy: the most premium + fee the fill can cost until the quote's validUntil (0 for a sell). */
  paysUpToRaw: bigint;
  /** Sell: the least premium - fee the account receives until validUntil (0 for a buy). */
  receivesAtLeastRaw: bigint;
  /** Wallet mode: the most the market can pull from the wallet (premium + fee + collateral shortfall); 0 in balance mode. */
  walletPullUpToRaw: bigint;
  /** Balance mode: what this market's balance lacks for the fill (0 = covered); 0 in wallet mode. */
  balanceShortfallRaw: bigint;
  /** Deposited first (balance mode with autoDeposit). */
  depositRaw: bigint;
  /** The allowance an approve step sets (0 = no approve). */
  approveRaw: bigint;
  /** In send order; the fill is last. A step after another is not simulated on its own (it needs the earlier one mined). */
  steps: FillStep[];
  /** What blocks the plan as is (empty = ready): a balance shortfall without autoDeposit, a wallet that cannot pay. */
  problems: string[];
  summary: string;
}

const MAX_UINT256 = (1n << 256n) - 1n;

/** The least a taker selling `fillQuantityRaw` into a bid receives (premium - fee) from now until `validUntil`; 0 for an ask. */
export function minReceivedUntilExpiry(order: Order, fillQuantityRaw: bigint, protocolFeeBps: bigint | number, now: bigint | number): bigint {
  if (order.side !== Side.Bid) return 0n;
  const at = (t: bigint | number) => {
    const p = premiumFor(order, fillQuantityRaw, t);
    const net = p - takerFeeFor(p, protocolFeeBps);
    return net > 0n ? net : 0n;
  };
  const a = at(now);
  const b = at(order.validUntil);
  return a < b ? a : b;
}

const pos = (v: bigint) => (v > 0n ? v : 0n);

export interface SessionFundingRefusal {
  plan: FillFundingPlan;
  /** Undefined when the account view could not be read (the message then names the shortfall only). */
  advice?: FundingAdvice;
  message: string;
}

/**
 * The pre-check of a session-key fill: undefined when the market balance covers it (or the reads fail: the simulation
 * then decides); otherwise why it cannot be paid, with the free balance in the other markets and the owner's fix
 * (`fundingAdvice`). The key never moves funds itself, so the fix is always the owner's.
 */
export async function sessionFundingRefusal(req: { market: MarketClient; order: Order; signature: Hex; quantityRaw: bigint; protocolFeeBps?: bigint | number; accountView: () => Promise<AccountView> }): Promise<SessionFundingRefusal | undefined> {
  let plan: FillFundingPlan;
  try {
    plan = await planFillFunding({ market: req.market, order: req.order, signature: req.signature, quantityRaw: req.quantityRaw, mode: "balance", protocolFeeBps: req.protocolFeeBps });
  } catch {
    return undefined;
  }
  if (plan.balanceShortfallRaw === 0n) return undefined;
  const u = plan.underlying;
  try {
    const advice = fundingAdvice(await req.accountView(), u, plan.balanceShortfallRaw);
    return { plan, advice, message: advice.message };
  } catch {
    const amount = formatUsdg(plan.balanceShortfallRaw);
    return { plan, message: `${plan.problems[0]}. A session key fills from the ${u} market balance only. Owner fix: \`hedgehood deposit ${amount} --market ${u} --wallet --send\` (MCP: deposit { market: "${u}", amount: "${amount}", confirm: true, dryRun: false }), or rebalance from a market with free balance (\`hedgehood account\` shows them).` };
  }
}

/** Reads what the fill needs and plans approve / deposit / fill for the chosen mode. Sends nothing. */
export async function planFillFunding(req: FillFundingRequest): Promise<FillFundingPlan> {
  const m = req.market;
  const account = req.account ?? m.account;
  if (!account) throw new Error("no account configured (pass `account` or a signer)");
  const session = !!m.signer && m.signer.address.toLowerCase() !== account.toLowerCase();
  if (req.mode === "wallet" && session) {
    throw new Error(`a session key cannot fill in wallet mode (the market reverts SessionWalletMode): it fills from the ${m.deployment.underlying} market balance only and never pulls from the owner's wallet`);
  }
  if (req.autoDeposit && req.mode !== "balance") throw new RangeError("autoDeposit only applies to balance mode (wallet mode needs no deposit)");
  if (req.autoDeposit && session) throw new Error("a session key never deposits from the owner's wallet: the owner deposits (or rebalances) into this market, then the key fills");
  const q = req.quantityRaw;
  const buy = req.order.side === Side.Ask;
  const now = req.now ?? Math.floor(Date.now() / 1000);
  const [fee, collateralRaw, requirementRaw, requirementAfterRaw, walletUsdgRaw, allowanceRaw] = await Promise.all([
    req.protocolFeeBps ?? m.protocolFeeBps(),
    m.publicClient.readContract({ address: m.market, abi: marketV2Abi, functionName: "collateral", args: [account] }),
    m.publicClient.readContract({ address: m.market, abi: marketV2Abi, functionName: "requirement", args: [account] }),
    m.requirementIfTraded(req.order.instrumentId, buy ? q : -q, account),
    m.publicClient.readContract({ address: m.usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    m.usdgAllowance(account),
  ]);
  const paysUpToRaw = buy ? maxPaidUntilExpiry(req.order, q, fee, now) : 0n;
  const receivesAtLeastRaw = buy ? 0n : minReceivedUntilExpiry(req.order, q, fee, now);
  const collateralShortRaw = pos(requirementAfterRaw - collateralRaw);
  const u = m.deployment.underlying;
  const steps: FillStep[] = [];
  const problems: string[] = [];
  let walletPullUpToRaw = 0n;
  let balanceShortfallRaw = 0n;
  let depositRaw = 0n;
  let approveRaw = 0n;
  const approve = (amount: bigint) => {
    approveRaw = req.approve === "max" ? MAX_UINT256 : amount;
    const tx = encodeApprove(m.usdg, m.market, approveRaw);
    steps.push({ ...tx, summary: `${tx.summary} [${u} market may pull ${req.approve === "max" ? "unlimited" : formatUsdg(approveRaw)} USDG from the wallet]`, kind: "approve", simulate: true });
  };
  if (req.mode === "wallet") {
    // the buyer's premium + fee leave the wallet first; then any collateral shortfall is pulled (a seller's premium has landed in the wallet by then)
    walletPullUpToRaw = paysUpToRaw + collateralShortRaw;
    if (walletPullUpToRaw > 0n && allowanceRaw < walletPullUpToRaw) approve(walletPullUpToRaw);
    const covers = walletUsdgRaw + receivesAtLeastRaw;
    if (covers < walletPullUpToRaw) problems.push(`the wallet holds ${formatUsdg(walletUsdgRaw)} USDG; this fill can pull up to ${formatUsdg(walletPullUpToRaw)} (${buy ? `premium + fee up to ${formatUsdg(paysUpToRaw)}, ` : ""}collateral ${formatUsdg(collateralShortRaw)} beyond the ${u} balance)`);
  } else {
    balanceShortfallRaw = buy ? pos(paysUpToRaw + requirementAfterRaw - collateralRaw) : pos(requirementAfterRaw - collateralRaw - receivesAtLeastRaw);
    if (balanceShortfallRaw > 0n) {
      if (req.autoDeposit) {
        depositRaw = balanceShortfallRaw;
        if (allowanceRaw < depositRaw) approve(depositRaw);
        const tx = encodeDeposit(m.market, account, depositRaw);
        steps.push({ ...tx, summary: `${tx.summary} [${u}: the shortfall]`, kind: "deposit", simulate: steps.length === 0 && walletUsdgRaw >= depositRaw });
        if (walletUsdgRaw < depositRaw) problems.push(`the wallet holds ${formatUsdg(walletUsdgRaw)} USDG, less than the ${formatUsdg(depositRaw)} to deposit into ${u}`);
      } else {
        problems.push(`the ${u} market balance is short by ${formatUsdg(balanceShortfallRaw)} USDG (balance ${formatUsdg(collateralRaw)}, requirement after the fill ${formatUsdg(requirementAfterRaw)}${buy ? `, premium + fee up to ${formatUsdg(paysUpToRaw)}` : `, premium received at least ${formatUsdg(receivesAtLeastRaw)}`})`);
      }
    }
  }
  const fill = m.fillOrderAs(req.order, req.signature, q, req.mode === "balance", account);
  steps.push({ ...fill, kind: "fill", simulate: steps.length === 0 });
  const how =
    req.mode === "wallet"
      ? walletPullUpToRaw > 0n
        ? `wallet mode: the ${u} market pulls up to ${formatUsdg(walletPullUpToRaw)} USDG from the wallet`
        : `wallet mode: nothing is pulled from the wallet${receivesAtLeastRaw > 0n ? `; at least ${formatUsdg(receivesAtLeastRaw)} USDG premium goes to it` : ""}`
      : depositRaw > 0n
        ? `balance mode: deposit ${formatUsdg(depositRaw)} USDG into ${u} first`
        : `balance mode: settles inside the ${u} market balance`;
  return {
    account,
    underlying: u,
    market: m.market,
    mode: req.mode,
    side: buy ? "buy" : "sell",
    collateralRaw,
    requirementRaw,
    requirementAfterRaw,
    walletUsdgRaw,
    allowanceRaw,
    paysUpToRaw,
    receivesAtLeastRaw,
    walletPullUpToRaw,
    balanceShortfallRaw,
    depositRaw,
    approveRaw,
    steps,
    problems,
    summary: `${how}; ${steps.map((s) => s.kind).join(" -> ")}`,
  };
}
