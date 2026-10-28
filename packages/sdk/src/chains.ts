import { defineChain, type Address, type Chain } from "viem";

/** Robinhood Chain mainnet (Arbitrum Orbit, chain id 4663). */
export const robinhoodChain: Chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.chain.robinhood.com" } },
});

/** Robinhood Chain testnet (chain id 46630). */
export const robinhoodTestnet: Chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export const chains: Record<number, Chain> = {
  [robinhoodChain.id]: robinhoodChain,
  [robinhoodTestnet.id]: robinhoodTestnet,
};

export type SupportedChainId = 4663 | 46630;

/** One underlying's V2 market: a CashOptionMarketV2 and the CashOptionOrderBookV2 bound to it. */
export interface MarketDeployment {
  /** Ticker of the underlying stock token, e.g. "NVDA". */
  underlying: string;
  market: Address;
  orderBook: Address;
  /** The 18-decimal stock token the market settles against (per-share strikes). */
  underlyingToken: Address;
  /** USDG (6 decimals) on this chain. */
  settlementToken: Address;
  /** ISettlementSource (ChainlinkExpirySource) the market reads expiry prices from. */
  source?: Address;
  /** Block the market was deployed in, for log scans. */
  deployBlock?: bigint;
  /** Protocol fee the book charges takers, in bps of their pro rata premium. */
  protocolFeeBps?: number;
  /** Provenance note (deployment record, date). */
  note?: string;
}

export interface ChainDeployment {
  chainId: SupportedChainId;
  /** CAIP-2 network id used by x402. */
  caip2: `eip155:${number}`;
  /** USDG (Global Dollar) on this chain; the only token the x402 payer signs for. */
  usdg: Address;
  usdgDecimals: 6;
  /** EIP-712 domain of the USDG token, for EIP-3009 TransferWithAuthorization. */
  usdgEip712: { name: string; version: string };
  /** ERC-8004 Identity Registry, when deployed on this chain. */
  identityRegistry?: Address;
  /** Default Hedgehood agent-market backend (RFQ, deposit gateway, hosted MCP). */
  apiUrl?: string;
  markets: MarketDeployment[];
}

/**
 * Deployment registry. Testnet 46630 is the CashOptionMarketV2 for tNVDA2 recorded in hedgehood-options
 * contracts/script/config/market-v2.46630.deployed.json (2026-10-28). It runs on fixture feeds (hh-price-pusher) and a
 * MockHourlyFeed USDG/USD stand-in: not mainnet configuration. Mainnet 4663 has no V2 market yet (empty list on
 * purpose; the USDG and identity-registry addresses are real).
 */
export const deployments: Record<SupportedChainId, ChainDeployment> = {
  46630: {
    chainId: 46630,
    caip2: "eip155:46630",
    usdg: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
    usdgDecimals: 6,
    // tUSDG is a test token; assumed to expose the same EIP-3009 surface and domain name as mainnet USDG. If the
    // gateway's 402 names another domain in `extra`, the payer signs on that one (see x402.ts).
    usdgEip712: { name: "Global Dollar", version: "1" },
    apiUrl: "https://agents-testnet.hedgehood.app",
    markets: [
      {
        underlying: "NVDA",
        market: "0xC289617d613C9865a6595B365DaD88277282e0Ac",
        orderBook: "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5",
        underlyingToken: "0x267ddeE02B44FDF4D073E124869DaA5BDbF1759D",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0xc599E3B843D30010b555A08E041Db77DAE33DBb9",
        deployBlock: 143952569n,
        protocolFeeBps: 50,
        note: "tNVDA2 on Robinhood testnet, deployed 2026-10-28; fixture feeds, not mainnet configuration",
      },
    ],
  },
  4663: {
    chainId: 4663,
    caip2: "eip155:4663",
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    usdgDecimals: 6,
    usdgEip712: { name: "Global Dollar", version: "1" },
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    apiUrl: "https://agents.hedgehood.app",
    markets: [], // V2 not deployed on mainnet yet (pending audit)
  },
};

export function getDeployment(chainId: number): ChainDeployment {
  const d = deployments[chainId as SupportedChainId];
  if (!d) throw new Error(`unsupported chain id ${chainId} (known: ${Object.keys(deployments).join(", ")})`);
  return d;
}

/** The market for an underlying ticker on a chain, or a clear error. */
export function getMarket(chainId: number, underlying = "NVDA"): MarketDeployment {
  const d = getDeployment(chainId);
  const m = d.markets.find((x) => x.underlying.toUpperCase() === underlying.toUpperCase());
  if (!m) {
    throw new Error(
      d.markets.length === 0
        ? `no V2 market deployed on chain ${chainId} yet`
        : `no market for ${underlying} on chain ${chainId} (known: ${d.markets.map((x) => x.underlying).join(", ")})`,
    );
  }
  return m;
}
