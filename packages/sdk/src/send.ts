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
