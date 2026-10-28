import { createPublicClient, decodeEventLog, encodeFunctionData, http, type Address, type Hex, type TransactionReceipt } from "viem";
import { identityRegistryAbi } from "./abi/identityRegistry.js";
import { chains, getDeployment } from "./chains.js";
import type { TxRequest } from "./calldata.js";

/** ERC-8004 Identity Registry on Robinhood Chain mainnet. */
export const IDENTITY_REGISTRY_4663: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

export function identityRegistryFor(chainId: number): Address {
  const addr = getDeployment(chainId).identityRegistry;
  if (!addr) throw new Error(`no ERC-8004 identity registry known on chain ${chainId}`);
  return addr;
}

/** Minimal ERC-8004 registration file an agent can host at `agentURI`. */
export interface AgentRegistrationFile {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
  name: string;
  description?: string;
  image?: string;
  services?: Array<{ name: string; endpoint: string; version?: string }>;
  /** Hedgehood extension: the trading account this agent acts for (its owner EOA / contract wallet). */
  "x-hedgehood"?: { account: Address; sessionKey?: Address; chainId: number };
}

export function buildRegistrationFile(args: { name: string; description?: string; account: Address; sessionKey?: Address; chainId: number; mcpEndpoint?: string }): AgentRegistrationFile {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: args.name,
    description: args.description,
    services: args.mcpEndpoint ? [{ name: "MCP", endpoint: args.mcpEndpoint }] : undefined,
    "x-hedgehood": { account: args.account, sessionKey: args.sessionKey, chainId: args.chainId },
  };
}

/** A `data:application/json;base64,...` URI for a registration file, when no hosting is wanted. */
export function dataUri(file: AgentRegistrationFile): string {
  const bytes = new TextEncoder().encode(JSON.stringify(file));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:application/json;base64,${btoa(bin)}`;
}

/** `register(agentURI)` calldata to the chain's registry. Optional: the market does not require it. */
export function encodeRegisterAgent(chainId: number, agentURI: string, registry = identityRegistryFor(chainId)): TxRequest {
  return {
    to: registry,
    data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [agentURI] }),
    summary: `ERC-8004 register(${agentURI.length > 60 ? agentURI.slice(0, 57) + "..." : agentURI})`,
  };
}

/** The agentId minted by a `register` transaction, read from its `Registered` log. */
export function agentIdFromReceipt(receipt: TransactionReceipt, registry: Address): bigint | undefined {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: identityRegistryAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "Registered") return ev.args.agentId;
    } catch {
      /* not ours */
    }
  }
  return undefined;
}

export async function readAgentURI(chainId: number, agentId: bigint, rpcUrl?: string): Promise<{ uri: string; owner: Address }> {
  const chain = chains[chainId];
  if (!chain) throw new Error(`unsupported chain ${chainId}`);
  const client = createPublicClient({ chain, transport: http(rpcUrl ?? chain.rpcUrls.default.http[0]) });
  const registry = identityRegistryFor(chainId);
  const [uri, owner] = await Promise.all([
    client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "tokenURI", args: [agentId] }),
    client.readContract({ address: registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }),
  ]);
  return { uri, owner };
}

export type { Hex as RegisterTxHash };
