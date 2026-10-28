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
  /** Share lending (a Morpho Blue market on fund shares + the USDG lending vault) on this chain, when deployed. */
  lending?: LendingDeployment;
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
 * Deployment registry. Testnet 46630 lists the 19 CashOptionMarketV2 deployments made 2026-10-28 from hedgehood-options
 * main after the internal-review fixes (#54) with local/testnet-v2/deploy.sh (NVDA on tNVDA2, 18 underlyings on mock
 * fixtures; protocol fee 150 bps to a testnet FeeSweeper): not mainnet configuration. Mainnet 4663 has no V2 market yet (empty list on
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
        market: "0xeF80f9ABc9590DBC76ccEFBa0D8975FC79E305A1",
        orderBook: "0x34BA908e8aaaD48c5c9478ad6B8bB5A7394aC709",
        underlyingToken: "0x267ddeE02B44FDF4D073E124869DaA5BDbF1759D",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x5678E036755044abAF4b760f1C3eAF0260110398",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tNVDA2 fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "AMD",
        market: "0x0474150eDAad257659669f27397e306F1ee9a708",
        orderBook: "0xA9Bfa2BB8C4Cb4254f2933c94338115f4e05D586",
        underlyingToken: "0xB07D757771d147e512C419DbAFCb735F90d73575",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x3DD60Ed107037A496556355DB40f6b468f0D4440",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tAMD MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "MU",
        market: "0x77BD2702aF883eC8417a71AFC19Cb6F5aE78429A",
        orderBook: "0xcAfcE2fa7b855fE20cD18cD07D5b7F4Fc03b19f7",
        underlyingToken: "0xf85e26a0bB2094bC9af6b9DEb40eaA70E54fB37E",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x576c047972D25f3EDD0240Fc45EC526C8Bb8332B",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tMU MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "SNDK",
        market: "0x6dB31F0536ac924AD2BaaE9e5343Bf147a1CB6c9",
        orderBook: "0x7f2dF0550fF476dCaD0228E0bDA74b560c9eA5D2",
        underlyingToken: "0x2553505baEa07d842716AdE8B23353e81808493d",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x57777B9589edF77bAD78A22c06D025D6DE5f757e",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tSNDK MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "CRWV",
        market: "0xA6b38120c04D49eED59ba1E79f8DF4Bb237A4Fe7",
        orderBook: "0xbcd82714269A5377aA6Ef5C6631a5171b95D934F",
        underlyingToken: "0x4B2c4a8212a8faFB707c63bDDE13Be0C93e3d1cD",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x026C2D7104DF599333F16CE5D815CE12D481818A",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tCRWV MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "NBIS",
        market: "0x515A33d92c4A7851cA4A10b7Fb9c353928Fa9ddE",
        orderBook: "0xd542E82DeCdb286EAc96106E3F89123406505937",
        underlyingToken: "0x9f93ab0F25b53B2998D6881bef95eB8f93C0dD6e",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x9E76c8213200983974886C596Bf6706243a05079",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tNBIS MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "IONQ",
        market: "0x3625Cab226CF40B0023fB02510B7069c8BefA387",
        orderBook: "0x34CD2014EFAe1e53733628Bfe990D287d493D777",
        underlyingToken: "0x8925aB3C8BaF0913227Eb660A6338BAc67f9dd5E",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x6E915484B09a06cc68590b135d7DD5B69877Ad6f",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tIONQ MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "INTC",
        market: "0x7EcB7df18aAa3AF2fd893CDb463cff22ef8E5ad4",
        orderBook: "0xdbD2c697baCe1A37b067728276F938e11E27011F",
        underlyingToken: "0xD11A0c7365d0a88c2276ee27A3040D595ef9E08C",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0xF28FA72fd0A67b5ACcbbE821413D32Cde41Da7b2",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tINTC MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "TSM",
        market: "0x48A9cFd2F0E622c313bdF9621220502149D7CBF6",
        orderBook: "0x2d0735e82B6aE09A246308a0f9924eE9431DC35b",
        underlyingToken: "0xC1AE60cF5c5Cca202Bc1829a47f6a8679e058b54",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0xe81bF3936921309b507a2112e587A9568405601a",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tTSM MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "ASML",
        market: "0x4456382eC158a1b382977b25103915944872C75a",
        orderBook: "0xD91991f172e20336282E93129a3539928164F1Ea",
        underlyingToken: "0x1059c798628cEc644030AD1c0129c45BFCb172eC",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x6Bf08E18c9B3540798E394A6198BE79090D94839",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tASML MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "TSLA",
        market: "0xC372Ddd6Db33B5aF532E0Ed39d4bD857144e9A1a",
        orderBook: "0x70129dee7D2B1412093Ffa8F1667f3F0634ae721",
        underlyingToken: "0x6661d20C2e343Bb78B42535eB060C3058c744f3F",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0xf0777738E164cDF9AaF705a7C98758656c5De749",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tTSLA MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "PLTR",
        market: "0x923FFaC17E7606CbEDaE4968e09194e6E45090f8",
        orderBook: "0x6C0dE0742F20300637CCCDBc4F7E28b30ef5E344",
        underlyingToken: "0x2250aC7885Ad897c30362b9318050Ed43dcDbEc0",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x503aD9CB48fc26d061AE4f58C0B9D6421Dc360ea",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tPLTR MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "GME",
        market: "0x75945ACCC11d3E0DAeCb32027A07863Da8c4E90e",
        orderBook: "0x3122c9112A366432Bb82B1e09145f74b50193aE6",
        underlyingToken: "0x3daAadb9cb2D3B082162C8d541Baf19271B41344",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0xf6198760c2DFb02588d2d4Ea712FE41d8A823fA6",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tGME MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "MSTR",
        market: "0xEC5b7D5baeD861319E7e660A13eCaD835aC0475B",
        orderBook: "0xA253D88090Ac7E73895b683DDB36E9257a4668a8",
        underlyingToken: "0x2EcC38721c57344A75DE4e21ffE9b961b1d334F8",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0xd7E1378fA4F9e19e48833c40A7bb8b7Df9A151c5",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tMSTR MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "COIN",
        market: "0xE38667867423078ad7ab1E1710EE227916fc9F05",
        orderBook: "0xC6D632fafE3558F3845862D8dbd9459d59559365",
        underlyingToken: "0x6a2Ff1D600A6F257d6cd5A5b200BFD9759C22Ce7",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x8192F88cc91d641eC67DD4819A13d6b536201669",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tCOIN MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "CRCL",
        market: "0xb89Db83B0747ad1aD549b25f6f1BdAF6f770A078",
        orderBook: "0x1010Ba800843a2FB965549D92A701c220312681F",
        underlyingToken: "0x6A4Cda655318224d900E527c8eA77866a17D3847",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x0C5A9e3Ef0CEAde398Fb11591AD21885441d6E26",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tCRCL MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "RKLB",
        market: "0xEc0019d551Dc99b39a4C73D67C46AE76F9c9A770",
        orderBook: "0x9735a288F3f9987EC17012E4c348ad978280F4Ff",
        underlyingToken: "0xFE1521Ac9062A85467bce0EFD40e328219426C55",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x4fb0b922b415ED5B6285F819C39e66DDBa604Dc7",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tRKLB MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "RGTI",
        market: "0x4940853FAfad1eFBA26116C3B25728A2b044d2df",
        orderBook: "0xb24f0D76C27586F7b89444c64b81640b85ad8813",
        underlyingToken: "0x45Dec2207551110D0f997Be010866A86f537bE8B",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x3BEc0A9F540D4661B237D1396496eB9518805F9C",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tRGTI MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
      },
      {
        underlying: "ORCL",
        market: "0xfB15DEaA758773b135E3bcB0e83ACD4002082319",
        orderBook: "0x3599333bb1DE1747eEA538c7122681B310FE003D",
        underlyingToken: "0xd6573251eC99434CE195Bc973b191CAF5Af64EE9",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0xbc03C9F14A29F51E31Ee2752a81CE982F7B89e3a",
        deployBlock: 144381288n,
        protocolFeeBps: 150,
        note: "tORCL MockStockToken + MockPushFeed fixture; audited build (hedgehood-options main after #54), deployed 2026-10-28; not mainnet configuration",
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
