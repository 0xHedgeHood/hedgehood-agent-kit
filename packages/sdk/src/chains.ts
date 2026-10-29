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
  /** Testnet only: the public test-token faucet (TestUSD `faucet()`), when deployed. */
  faucet?: FaucetDeployment;
  /** Hedgehood agent-market backend hosts (the same hosts serve both chains; the chain id selects the deployment). */
  api: BackendHosts;
  markets: MarketDeployment[];
  /** The Stock Yield vaults (v2 `EpochFund` hub) on this chain, when deployed. */
  vaults?: VaultDeployment;
  /** Share lending (a Morpho Blue market on fund shares + the USDG lending vault) on this chain, when deployed. */
  lending?: LendingDeployment;
}

/**
 * TestUSD ("Hedgehood Test USD", hUSD-test): the testnet settlement token with NO value. `faucet()` mints `amountRaw`
 * to the caller once per `cooldownS` per address; `nextFaucetAt(account)` is 0 or the time of the next draw; the owner
 * mints the desk's collateral. EIP-2612 permit and EIP-3009 transferWithAuthorization under the EIP-712 domain
 * {name "Hedgehood Test USD", version "1"}. Source: hedgehood-options contracts/src/mocks/TestUSD.sol, deployed with
 * CREATE2 (contracts/script/testnet/DeployTestUSD.s.sol), so the address is fixed before the broadcast.
 */
export interface FaucetDeployment {
  token: Address;
  symbol: string;
  amountRaw: bigint;
  cooldownS: number;
  eip712: { name: string; version: string };
  note?: string;
}

/** One Morpho Blue market; its id is `keccak256(abi.encode(loanToken, collateralToken, oracle, irm, lltv))`. */
export interface LendingMarket {
  id: `0x${string}`;
  loanToken: Address;
  /** The fund share token (an `EpochFund`) pledged as collateral. */
  collateralToken: Address;
  /** `ShareRiskOracle`: a conservative share value in Blue's 1e36 price format, marked weekly after the Monday lock. */
  oracle: Address;
  irm: Address;
  /** Liquidation loan-to-value, WAD (625000000000000000n = 62.5%). */
  lltv: bigint;
  note?: string;
}

/**
 * Share lending on one chain: the Morpho Blue core, the USDG lending vault (Morpho Vault V2, ERC-4626, "hhUSDG") whose
 * liquidity adapter supplies the Blue market, and the market list at the time of writing. The vault is the source of
 * truth at runtime: `LendingClient.discoverMarkets()` reads its liquidity adapter / data and the adapter's allocated
 * market ids, and only falls back to `markets` here when that fails, so a market migration (a new oracle means a new
 * market id) needs no code change for agents.
 */
