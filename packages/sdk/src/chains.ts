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
  /** Hedgehood agent-market backend hosts (the same hosts serve both chains; the chain id selects the deployment). */
  api: BackendHosts;
  markets: MarketDeployment[];
  /** The Stock Yield vaults (v2 `EpochFund` hub) on this chain, when deployed. */
  vaults?: VaultDeployment;
}

/** One Stock Yield fund: an `EpochFund` holding one tokenized stock and USDG, issuing transferable NAV shares. */
export interface VaultFund {
  /** Share symbol, e.g. "hhNVDA-CC" (hh + stock + strategy code). */
  symbol: string;
  vault: Address;
  /** The 18-decimal stock token the fund holds. */
  stock: Address;
  stockSymbol: string;
  /** Strategy code: CC (covered call), WHEEL, CSP, CCC. */
  strategy: string;
}

/**
 * The v2 Stock Yield vault stack on one chain: the `VaultRegistry` that lists the funds (the on-chain source of truth
 * at runtime; `funds` below is the list at the time of writing, for symbol lookup and documentation), the deposit gates
 * the funds use, and the public read API (mainnet only) `VaultClient.listVaults` enriches from.
 */
export interface VaultDeployment {
  registry: Address;
  /** `OpenDepositGate`: admits every account the owner has not banned (every mainnet fund since 2026-10-18). */
  openGate?: Address;
  /** `StakeThresholdGate`: admits accounts meeting the HEDGE staking threshold (the initial mainnet gate). */
  stakeGate?: Address;
  usdg: Address;
  funds: VaultFund[];
  /** `GET` → `{ chainId, funds: [...], builtAt }`: the funds' on-chain snapshots, read once for every visitor. */
  api?: string;
  deployBlock?: bigint;
  note?: string;
}

/** The backend services (hedgehood-options `feat/rfq-backend`): RFQ quote service, indexer, x402 deposit gateway, hosted read-only MCP. */
export interface BackendHosts {
  /** Quote service: GET /v1/markets, /v1/instruments, /v1/mark, POST /v1/rfq, POST /v1/rpc (AirSwap-style JSON-RPC). */
  rfq: string;
  /** Fill watcher: GET /v1/positions, /v1/fills, /v1/leaderboard, /v1/agents/{id}, /v1/quotes/{digest}. */
  indexer: string;
  /** x402 deposit gateway: POST /v1/deposit, GET /v1/instructions, /v1/deposits. */
  gateway: string;
  /** Hosted read-only MCP (streamable HTTP). */
  mcp: string;
}

/** Planned public hostnames (not reachable yet as of 2026-10-28; the stack runs on the host in testnet dry-run mode). */
export const HEDGEHOOD_API: BackendHosts = {
  rfq: "https://agent-api.hedgehood.io",
  indexer: "https://agent-index.hedgehood.io",
  gateway: "https://agent-pay.hedgehood.io",
  mcp: "https://mcp.hedgehood.io/mcp",
};

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
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", // in the backend's testnet registry; not verified to exist on 46630
    api: HEDGEHOOD_API,
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
    vaults: {
      registry: "0xBeE38aF4Fc4f50A0C04bDdA45Bec6cBABFf476b9",
      openGate: "0x5b4EE28Efc1f545f9D24f9474F0AeE9c22f8eBD6",
      stakeGate: "0x4afEE26277FAd0CC57da204126ceCC4Ae694a5B7",
      usdg: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
      funds: [{ symbol: "hhNVDA-CC", vault: "0x2a7CC7E34a1CFAda9e3aeA978e805dbaB05D83b4", stock: "0x267ddeE02B44FDF4D073E124869DaA5BDbF1759D", stockSymbol: "NVDA", strategy: "CC" }],
      deployBlock: 134760389n,
      note: "v2 hub pilot redeployed 2026-10-14 (hedgehood-vaults local/testnet-hub-20261013-2359/deployment.json); the fund's depositGate() is an OpenDepositGate (read on chain 2026-10-28); open-mint tNVDA2, fixture feed, TestnetOwnerModule owner: not mainnet configuration",
    },
  },
  4663: {
    chainId: 4663,
    caip2: "eip155:4663",
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    usdgDecimals: 6,
    usdgEip712: { name: "Global Dollar", version: "1" },
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    api: HEDGEHOOD_API,
    markets: [], // V2 not deployed on mainnet yet (pending audit)
    vaults: {
      registry: "0x868502F926AE068B61EA9CC55042A9F962651e76",
      openGate: "0x337B27c931873e6Ef087e8f84034b96F1d6eeFA5",
      stakeGate: "0xDE1c8Af7ac54D8422Bbc80A9fb2278a5fFB87e15",
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      funds: [
        { symbol: "hhNVDA-CC", vault: "0x4a1c42b0E0D229B677D574d3dCdc2A5Dff848373", stock: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", stockSymbol: "NVDA", strategy: "CC" },
        { symbol: "hhNVDA-WHEEL", vault: "0x78FA8c1294553894F7AD7f2eDf4D1E17B61188bD", stock: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", stockSymbol: "NVDA", strategy: "WHEEL" },
        { symbol: "hhGOOGL-CC", vault: "0x70E8198C7281d9FC42eE828DD7fa80732b0dBF13", stock: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", stockSymbol: "GOOGL", strategy: "CC" },
        { symbol: "hhTSLA-CC", vault: "0x2b62087D9065D106FEb5547e63370A67b6097b8C", stock: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", stockSymbol: "TSLA", strategy: "CC" },
        { symbol: "hhAMZN-CC", vault: "0x40ddB6576840F636122A9C7afe94f45Cf744902d", stock: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", stockSymbol: "AMZN", strategy: "CC" },
        { symbol: "hhMETA-CC", vault: "0x4E41Ef5EBdad32fA336E4b6d8968a974E71ccb1F", stock: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", stockSymbol: "META", strategy: "CC" },
        { symbol: "hhAAPL-CC", vault: "0xE0bBb2aAB7399E6140cA48970894333f0618CE80", stock: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", stockSymbol: "AAPL", strategy: "CC" },
        { symbol: "hhMSFT-CC", vault: "0xaEBfBDc1965C6466988b8F55a04945FC25a43e89", stock: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", stockSymbol: "MSFT", strategy: "CC" },
      ],
      api: "https://hedgehood.app/api/stockyield/funds",
      note: "deployed 2026-10-15, OpenDepositGate since 2026-10-18 (hedgehood-vaults docs/OPTION_VAULT_V2.md, contracts/script/config/v2.4663.json); owner Safe 0xB5C9…489b; Sourcify-verified",
    },
  },
};

/** The Stock Yield vault deployment of a chain, or a clear error. */
export function getVaults(chainId: number): VaultDeployment {
  const v = getDeployment(chainId).vaults;
  if (!v) throw new Error(`no Stock Yield vaults deployed on chain ${chainId}`);
  return v;
}

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
