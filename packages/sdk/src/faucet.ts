import { createPublicClient, encodeFunctionData, http, type Address, type Chain, type PublicClient, type Transport } from "viem";
import type { LocalAccount } from "viem/accounts";
import { testUsdAbi } from "./abi/testUsd.js";
import { chains, getDeployment, type FaucetDeployment } from "./chains.js";
import type { TxRequest } from "./calldata.js";
import { sendTxRequest, type SendResult } from "./send.js";
import { formatUsdg } from "./units.js";

/**
 * The testnet faucet of a chain: TestUSD ("Hedgehood Test USD", hUSD-test, no value), whose public `faucet()` mints a
 * fixed amount to the caller once per cooldown. Refused on mainnet (USDG has value: see the on-ramp in the backend's
 * `how_to_deposit`), and on a chain whose deployment names no faucet.
 */
export function getFaucet(chainId: number): FaucetDeployment {
  const d = getDeployment(chainId);
  if (!d.faucet || d.chainId === 4663) {
    throw new Error(chainId === 4663 ? "there is no faucet on Robinhood Chain mainnet: USDG has value (on-ramp: the hosted MCP how_to_deposit)" : `no test-token faucet on chain ${chainId}`);
  }
  return d.faucet;
}

/** `faucet()` calldata to the chain's TestUSD; the tokens go to whichever wallet sends it. */
export function encodeFaucet(chainId: number): TxRequest {
  const f = getFaucet(chainId);
  return {
    to: f.token,
    data: encodeFunctionData({ abi: testUsdAbi, functionName: "faucet" }),
    summary: `${f.symbol} faucet(): ${formatUsdg(f.amountRaw)} ${f.symbol} to the sender (testnet, no value; once per ${Math.round(f.cooldownS / 3600)} h)`,
  };
}

export interface FaucetStatus {
  token: Address;
  symbol: string;
  account: Address;
  /** False when the token has no code yet (the operator has not deployed it). */
  deployed: boolean;
  balanceRaw: bigint;
  /** 0 = never drew; otherwise when the next draw is allowed (unix seconds). */
  nextFaucetAt: bigint;
  now: bigint;
  canDrawNow: boolean;
  amountRaw: bigint;
}

/** The account's TestUSD balance and next draw time, read from the chain. */
export async function readFaucet(chainId: number, account: Address, opts: { rpcUrl?: string; publicClient?: PublicClient<Transport, Chain> } = {}): Promise<FaucetStatus> {
  const f = getFaucet(chainId);
  const chain = chains[chainId]!;
  const client = opts.publicClient ?? createPublicClient({ chain, transport: http(opts.rpcUrl ?? chain.rpcUrls.default.http[0]) });
  const [code, block] = await Promise.all([client.getCode({ address: f.token }), client.getBlock()]);
  const base = { token: f.token, symbol: f.symbol, account, now: block.timestamp, amountRaw: f.amountRaw };
  if (!code || code === "0x") return { ...base, deployed: false, balanceRaw: 0n, nextFaucetAt: 0n, canDrawNow: false };
  const [balanceRaw, nextFaucetAt] = await Promise.all([
    client.readContract({ address: f.token, abi: testUsdAbi, functionName: "balanceOf", args: [account] }),
    client.readContract({ address: f.token, abi: testUsdAbi, functionName: "nextFaucetAt", args: [account] }),
  ]);
  return { ...base, deployed: true, balanceRaw, nextFaucetAt, canDrawNow: nextFaucetAt <= block.timestamp };
}

/** Why a draw would fail now, or undefined when it would succeed. */
export function faucetRefusal(s: FaucetStatus): string | undefined {
  if (!s.deployed) return `${s.symbol} is not deployed at ${s.token} yet on this chain`;
  if (!s.canDrawNow) return `faucet cooldown: ${s.account} may draw again at ${new Date(Number(s.nextFaucetAt) * 1000).toISOString()} (unix ${s.nextFaucetAt})`;
  return undefined;
}

export interface FaucetDraw {
  before: FaucetStatus;
  request: TxRequest;
  /** Why nothing was sent or simulated (not deployed, cooldown). */
  refused?: string;
  send?: SendResult;
  status?: "success" | "reverted";
  after?: FaucetStatus;
}

/**
 * Draws from the chain's faucet with `signer` (the tokens land in the signer's wallet): reads the cooldown first and
 * refuses without sending; otherwise simulates and, unless `dryRun` (default true), sends and waits for the receipt.
 */
export async function drawFaucet(chainId: number, signer: LocalAccount, opts: { rpcUrl?: string; dryRun?: boolean; publicClient?: PublicClient<Transport, Chain> } = {}): Promise<FaucetDraw> {
  const chain = chains[chainId];
  if (!chain) throw new Error(`unsupported chain ${chainId}`);
  getFaucet(chainId);
  const rpcUrl = opts.rpcUrl ?? chain.rpcUrls.default.http[0]!;
  const publicClient = opts.publicClient ?? createPublicClient({ chain, transport: http(rpcUrl) });
  const before = await readFaucet(chainId, signer.address, { publicClient });
  const request = encodeFaucet(chainId);
  const refused = faucetRefusal(before);
  if (refused) return { before, request, refused };
  const send = await sendTxRequest({ chain, rpcUrl, publicClient, signer }, request, { dryRun: opts.dryRun ?? true });
  if (send.dryRun) return { before, request, send };
  const receipt = await publicClient.waitForTransactionReceipt({ hash: send.hash! });
  return { before, request, send, status: receipt.status, after: await readFaucet(chainId, signer.address, { publicClient }) };
}
