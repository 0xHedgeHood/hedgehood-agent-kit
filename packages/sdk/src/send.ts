import { createWalletClient, http, type Address, type Chain, type Hash, type PublicClient, type Transport } from "viem";
import type { LocalAccount } from "viem/accounts";
import type { TxRequest } from "./calldata.js";

export interface SendResult {
  /** True when nothing was sent. */
  dryRun: boolean;
  request: TxRequest;
  hash?: Hash;
  from?: Address;
  /** False when the dry run skipped the simulation (a later step of a plan whose approval has not been mined). */
  simulated?: boolean;
}

export interface Sender {
  chain: Chain;
  rpcUrl: string;
  publicClient: PublicClient<Transport, Chain>;
  signer?: LocalAccount;
  fetch?: typeof fetch;
}

/**
 * Simulates then (unless dryRun) signs and sends `request` from the signer. The simulation runs first in both cases
 * so a dry run still reports the revert reason a send would hit. Shared by the market and vault clients.
 */
export async function sendTxRequest(s: Sender, request: TxRequest, opts: { dryRun?: boolean; simulate?: boolean } = {}): Promise<SendResult> {
  const dryRun = opts.dryRun ?? true;
  if (!s.signer) throw new Error("no signer configured");
  const from = s.signer.address;
  const simulate = opts.simulate ?? true;
  if (simulate) {
    await s.publicClient.call({ account: from, to: request.to, data: request.data, value: request.value });
  }
  if (dryRun) return { dryRun: true, request, from, simulated: simulate };
  const wallet = createWalletClient({ account: s.signer, chain: s.chain, transport: http(s.rpcUrl, s.fetch ? { fetchFn: s.fetch } : {}) });
  const hash = await wallet.sendTransaction({ to: request.to, data: request.data, value: request.value ?? 0n });
  return { dryRun: false, request, hash, from, simulated: simulate };
}

/** One step of a plan: an unsigned transaction with a kind tag and whether a dry run can simulate it on its own. */
export interface PlanStep extends TxRequest {
  kind: string;
  /** False for a step that only succeeds after an earlier step of the plan is mined (an approve, typically). */
  simulate: boolean;
}

export interface PlanStepResult<K extends string = string> extends SendResult {
  kind: K;
  status?: "success" | "reverted";
  blockNumber?: bigint;
}

/**
 * Runs a plan of owner-wallet transactions: a dry run (default) simulates every step that can be simulated and returns
 * the unsigned transactions; otherwise it sends them in order, waits for each receipt and stops at the first revert.
 * Shared by the vault and lending clients.
 */
export async function sendPlan<S extends PlanStep>(s: Sender, plan: { steps: S[] }, opts: { dryRun?: boolean } = {}): Promise<Array<PlanStepResult<S["kind"]>>> {
  const dryRun = opts.dryRun ?? true;
  const out: Array<PlanStepResult<S["kind"]>> = [];
  for (const step of plan.steps) {
    const kind = step.kind as S["kind"];
    if (dryRun) {
      out.push({ ...(await sendTxRequest(s, step, { dryRun: true, simulate: step.simulate })), kind });
      continue;
    }
    const r = await sendTxRequest(s, step, { dryRun: false });
    const receipt = await s.publicClient.waitForTransactionReceipt({ hash: r.hash! });
    out.push({ ...r, kind, status: receipt.status, blockNumber: receipt.blockNumber });
    if (receipt.status !== "success") break;
  }
  return out;
}