export interface LendingDeployment {
  /** Morpho Blue core (canonical on mainnet; a test instance on testnet). */
  blue: Address;
  /** The USDG lending vault (Morpho Vault V2, ERC-4626). */
  vault: Address;
  /** The vault's `MorphoMarketV1AdapterV2` at the time of writing (re-read from the vault at runtime). */
  adapter?: Address;
  usdg: Address;
  markets: LendingMarket[];
  deployBlock?: bigint;
  note?: string;
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
 * Deployment registry. Testnet 46630 lists the 19 CashOptionMarketV2 deployments redeployed 2026-10-29 from
 * hedgehood-options main after the red-team round 2 (#58) (same list as its config/agent_markets.testnet.json): fixture
 * tokens and keeper-pushed fixture feeds, protocol fee 150 bps to a testnet FeeSweeper: not mainnet configuration. Mainnet 4663 has no V2 market yet (empty list on
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
    // ERC-8004 reference deployment, testnet address (erc-8004/erc-8004-contracts TESTNET_ADDRESSES): live on 46630, proxy ->
    // IdentityRegistryUpgradeable 0x7274…9c02 (getVersion 2.0.0, owner 0x5472…2603), read 2026-10-28. The mainnet address
    // 0x8004A169… is the reference's MAINNET vanity proxy and has no code on 46630.
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    faucet: {
      token: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
      symbol: "hUSD-test",
      amountRaw: 1_000_000_000n,
      cooldownS: 86_400,
      eip712: { name: "Hedgehood Test USD", version: "1" },
      note: "TestUSD, CREATE2 address pinned by hedgehood-options DeployTestUSD.EXPECTED; the settlement token of the 19 testnet markets since their 2026-10-29 redeploy",
    },
    api: HEDGEHOOD_API,
    markets: [
      {
        underlying: "NVDA",
        market: "0x4c475Dd1fd756a086d053510A25dc046231A3D38",
        orderBook: "0xCEa2be1ecC16D347bE1A4fEA589e21de0Ad7E6C3",
        underlyingToken: "0x267ddeE02B44FDF4D073E124869DaA5BDbF1759D",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x366Bb774964b5CE878A103092DE495310Ef81880",
        deployBlock: 144563038n,
        protocolFeeBps: 150,
        note: "tNVDA2 with a keeper-pushed fixture feed; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "AMD",
        market: "0xc5C2FB4392ad74b664218517a28e17d407252ffc",
        orderBook: "0xc2FA87fc1de14b223ccd384c8d7118bFED9ea7AA",
        underlyingToken: "0xB07D757771d147e512C419DbAFCb735F90d73575",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0xede06183844Ae5600eC715d440A6CfdcE4537070",
        deployBlock: 144563323n,
        protocolFeeBps: 150,
        note: "tAMD MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "MU",
        market: "0x60d980075193f708c11180050F89C07939Cd6c54",
        orderBook: "0xbbC54bF2f9aB9D62E2291055fC937F271823DE7b",
        underlyingToken: "0xf85e26a0bB2094bC9af6b9DEb40eaA70E54fB37E",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x44d0DE4d91ec29407dA50A7Bd7CB5112d1fC134e",
        deployBlock: 144563565n,
        protocolFeeBps: 150,
        note: "tMU MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "SNDK",
        market: "0x192F0F74826cC1340B0da794D0Eb0E3d1fDA23BF",
        orderBook: "0xa2cA7719A61eb65Bbca53108118b43A6690d2C13",
        underlyingToken: "0x2553505baEa07d842716AdE8B23353e81808493d",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x2534247dCc7b2C692027D558dfEFFB46181cBff4",
        deployBlock: 144563806n,
        protocolFeeBps: 150,
        note: "tSNDK MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "CRWV",
        market: "0x4DA5911aF149683C2C0a814290870F44Fa172EA5",
        orderBook: "0x0C543de7dd8D5532A58a2733b2E7bf83d6f9CCca",
        underlyingToken: "0x4B2c4a8212a8faFB707c63bDDE13Be0C93e3d1cD",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x607ccB310cda71Fba1125371F6A17Cb64a5Eae4c",
        deployBlock: 144564081n,
        protocolFeeBps: 150,
        note: "tCRWV MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "NBIS",
        market: "0x9fb0cd2d9c8cAf1bdb3213efdcbE30f72ff87925",
        orderBook: "0x2244253805798b4702Ef1a0fC9aE657c70982e5C",
        underlyingToken: "0x9f93ab0F25b53B2998D6881bef95eB8f93C0dD6e",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x78523f90e69B50565e79dF90A0B59E56afB787d9",
        deployBlock: 144564362n,
        protocolFeeBps: 150,
        note: "tNBIS MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "IONQ",
        market: "0x4884AD8bD623de6633d0168acFD965dE18c2A41E",
        orderBook: "0x3d1E064Bf2911763277e09E0a3b8c7a7aa1409B9",
        underlyingToken: "0x8925aB3C8BaF0913227Eb660A6338BAc67f9dd5E",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x5FB60220F02eEb4441845b6Cb69211aD32b2a403",
        deployBlock: 144564633n,
        protocolFeeBps: 150,
        note: "tIONQ MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "INTC",
        market: "0xaD1E74b8F0CCFf0dB7C4aae7105FeF779394aCe6",
        orderBook: "0x35c421B1BfcA2c99CFDfe78d696307383EE81023",
        underlyingToken: "0xD11A0c7365d0a88c2276ee27A3040D595ef9E08C",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0xbeDFe3ff97b8012B9c3F979C6551998bf86016c4",
        deployBlock: 144564904n,
        protocolFeeBps: 150,
        note: "tINTC MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "TSM",
        market: "0x65db062E52868138607371a6D1e301CA935ca5F2",
        orderBook: "0x3b67Ea698855F31478141666Be9e24c38296eAEc",
        underlyingToken: "0xC1AE60cF5c5Cca202Bc1829a47f6a8679e058b54",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x0650A04f0Ba045dBa48272cd2315644F0F74F2C0",
        deployBlock: 144565173n,
        protocolFeeBps: 150,
        note: "tTSM MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "ASML",
        market: "0x25a81F123dEb1F98442194249CAE64A174Fc5169",
        orderBook: "0xC059189A37c8A1ebaB9333D330dA2D389606FE12",
        underlyingToken: "0x1059c798628cEc644030AD1c0129c45BFCb172eC",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x47698fd5Cf2AB44E99328Fd1d6C95Fbd834D4981",
        deployBlock: 144565413n,
        protocolFeeBps: 150,
        note: "tASML MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "TSLA",
        market: "0xcCD70a4fa22185860124a1f66FB2993B3a9ef80f",
        orderBook: "0x8c8b070f23bd1045121cD55983029f5A1AE02a7b",
        underlyingToken: "0x6661d20C2e343Bb78B42535eB060C3058c744f3F",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x5E332BAa4F5FCf20816B9E0eF00D8Fa86eaE5219",
        deployBlock: 144565674n,
        protocolFeeBps: 150,
        note: "tTSLA MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "PLTR",
        market: "0xcEDE24F99daad4aC675e3a8E703399d5f3B4FA15",
        orderBook: "0x4dCCeAC7a80db484cfEA955A22ab6C2eD9E2b9e8",
        underlyingToken: "0x2250aC7885Ad897c30362b9318050Ed43dcDbEc0",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0xE949D5bFba4F341B2406129577693D0B0d5Afa04",
        deployBlock: 144565940n,
        protocolFeeBps: 150,
        note: "tPLTR MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "GME",
        market: "0x73aB93b34Aa8Ae578b281a75D565ad4DaFbC286A",
        orderBook: "0xD9316aD79a6cA6fFa8BED9d0be99C464Fbc4b968",
        underlyingToken: "0x3daAadb9cb2D3B082162C8d541Baf19271B41344",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x21811FeF0A53772ef3A95Fa7f5f70107e52a1532",
        deployBlock: 144566211n,
        protocolFeeBps: 150,
        note: "tGME MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "MSTR",
        market: "0xfaedb2D4FBf37bB25d3dC32F8A896C5B72ed51C2",
        orderBook: "0xba9f92CF1be0d25497d88E4a35d7191aa2bc8D21",
        underlyingToken: "0x2EcC38721c57344A75DE4e21ffE9b961b1d334F8",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x09db6DB943dE4aE33Fb6ce445BB72E4f2f8802b6",
        deployBlock: 144566480n,
        protocolFeeBps: 150,
        note: "tMSTR MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "COIN",
        market: "0x3C0620bbAeE6ebFc7884C721624f177198A72A6b",
        orderBook: "0xb1d2bEDe5A3a6b5889c2542957b0640C031990e2",
        underlyingToken: "0x6a2Ff1D600A6F257d6cd5A5b200BFD9759C22Ce7",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0xA340A4DdbB65c90cCa02bB4c649520f92d0FDa4a",
        deployBlock: 144566746n,
        protocolFeeBps: 150,
        note: "tCOIN MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "CRCL",
        market: "0xbfe2f649bac4F74b34E28265191DEEa8bC10e2F6",
        orderBook: "0xa3997D3B6253199df36da8A1bcF6038aD597b97E",
        underlyingToken: "0x6A4Cda655318224d900E527c8eA77866a17D3847",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x68f456B7E941Ad1a412af659fA178F2988DdA9bB",
        deployBlock: 144567009n,
        protocolFeeBps: 150,
        note: "tCRCL MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "RKLB",
        market: "0x28A499EE65cAf449CdD6DdC029988054bea7aff5",
        orderBook: "0x6Cd7B8dE80739227A42b3022E58587a6a42910B7",
        underlyingToken: "0xFE1521Ac9062A85467bce0EFD40e328219426C55",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x610a206da1269abBf0bCC49a2Ba0F6Abb5d97005",
        deployBlock: 144567265n,
        protocolFeeBps: 150,
        note: "tRKLB MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "RGTI",
        market: "0xdE1142a72201ABB66Ca00140c35a1B8c64d6A0f0",
        orderBook: "0x120E3C26756E7bf0924A3f5b2bc18A65DEe3fC28",
        underlyingToken: "0x45Dec2207551110D0f997Be010866A86f537bE8B",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0xaDAD395D767fF596cb8582A72Ad58c6ccCF9B82F",
        deployBlock: 144567516n,
        protocolFeeBps: 150,
        note: "tRGTI MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "ORCL",
        market: "0x2e0902Dae41CDC067044d6cBBDFce3DcD913A15A",
        orderBook: "0x88066e91Cb405212D29721F416cBb085a48C17C1",
        underlyingToken: "0xd6573251eC99434CE195Bc973b191CAF5Af64EE9",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x3F3A523a944E5CC24d5bc58152399B24CDb8F175",
        deployBlock: 144567780n,
        protocolFeeBps: 150,
        note: "tORCL MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
      },
      {
        underlying: "GOOGL",
        market: "0x8b51467DB7a822c10286059199bd2574Baa19De8",
        orderBook: "0xAeaD738d9D00Ead829B21b3A28B1235fd727316D",
        underlyingToken: "0xc9d73d982EB397b157cc143d4d8d094fA2D88c23",
        settlementToken: "0x850DE815d41F6983Aaf09247f9a465c0aefff04C",
        source: "0x77db26de1Aa844073e443712eD63DD0A981c7Ca3",
        deployBlock: 144861450n,
        protocolFeeBps: 150,
        note: "tGOOGL MockStockToken + MockPushFeed fixture; settled in TestUSD (hUSD-test), deployed 2026-10-29 with hedgehood-options contracts/script/testnet/deploy-all.sh; not mainnet configuration",
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
    lending: {
      blue: "0xa0BA91A2F99894044CCD82cA48e5C795BA7570B6",
      vault: "0x6ab073F0E3F1610C4Ad9e7Dc19Ca25F831682f00",
      adapter: "0x89ace3cb69f676d41aBa380563F267cD7b8A98f3",
      usdg: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
      markets: [
        {
          id: "0x375cd2da2b6d1cdd8288331d388f795784917a0ac704732e91c92bde6b9832df",
          loanToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
          collateralToken: "0x2a7CC7E34a1CFAda9e3aeA978e805dbaB05D83b4",
          oracle: "0x1291A39e96Cd1ce736084548b15532D9a8D4bE77",
          irm: "0xAf61C1DEDffD90D39E7D90641A8AB1B59497a9fF",
          lltv: 625000000000000000n,
          note: "v5 oracle market on the test Blue instance (hedgehood-vaults local/share-collateral-a/deployment-46630-v5.json)",
        },
      ],
      deployBlock: 139866161n,
      note: "test Blue instance + AdaptiveCurveIrm copy, hhNVDA-CC shares vs tUSDG, v5 ShareRiskOracle; lending vault hhUSDG (local/share-collateral-a/lending-vault-46630.json, timelock 0, EOA curator): PoC parameters, not mainnet configuration",
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
    lending: {
      blue: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
      vault: "0x54Bc097643BB9fd4ab004f11859893655529E954",
      adapter: "0xdEbAd49D242967CBf0DDAe8626873ad54cF7878A",
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      markets: [
        {
          id: "0x789202f84d066bdad8115d39d5dea0af80ccd52dd6727461d98daa638ed9b7aa",
          loanToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
          collateralToken: "0x4a1c42b0E0D229B677D574d3dCdc2A5Dff848373",
          oracle: "0x6EcA44BBB41D3176A451910C4f735A51AdAb4237",
          irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
          lltv: 625000000000000000n,
          note: "collateral-01: hhNVDA-CC shares vs USDG, live 2026-10-26 (hedgehood-vaults local/share-collateral-a/deployment-4663.json). Scheduled to migrate to a new ShareRiskOracle (new market id) before 2026-12-24; the vault's liquidity market is read at runtime",
        },
      ],
      note: "canonical Morpho Blue on Robinhood Chain, AdaptiveCurveIrm 0x2BD3…0fa1, LLTV 62.5%; lending vault hhUSDG = Morpho Vault V2 (local/share-collateral-a/lending-vault-4663.json): owner/curator/allocator Safe 0xB5C9…489b, 24 h timelock, absolute cap 20k USDG on the market, performance fee 10%",
    },
  },
};

/** The share lending deployment of a chain, or a clear error. */
export function getLending(chainId: number): LendingDeployment {
  const l = getDeployment(chainId).lending;
  if (!l) throw new Error(`share lending is not deployed on chain ${chainId}`);
  return l;
}

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
