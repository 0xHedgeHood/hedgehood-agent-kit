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
      note: "TestUSD, CREATE2 address pinned by hedgehood-options DeployTestUSD.EXPECTED; the settlement token of the testnet markets once they are redeployed on it (until then they settle in tUSDG)",
    },
    api: HEDGEHOOD_API,
    markets: [
      {
        underlying: "NVDA",
        market: "0x068639ad7914156Cbcf1adfB30e6Ccb32Db2226F",
        orderBook: "0xD33F1302120b41FAb0a58Aa22111a4c079f93B10",
        underlyingToken: "0x267ddeE02B44FDF4D073E124869DaA5BDbF1759D",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0xC8eE704a3536b6278db09e8DcADdaf56eaA1D148",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tNVDA2 with a keeper-pushed fixture feed; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "AMD",
        market: "0xbd398e4E098A754Cb4dF050113937197d636edA1",
        orderBook: "0xd4B3639C7eE809f4a4b04d42f931924Ba1157d6E",
        underlyingToken: "0xB07D757771d147e512C419DbAFCb735F90d73575",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x157CC7a48705f0693F3529F69BA5DB41b8B37f3f",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tAMD MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "MU",
        market: "0x0931Eb4033e72B9aE5040c519E4dc2aB34c692bB",
        orderBook: "0x424De0ce94167eF8326045FDcD12aEeAe0cC5cC7",
        underlyingToken: "0xf85e26a0bB2094bC9af6b9DEb40eaA70E54fB37E",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0xad8409089117bF2943beCf5c6922BCc18Ab58F59",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tMU MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "SNDK",
        market: "0xF52ec7D8d4EF3b4A19Bb578cE9F4e4E3A7A0BdA5",
        orderBook: "0xdfAcC7611b6AA7bd1C2b83f33Fa72eaE0C0a1FA4",
        underlyingToken: "0x2553505baEa07d842716AdE8B23353e81808493d",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x84D25fe8D9B2e9F13038C3aa1c3301Ae99281bDb",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tSNDK MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "CRWV",
        market: "0xA767368eBa2300e59B8ba0bAbC7a7106E8DDBf14",
        orderBook: "0x1950B383b02c330de9A0234d6fE96de5630aD97C",
        underlyingToken: "0x4B2c4a8212a8faFB707c63bDDE13Be0C93e3d1cD",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x085C40980D680AB281bD4c1F284233322B044Bf2",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tCRWV MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "NBIS",
        market: "0x31e7692bfbEfE9DAC146ec480f01f7a50a88341f",
        orderBook: "0xaB7377457981542ab4F401d983c2D2f567D2343A",
        underlyingToken: "0x9f93ab0F25b53B2998D6881bef95eB8f93C0dD6e",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x5998AA60a85d4821f27B16eA4802AE1dAC83c2eb",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tNBIS MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "IONQ",
        market: "0xC11df306f12ECd73523ef49af7F7Fd588Fb645DB",
        orderBook: "0x7BC31ec27da489A38BD04c68fB214d99F4238E76",
        underlyingToken: "0x8925aB3C8BaF0913227Eb660A6338BAc67f9dd5E",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x28976c1a59ACDEB267201Dcc0111F3CD009296f5",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tIONQ MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "INTC",
        market: "0xc060046F475fAFec05e6807c16F301B0a99C2187",
        orderBook: "0xFd748ad712f56bD6E0829E1472855F2af50104Cf",
        underlyingToken: "0xD11A0c7365d0a88c2276ee27A3040D595ef9E08C",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x9d08E459aD216ef3b0C485A899777Ff186Fc5CD8",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tINTC MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "TSM",
        market: "0x8eD5625B5B72aC09639403fe20B232a67631861f",
        orderBook: "0xF38148ea127363A239f7128da7DBB53929386075",
        underlyingToken: "0xC1AE60cF5c5Cca202Bc1829a47f6a8679e058b54",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0xAA8253Fd4b9Db1a6D754AA6212A544A704597845",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tTSM MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "ASML",
        market: "0xBe89453c5342d3C003759B8328A5648266896cba",
        orderBook: "0x58d647dcb50D1FC33492742C361540d1764F492b",
        underlyingToken: "0x1059c798628cEc644030AD1c0129c45BFCb172eC",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x6FbB2A5aC092Ef2B323229197Be42Cf835FE2DcF",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tASML MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "TSLA",
        market: "0x583a076b6fcd505d4895B70609249F5c063CBA5d",
        orderBook: "0x2a2108D7F5c30a404D9f2d6D9df0E873a7933967",
        underlyingToken: "0x6661d20C2e343Bb78B42535eB060C3058c744f3F",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0xEC36C6D896Fabd6E3c6d4e8fCf2cE80fEFD98988",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tTSLA MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "PLTR",
        market: "0xe575BE6357eA2020650f3EbC6bD6a7A055318E31",
        orderBook: "0x4E8E588C82679098C7E653EfD59354D5A43dD33B",
        underlyingToken: "0x2250aC7885Ad897c30362b9318050Ed43dcDbEc0",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x49cdDddd05842C8393a5465892af6d30c910D53C",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tPLTR MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "GME",
        market: "0x4C4fa09038ADebCB6D4FE51Fcf476C44947d421F",
        orderBook: "0xf9E5C382aB1ADF26744849229056D23d2996891b",
        underlyingToken: "0x3daAadb9cb2D3B082162C8d541Baf19271B41344",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0xa736ee6f91148771ecc217716a19332dfBBe53da",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tGME MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "MSTR",
        market: "0x2371EB0c26d2fb04467Af3E3d802aD9E29B4B497",
        orderBook: "0x4af8A918f8a6E45ef50FCDF21b539F60384Ce7b5",
        underlyingToken: "0x2EcC38721c57344A75DE4e21ffE9b961b1d334F8",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x8ff9c0855795e1bb4D0020b7F5eeAad3BE7DC124",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tMSTR MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "COIN",
        market: "0xD9DB61075696aF69E8Bda9a60E1AAB9939e0b128",
        orderBook: "0x3F484acD82462950B35AE1B1bB5D54f8b21a1a61",
        underlyingToken: "0x6a2Ff1D600A6F257d6cd5A5b200BFD9759C22Ce7",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x2635f9aEC18d5f77E25EF1d46A44B5A21644B4eE",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tCOIN MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "CRCL",
        market: "0xcfbDF036e89C4d2e78e7F97c5AF731B434A28c7F",
        orderBook: "0x8D5f1862f4CB9f18ae6d0c27Af43aDc34cD8A91b",
        underlyingToken: "0x6A4Cda655318224d900E527c8eA77866a17D3847",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x30Da50208fDe4B91E9F9518e1B63CBAC3AC2aCce",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tCRCL MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "RKLB",
        market: "0x904e6D82B996FFd5b0d11D8dbF734B6207395F3c",
        orderBook: "0xFDf8E9C1894AB7D0215e909ce0A765262bE45626",
        underlyingToken: "0xFE1521Ac9062A85467bce0EFD40e328219426C55",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x867936094Ad17bd85BaC69987Bc099F83ff19A12",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tRKLB MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "RGTI",
        market: "0x215dB4BA8165b79EE19053DD72FBA240426B5fa3",
        orderBook: "0x3130032CC1DF24Cb33515C096fBf71BB794e93b7",
        underlyingToken: "0x45Dec2207551110D0f997Be010866A86f537bE8B",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x15C6028647b6BC999E4dEc5D7c4629CD3Fa80b9A",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tRGTI MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
      },
      {
        underlying: "ORCL",
        market: "0x84CB43D41E56fb7930C72e86215514600C1262bE",
        orderBook: "0x91EF58b6B3D9062F1685F241e7589b98d010391b",
        underlyingToken: "0xd6573251eC99434CE195Bc973b191CAF5Af64EE9",
        settlementToken: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d",
        source: "0x85D19c818cD0FEcF7429205F77fcaeFcD447d765",
        deployBlock: 144460481n,
        protocolFeeBps: 150,
        note: "tORCL MockStockToken + MockPushFeed fixture; hedgehood-options main after the red-team round 2 (#58), redeployed 2026-10-29; not mainnet configuration",
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
