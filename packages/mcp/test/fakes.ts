/**
 * Test doubles shared by the MCP and CLI tests: a JSON-RPC node answering the market's reads from fixtures, a maker
 * quoting both sides of every instrument, and an indexer with /v1/pnl and /v1/history rows. Everything goes through one
 * `fetch` so no network is touched.
 */
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionResult, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { adaptiveCurveIrmAbi, testUsdAbi, encodeFillOrderAs, encodeInstrumentId, tokenStrikeOf, epochFundAbi, erc20Abi, instrumentName, marketIdOf, marketV2Abi, morphoBlueAbi, morphoMarketV1AdapterV2Abi, openDepositGateAbi, orderBookV2Abi, orderDigest, orderToJson, shareRiskOracleAbi, Side, signOrder, vaultRegistryAbi, vaultV2Abi, type Order, type QuoteResponse } from "@hedgehood-io/sdk";

export const ACCOUNT = "0x3333333333333333333333333333333333333333" as Address;
export const BOOK = "0xD33F1302120b41FAb0a58Aa22111a4c079f93B10" as Address;
export const MARKET = "0x068639ad7914156Cbcf1adfB30e6Ccb32Db2226F" as Address;
export const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const EXPIRY = 1793390400n; // 2026-10-30 16:00 New York
export const STRIKES = [210_000_000n, 220_000_000n];
/** NVDA's mainnet uiMultiplier (2026-10-28): per-token strikes are then not whole dollars. */
export const NVDA_M = 1_000_775_159_164_630_595n;
export const CALL220 = encodeInstrumentId(EXPIRY, 220_000_000n, false);
export const PUT210 = encodeInstrumentId(EXPIRY, 210_000_000n, true);
export const ONE = 10n ** 18n;
export const RPC = "https://rpc.testnet.chain.robinhood.com";

export interface ChainState {
  /** positions(account, EXPIRY) as the contract returns them: [call@210, put@210, call@220, put@220]. */
  positions: bigint[];
  collateralRaw: bigint;
  requirementRaw: bigint;
  /** eth_call payloads the node received for the book (simulated fills). */
  simulated: Hex[];
  /** The expiry's snapshotted uiMultiplier; the listed per-share strikes stay 210 / 220, stored per token under it. */
  uiMultiplier: bigint;
  /** sessions(account, key): [expiresAt, authorizedAt, scope, riskLeft, spendLeft]. */
  session: [bigint, bigint, bigint, bigint, bigint];
  /** A custom error the next simulated fill reverts with (e.g. "SessionLimit"). */
  fillRevert?: string;
  /** The Stock Yield fund (testnet hhNVDA-CC addresses). */
  vault: VaultState;
  /** Share lending: the hhUSDG vault and the Blue market on the fund's shares. */
  lending: LendingState;
  /** The testnet TestUSD faucet: deployed (has code), the wallet's balance and next draw time, the faucet() calls simulated. */
  faucet: { deployed: boolean; balanceRaw: bigint; nextFaucetAt: bigint; calls: Hex[] };
}

/** TestUSD on 46630 (the kit's chains.ts faucet.token, the CREATE2 address pinned by DeployTestUSD.EXPECTED). */
export const TEST_USD = "0x850DE815d41F6983Aaf09247f9a465c0aefff04C" as Address;

function faucetRpc(state: ChainState, call: { to: Address; data: Hex }): Hex {
  const { functionName } = decodeFunctionData({ abi: testUsdAbi, data: call.data });
  const enc = (result: unknown) => encodeFunctionResult({ abi: testUsdAbi, functionName, result } as Parameters<typeof encodeFunctionResult>[0]);
  switch (functionName) {
    case "balanceOf":
      return enc(state.faucet.balanceRaw);
    case "nextFaucetAt":
      return enc(state.faucet.nextFaucetAt);
    case "faucet":
      state.faucet.calls.push(call.data);
      if (state.faucet.nextFaucetAt > state.vault.now) throw new Error("execution reverted: FaucetCooldown");
      return enc(1_000_000_000n);
    default:
      throw new Error(`fake rpc: no TestUSD fixture for ${functionName}`);
  }
}

export function defaultChain(): ChainState {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return { positions: [0n, -(ONE / 2n), ONE, 0n], collateralRaw: 100_000_000n, requirementRaw: 10_000_000n, simulated: [], uiMultiplier: ONE, session: [now + 86400n, now - 3600n, 3n, 0n, 40_000_000n], vault: defaultVault(), lending: defaultLending(), faucet: { deployed: true, balanceRaw: 0n, nextFaucetAt: 0n, calls: [] } };
}

/** The per-token strikes the fake market stores: STRIKES (per share) under the chain's uiMultiplier. */
export function strikesOf(state: ChainState): bigint[] {
  return STRIKES.map((s) => tokenStrikeOf(s, state.uiMultiplier));
}

// ---------------------------------------------------------------- Stock Yield vault fixtures (testnet 46630 hhNVDA-CC)

export const VAULT = "0x2a7CC7E34a1CFAda9e3aeA978e805dbaB05D83b4" as Address;
export const VAULT_REGISTRY = "0xBeE38aF4Fc4f50A0C04bDdA45Bec6cBABFf476b9" as Address;
export const VAULT_GATE = "0x5b4EE28Efc1f545f9D24f9474F0AeE9c22f8eBD6" as Address;
export const VAULT_STOCK = "0x267ddeE02B44FDF4D073E124869DaA5BDbF1759D" as Address;
export const VAULT_USDG = "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d" as Address;
export const VAULT_ORACLE = "0x6f4c6a29DD973e33e075Dc7EF94A5D4772dDf793" as Address;
/** Wed 2026-10-28 ~00:53 UTC: inside epoch 3 (cutoff Mon 10/26 13:30Z, expiry Fri 10/30 19:59Z). */
export const VAULT_NOW = 1793100000n;
export const EPOCH3 = { depositCutoff: 1793021400n, tradeStart: 1793021700n, tradeEnd: 1793043000n, expiry: 1793390340n };
export const EPOCH4 = { depositCutoff: 1793626200n, tradeStart: 1793626500n, tradeEnd: 1793647800n, expiry: 1793995140n };

type Schedule = { depositCutoff: bigint; tradeStart: bigint; tradeEnd: bigint; expiry: bigint };
type EpochFixture = { frozenAt: bigint; settledAt: bigint; navPrice: bigint; navUsdg: bigint; depositStock: bigint; depositUsdg: bigint; income: bigint };

export interface VaultState {
  now: bigint;
  /** 0 Collecting, 1 Locked, 2 Frozen. */
  phase: number;
  currentEpoch: bigint;
  schedules: Record<string, Schedule>;
  epochs: Record<string, EpochFixture>;
  totalSupply: bigint;
  stockHeld: bigint;
  usdgHeld: bigint;
  markPrice: bigint;
  /** 0 = market closed (oracle.price() reverts). */
  livePrice: bigint;
  paused: boolean;
  canDeposit: boolean;
  /** The account's shares and queues. */
  balance: bigint;
  account: { depositEpoch: bigint; depositStock: bigint; depositUsdg: bigint; redeemEpoch: bigint; redeemShares: bigint };
  /** previewAccount: [uncredited shares, claimable stock, claimable usdg]. */
  preview: [bigint, bigint, bigint];
  walletUsdg: bigint;
  walletStock: bigint;
  usdgAllowance: bigint;
  stockAllowance: bigint;
}

export function defaultVault(): VaultState {
  return {
    now: VAULT_NOW,
    phase: 1,
    currentEpoch: 3n,
    schedules: { "3": EPOCH3, "4": EPOCH4 },
    epochs: { "2": { frozenAt: 1792416600n, settledAt: 1792786399n, navPrice: 213n * ONE, navUsdg: 20_000_000_000n, depositStock: 0n, depositUsdg: 0n, income: 150_000_000n } },
    totalSupply: 100n * ONE,
    stockHeld: 95n * ONE,
    usdgHeld: 300_000_000n,
    markPrice: 213_375n * 10n ** 15n, // 213.375
    livePrice: 0n,
    paused: false,
    canDeposit: true,
    balance: 5n * ONE,
    account: { depositEpoch: 0n, depositStock: 0n, depositUsdg: 0n, redeemEpoch: 0n, redeemShares: 0n },
    preview: [0n, 0n, 0n],
    walletUsdg: 1_000_000_000n,
    walletStock: 2n * ONE,
    usdgAllowance: 0n,
    stockAllowance: 0n,
  };
}

const vaultAbi = [...epochFundAbi, ...vaultRegistryAbi, ...openDepositGateAbi, ...erc20Abi, { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }] as const;
const ZERO_SCHEDULE: Schedule = { depositCutoff: 0n, tradeStart: 0n, tradeEnd: 0n, expiry: 0n };

function vaultRpc(state: ChainState, call: { to: Address; data: Hex; from?: Address }): unknown {
  const v = state.vault;
  const to = call.to.toLowerCase();
  const { functionName, args } = decodeFunctionData({ abi: vaultAbi, data: call.data });
  const a = (args ?? []) as unknown as unknown[];
  const enc = (result: unknown) => encodeFunctionResult({ abi: vaultAbi, functionName, result } as Parameters<typeof encodeFunctionResult>[0]);
  if (to === VAULT_REGISTRY.toLowerCase()) {
    if (functionName === "vaults") return enc([VAULT]);
    if (functionName === "isVault") return enc((a[0] as string).toLowerCase() === VAULT.toLowerCase());
  }
  if (to === VAULT_GATE.toLowerCase()) {
    if (functionName === "banned") return enc(false);
    if (functionName === "registry") return enc(VAULT_REGISTRY);
    if (functionName === "coversVault") return enc(true);
  }
  if (to === VAULT_ORACLE.toLowerCase()) {
    if (functionName === "price") {
      if (v.livePrice === 0n) throw new Error("execution reverted: ClosedMarket()");
      return enc(v.livePrice);
    }
  }
  if (to === VAULT_USDG.toLowerCase() || to === VAULT_STOCK.toLowerCase()) {
    const usdg = to === VAULT_USDG.toLowerCase();
    const holder = typeof a[0] === "string" ? a[0].toLowerCase() : "";
    switch (functionName) {
      case "symbol":
        return enc(usdg ? "tUSDG" : "NVDA");
      case "balanceOf":
        if (holder === LEND_VAULT.toLowerCase()) return enc(usdg ? state.lending.vaultIdle : 0n);
        return enc(holder === VAULT.toLowerCase() ? 0n : usdg ? v.walletUsdg : v.walletStock);
      case "allowance": {
        const spender = (a[1] as string).toLowerCase();
        if (usdg && spender === LEND_VAULT.toLowerCase()) return enc(state.lending.usdgAllowanceVault);
        if (usdg && spender === LEND_BLUE.toLowerCase()) return enc(state.lending.usdgAllowanceBlue);
        return enc(usdg ? v.usdgAllowance : v.stockAllowance);
      }
      case "approve":
        state.simulated.push(call.data);
        return enc(true);
    }
  }
  if (to === VAULT.toLowerCase()) {
    switch (functionName) {
      case "allowance":
        return enc((a[1] as string).toLowerCase() === LEND_BLUE.toLowerCase() ? state.lending.shareAllowanceBlue : 0n);
      case "approve":
        state.simulated.push(call.data);
        return enc(true);
      case "name":
        return enc("Hedgehood Covered Call NVDA");
      case "symbol":
        return enc("hhNVDA-CC");
      case "stock":
        return enc(VAULT_STOCK);
      case "usdg":
        return enc(VAULT_USDG);
      case "depositGate":
        return enc(VAULT_GATE);
      case "oracle":
        return enc(VAULT_ORACLE);
      case "paused":
        return enc(v.paused);
      case "phase":
        return enc(v.phase);
      case "currentEpoch":
        return enc(v.currentEpoch);
      case "depositCapUsdg":
        return enc(100_000_000_000n);
      case "stockHeld":
        return enc(v.stockHeld);
      case "usdgHeld":
        return enc(v.usdgHeld);
      case "pendingStock":
        return enc(0n);
      case "pendingUsdg":
        return enc(v.account.depositUsdg);
      case "reservedStock":
      case "reservedUsdg":
        return enc(0n);
      case "totalSupply":
        return enc(v.totalSupply);
      case "markPrice":
        return enc(v.markPrice);
      case "epochSchedules": {
        const s = v.schedules[String(a[0])] ?? ZERO_SCHEDULE;
        return enc([s.depositCutoff, s.tradeStart, s.tradeEnd, s.expiry, s.depositCutoff ? 650 : 0]);
      }
      case "getEpoch": {
        const e = v.epochs[String(a[0])];
        const z = { frozenAt: 0n, settledAt: 0n, depositsRefunded: false, navPrice: 0n, navUsdg: 0n, depositStock: 0n, depositUsdg: 0n, depositShares: 0n, redeemShares: 0n, redeemStock: 0n, redeemUsdg: 0n, depositStockLeft: 0n, depositUsdgLeft: 0n, depositSharesLeft: 0n, redeemSharesLeft: 0n, redeemStockLeft: 0n, redeemUsdgLeft: 0n, settlementPrice: 0n, paidStock: 0n, paidUsdg: 0n, fee: 0n, income: 0n };
        return enc(e ? { ...z, ...e } : z);
      }
      case "balanceOf":
        return enc((a[0] as string).toLowerCase() === VAULT.toLowerCase() ? 0n : v.balance);
      case "getAccount":
        return enc(v.account);
      case "previewAccount":
        return enc(v.preview);
      case "canDeposit":
        return enc(v.canDeposit);
      case "isPositionManager":
        return enc(false);
      case "requestDeposit":
      case "requestRedeem":
      case "cancelDeposit":
      case "cancelRedeem":
        state.simulated.push(call.data);
        return "0x";
      case "claim":
        state.simulated.push(call.data);
        return enc([v.preview[1], v.preview[2]]);
    }
  }
  throw new Error(`fake rpc: no vault fixture for ${functionName} on ${call.to}`);
}

const VAULT_ADDRESSES = new Set([VAULT, VAULT_REGISTRY, VAULT_GATE, VAULT_STOCK, VAULT_USDG, VAULT_ORACLE].map((x) => x.toLowerCase()));

// ---------------------------------------------------------------- Share lending fixtures (testnet 46630 v5 market + hhUSDG vault)

export const LEND_BLUE = "0xa0BA91A2F99894044CCD82cA48e5C795BA7570B6" as Address;
export const LEND_VAULT = "0x6ab073F0E3F1610C4Ad9e7Dc19Ca25F831682f00" as Address;
export const LEND_ADAPTER = "0x89ace3cb69f676d41aBa380563F267cD7b8A98f3" as Address;
export const LEND_ORACLE = "0x1291A39e96Cd1ce736084548b15532D9a8D4bE77" as Address;
export const LEND_IRM = "0xAf61C1DEDffD90D39E7D90641A8AB1B59497a9fF" as Address;
export const LEND_LLTV = 625000000000000000n;
/** The fixture market: hhNVDA-CC (VAULT) shares vs tUSDG. */
export const LEND_PARAMS = { loanToken: VAULT_USDG, collateralToken: VAULT, oracle: LEND_ORACLE, irm: LEND_IRM, lltv: LEND_LLTV } as const;
export const LEND_MARKET_ID = marketIdOf(LEND_PARAMS);
/** A second market (another oracle) the vault does not supply: what a migration target looks like before the switch. */
export const LEND_ORACLE_2 = "0x2222222222222222222222222222222222222222" as Address;
export const LEND_PARAMS_2 = { ...LEND_PARAMS, oracle: LEND_ORACLE_2 } as const;
export const LEND_MARKET_ID_2 = marketIdOf(LEND_PARAMS_2);
/** 0.95 USDG per share in Blue's 1e36 format (USDG raw per 1e18 shares x 1e18). */
export const LEND_PRICE = 950_000n * 10n ** 18n;
/** ~1.16% APR per second, WAD. */
export const LEND_RATE = 367_843_366n;

export interface LendingState {
  /** Vault V2 (hhUSDG). */
  liquidityAdapter: Address;
  /** The market the vault supplies (its liquidityData encodes these params). */
  liquidityParams: typeof LEND_PARAMS | typeof LEND_PARAMS_2;
  adapterMarketIds: Hex[];
  vaultTotalAssets: bigint;
  vaultTotalSupply: bigint;
  /** USDG held idle by the vault. */
  vaultIdle: bigint;
  /** The account's hhUSDG shares (18 decimals: 1 USDG = 1e18 shares at par). */
  vaultShares: bigint;
  performanceFee: bigint;
  maxRate: bigint;
  absoluteCap: bigint;
  allocation: bigint;
  canReceiveShares: boolean;
  canSendShares: boolean;
  /** Blue market and the account's position. */
  market: { totalSupplyAssets: bigint; totalSupplyShares: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint; lastUpdate: bigint; fee: bigint };
  position: { supplyShares: bigint; borrowShares: bigint; collateral: bigint };
  borrowRate: bigint;
  isAuthorized: boolean;
  /** null = the oracle reverts Unavailable (fail-closed). */
  oraclePrice: bigint | null;
  spot: bigint;
  spotLive: boolean;
  nav: bigint;
  liabilities: bigint;
  /** Allowances from the account. */
  shareAllowanceBlue: bigint;
  usdgAllowanceBlue: bigint;
  usdgAllowanceVault: bigint;
}

export function defaultLending(): LendingState {
  return {
    liquidityAdapter: LEND_ADAPTER,
    liquidityParams: LEND_PARAMS,
    adapterMarketIds: [LEND_MARKET_ID],
    vaultTotalAssets: 1_500_000_000n,
    vaultTotalSupply: 1500n * ONE,
    vaultIdle: 0n,
    vaultShares: 100n * ONE,
    performanceFee: 10n ** 17n,
    maxRate: 15_854_895_991n,
    absoluteCap: 100_000_000_000n,
    allocation: 1_500_000_000n,
    canReceiveShares: true,
    canSendShares: true,
    // 1,500 supplied, 670 borrowed (44.7% utilisation), shares at 1e6 per asset, no accrual pending
    market: { totalSupplyAssets: 1_500_000_000n, totalSupplyShares: 1_500_000_000_000_000n, totalBorrowAssets: 670_000_000n, totalBorrowShares: 670_000_000_000_000n, lastUpdate: VAULT_NOW, fee: 0n },
    // 100 shares pledged, no debt
    position: { supplyShares: 0n, borrowShares: 0n, collateral: 100n * ONE },
    borrowRate: LEND_RATE,
    isAuthorized: false,
    oraclePrice: LEND_PRICE,
    spot: 217n * ONE,
    spotLive: true,
    nav: 22_206_000_000n,
    liabilities: 372_000_000n,
    shareAllowanceBlue: 0n,
    usdgAllowanceBlue: 0n,
    usdgAllowanceVault: 0n,
  };
}

const marketParamsAbi = [{ type: "tuple", components: [{ name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" }, { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" }] }] as const;
const LENDING_ADDRESSES = new Set([LEND_BLUE, LEND_VAULT, LEND_ADAPTER, LEND_ORACLE, LEND_ORACLE_2, LEND_IRM].map((x) => x.toLowerCase()));

function lendingRpc(state: ChainState, call: { to: Address; data: Hex }): unknown {
  const l = state.lending;
  const to = call.to.toLowerCase();
  const pick = <A extends readonly unknown[]>(abi: A) => {
    const { functionName, args } = decodeFunctionData({ abi: abi as never, data: call.data }) as { functionName: string; args?: readonly unknown[] };
    const a = (args ?? []) as unknown[];
    const enc = (result: unknown) => encodeFunctionResult({ abi: abi as never, functionName, result } as Parameters<typeof encodeFunctionResult>[0]);
    return { functionName, a, enc };
  };
  const paramsOf = (id: string) => (id.toLowerCase() === LEND_MARKET_ID.toLowerCase() ? LEND_PARAMS : id.toLowerCase() === LEND_MARKET_ID_2.toLowerCase() ? LEND_PARAMS_2 : undefined);
  if (to === LEND_BLUE.toLowerCase()) {
    const { functionName, a, enc } = pick(morphoBlueAbi);
    switch (functionName) {
      case "market": {
        if (!paramsOf(String(a[0]))) return enc([0n, 0n, 0n, 0n, 0n, 0n]);
        const m = l.market;
        return enc([m.totalSupplyAssets, m.totalSupplyShares, m.totalBorrowAssets, m.totalBorrowShares, m.lastUpdate, m.fee]);
      }
      case "position": {
        const p = String(a[0]).toLowerCase() === LEND_MARKET_ID.toLowerCase() ? l.position : { supplyShares: 0n, borrowShares: 0n, collateral: 0n };
        return enc([p.supplyShares, p.borrowShares, p.collateral]);
      }
      case "idToMarketParams": {
        const p = paramsOf(String(a[0]));
        return enc(p ? [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv] : ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0n]);
      }
      case "isAuthorized":
        return enc(l.isAuthorized);
      case "supplyCollateral":
      case "borrow":
      case "repay":
      case "withdrawCollateral":
        state.simulated.push(call.data);
        return "0x";
    }
  }
  if (to === LEND_VAULT.toLowerCase()) {
    const { functionName, a, enc } = pick(vaultV2Abi);
    switch (functionName) {
      case "liquidityAdapter":
        return enc(l.liquidityAdapter);
      case "liquidityData":
        return enc(l.liquidityAdapter === "0x0000000000000000000000000000000000000000" ? "0x" : encodeAbiParameters(marketParamsAbi, [l.liquidityParams]));
      case "totalAssets":
        return enc(l.vaultTotalAssets);
      case "totalSupply":
        return enc(l.vaultTotalSupply);
      case "name":
        return enc("Hedgehood USDG Lending");
      case "symbol":
        return enc("hhUSDG");
      case "asset":
        return enc(VAULT_USDG);
      case "performanceFee":
        return enc(l.performanceFee);
      case "maxRate":
        return enc(l.maxRate);
      case "absoluteCap":
        return enc(l.absoluteCap);
      case "allocation":
        return enc(l.allocation);
      case "balanceOf":
        return enc(l.vaultShares);
      case "previewRedeem":
        return enc(((a[0] as bigint) * l.vaultTotalAssets) / l.vaultTotalSupply);
      case "canReceiveShares":
        return enc(l.canReceiveShares);
      case "canSendShares":
        return enc(l.canSendShares);
      case "deposit":
      case "withdraw":
      case "redeem":
        state.simulated.push(call.data);
        return "0x";
    }
  }
  if (to === LEND_ADAPTER.toLowerCase()) {
    const { functionName, a, enc } = pick(morphoMarketV1AdapterV2Abi);
    switch (functionName) {
      case "marketIdsLength":
        return enc(BigInt(l.adapterMarketIds.length));
      case "marketIds":
        return enc(l.adapterMarketIds[Number(a[0])]!);
      case "expectedSupplyAssets":
        return enc(String(a[0]).toLowerCase() === LEND_MARKET_ID.toLowerCase() ? l.allocation : 0n);
    }
  }
  if (to === LEND_ORACLE.toLowerCase() || to === LEND_ORACLE_2.toLowerCase()) {
    const { functionName, enc } = pick(shareRiskOracleAbi);
    if (l.oraclePrice === null) throw new Error("execution reverted: Unavailable()");
    switch (functionName) {
      case "price":
        return enc(l.oraclePrice);
      case "spot":
        return enc([l.spot, l.spotLive]);
      case "valuation":
        return enc([l.nav, l.nav + l.liabilities, l.liabilities, l.spot, l.spotLive]);
    }
  }
  if (to === LEND_IRM.toLowerCase()) {
    const { functionName, enc } = pick(adaptiveCurveIrmAbi);
    if (functionName === "borrowRateView") return enc(l.borrowRate);
  }
  throw new Error(`fake rpc: no lending fixture for ${call.data.slice(0, 10)} on ${call.to}`);
}

/** The `GET /api/stockyield/funds` row the public API would serve for the fixture fund (chain 46630 for the tests). */
export function vaultApiFixture(state: ChainState) {
  const v = state.vault;
  const sched = (s: Schedule) => ({ depositCutoff: Number(s.depositCutoff), tradeStart: Number(s.tradeStart), tradeEnd: Number(s.tradeEnd), expiry: Number(s.expiry), maxAtmDeviationBps: s.depositCutoff ? 650 : 0 });
  const last = v.epochs[String(v.currentEpoch - 1n)];
  return {
    chainId: 46630,
    builtAt: Number(v.now),
    funds: [
      {
        chainId: 46630, vault: VAULT, name: "Hedgehood Covered Call NVDA", symbol: "hhNVDA-CC", stock: VAULT_STOCK, stockSymbol: "NVDA", usdg: VAULT_USDG, usdgSymbol: "tUSDG",
        strategy: { address: "0x4f44c747cc9ec002C6A80310dC451FFb1D1A522F", name: "Covered Call", code: "CC", legs: ["CALL"] }, depositGate: VAULT_GATE, paused: v.paused,
        phase: ["Collecting", "Locked", "Frozen"][v.phase], effectivePhase: ["Collecting", "Locked", "Frozen"][v.phase], currentEpoch: v.currentEpoch.toString(),
        schedules: { [String(v.currentEpoch)]: sched(v.schedules[String(v.currentEpoch)] ?? ZERO_SCHEDULE), [String(v.currentEpoch + 1n)]: sched(v.schedules[String(v.currentEpoch + 1n)] ?? ZERO_SCHEDULE) },
        depositCapUsdg: "100000000000", stockHeld: v.stockHeld.toString(), usdgHeld: v.usdgHeld.toString(), pendingStock: "0", pendingUsdg: v.account.depositUsdg.toString(), reservedStock: "0", reservedUsdg: "0",
        totalSupply: v.totalSupply.toString(), markPrice: v.markPrice.toString(), price: v.livePrice.toString(), readAt: Number(v.now),
        epochs: last ? [{ navUsdg: last.navUsdg.toString(), income: last.income.toString(), settledAt: last.settledAt.toString(), navPrice: last.navPrice.toString(), depositStock: last.depositStock.toString(), depositUsdg: last.depositUsdg.toString(), depositsRefunded: false }] : [],
        stake: 0, feeBps: 2000,
      },
    ],
  };
}

const abi = [...marketV2Abi, ...orderBookV2Abi, ...erc20Abi];

function rpcResult(state: ChainState, method: string, params: unknown[]): unknown {
  if (method === "eth_chainId") return "0xb626";
  if (method === "eth_blockNumber") return "0x10";
  if (method === "eth_getBlockByNumber") {
    const ts = "0x" + state.vault.now.toString(16);
    const h = "0x" + "11".repeat(32);
    return { number: "0x10", hash: h, parentHash: h, timestamp: ts, nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: "0x" + "00".repeat(20), extraData: "0x", logsBloom: "0x" + "00".repeat(256), mixHash: h, receiptsRoot: h, sha3Uncles: h, size: "0x0", stateRoot: h, totalDifficulty: "0x0", transactionsRoot: h, transactions: [], uncles: [], baseFeePerGas: "0x1" };
  }
  if (method === "eth_getCode") return String(params[0]).toLowerCase() === TEST_USD.toLowerCase() && !state.faucet.deployed ? "0x" : "0x6080";
  if (method !== "eth_call") throw new Error(`fake rpc: unexpected ${method}`);
  const call = params[0] as { to: Address; data: Hex; from?: Address };
  if (call.to.toLowerCase() === TEST_USD.toLowerCase()) return faucetRpc(state, call);
  if (LENDING_ADDRESSES.has(call.to.toLowerCase())) return lendingRpc(state, call);
  if (VAULT_ADDRESSES.has(call.to.toLowerCase())) return vaultRpc(state, call);
  const { functionName, args } = decodeFunctionData({ abi, data: call.data });
  const enc = (result: unknown) => encodeFunctionResult({ abi, functionName, result } as Parameters<typeof encodeFunctionResult>[0]);
  switch (functionName) {
    case "collateral":
      return enc(state.collateralRaw);
    case "requirement":
      return enc(state.requirementRaw);
    case "freeCollateral":
      return enc(state.collateralRaw - state.requirementRaw);
    case "balanceOf":
      return enc(0n);
    case "accountExpiries":
      return enc([EXPIRY]);
    case "openedExpiryCount":
      return enc(1n);
    case "openedExpiries":
      return enc([EXPIRY]);
    case "strikesOf":
      return enc(strikesOf(state));
    case "positions":
      return enc(state.positions);
    case "position": {
      // the same fixture as positions(): [call@210, put@210, call@220, put@220] of EXPIRY
      const id = (args as unknown as unknown[])[1] as bigint;
      const ids = strikesOf(state).flatMap((k) => [encodeInstrumentId(EXPIRY, k, false), encodeInstrumentId(EXPIRY, k, true)]);
      const i = ids.indexOf(id);
      return enc(i < 0 ? 0n : (state.positions[i] ?? 0n));
    }
    case "protocolFeeBps":
      return enc(50n);
    case "tradingOpen":
      return enc(true);
    case "requirementIfTraded":
      return enc(0n);
    case "uiMultiplier":
      return enc(ONE);
    case "expiryInfo":
      return enc({ openedAt: 1792785600n, settled: false, settledByOwner: false, uiMultiplier: state.uiMultiplier, anchor: 215_000_000n, capLow: 150_500_000n, capHigh: 279_500_000n, settlementPrice: 0n, rawSettlementPrice: 0n, strikes: strikesOf(state) });
    case "sessions":
      return enc(state.session);
    case "authorizeSession":
    case "revokeSession":
      state.simulated.push(call.data);
      return "0x";
    case "fillOrderAs": {
      state.simulated.push(call.data);
      const fromBalance = (args as unknown as unknown[])[4];
      const signer = call.from?.toLowerCase();
      // the market's rule: a session leg (signer != account) must settle from the balance
      if (signer && signer !== String((args as unknown as unknown[])[0]).toLowerCase() && fromBalance !== true) throw new RevertWith("SessionWalletMode");
      if (state.fillRevert) throw new RevertWith(state.fillRevert);
      return "0x";
    }
    default:
      throw new Error(`fake rpc: no fixture for ${functionName}(${(args as unknown as unknown[] | undefined)?.join(", ") ?? ""})`);
  }
}

/** A JSON-RPC revert carrying a market custom error's data. */
export class RevertWith extends Error {
  readonly data: Hex;
  constructor(errorName: string) {
    super("execution reverted");
    this.data = encodeErrorResult({ abi: marketV2Abi, errorName } as Parameters<typeof encodeErrorResult>[0]);
  }
}

/**
 * The maker's `POST /v1/rfq` answer for a request body, signed for real so the SDK's verification passes. The name
 * carries the listed per-share strike; the order's id the per-token strike under `uiMultiplier`.
 */
export async function makerQuote(body: { instrument: string; side: "buy" | "sell"; quantity: string; taker: Address }, opts: { now?: number; dryRun?: boolean; uiMultiplier?: bigint } = {}): Promise<QuoteResponse> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const isPut = body.instrument.endsWith("-P");
  const strike = tokenStrikeOf(BigInt(Math.round(Number(body.instrument.split("-")[2]) * 1e6)), opts.uiMultiplier ?? ONE);
  const instrumentId = encodeInstrumentId(EXPIRY, strike, isPut);
  const quantityRaw = BigInt(Math.round(Number(body.quantity) * 1e6)) * 10n ** 12n;
  const side = body.side === "buy" ? Side.Ask : Side.Bid;
  const perShare = body.side === "buy" ? 1_680_000n : 1_570_000n; // NVDA-20261030-220-C live 2026-10-28: buy 1.68 / sell 1.57
  const premium = (perShare * quantityRaw) / ONE;
  const order: Order = {
    maker: maker.address, signer: maker.address, taker: body.taker, chainId: 46630n, settlement: BOOK, market: MARKET, instrumentId, side, quantityRaw, minFillRaw: 0n,
    premiumStartRaw: premium, premiumEndRaw: premium, startTime: BigInt(now - 1), validUntil: BigInt(now + 20), stockMultiplier: ONE, nonce: BigInt(now), fromBalance: true,
  };
  const signature = opts.dryRun ? (("0x" + "ab".repeat(65)) as Hex) : await signOrder(maker, order);
  return {
    quote: orderToJson(order), signature, digest: orderDigest(order), validUntil: order.validUntil.toString(), startTime: order.startTime.toString(), ttl: 20,
    instrument: body.instrument, instrumentId: instrumentId.toString(), market: MARKET, book: BOOK, marketId: "nvda-testnet", version: 2, taker: body.taker,
    takerSide: body.side, makerSide: side, quantityRaw: quantityRaw.toString(), markPrice: 1.625, price: { start: Number(perShare) / 1e6, end: Number(perShare) / 1e6, unit: "USDG per share" },
    premiumStartRaw: premium.toString(), premiumEndRaw: premium.toString(), fee: { bps: 50, startRaw: "0", endRaw: "0" }, decay: { model: "linear", bpsPerMin: 0, encodedInOrder: true },
    signing: { maker: maker.address, signer: maker.address, kind: "owner", domain: { name: "CashOptionOrderBook", version: "2", chainId: 46630, verifyingContract: BOOK } },
    funding: { makerFromBalance: true, takerDefault: "balance", canFill: true, preview: { canFill: true, mode: "balance" } },
    fill: { to: BOOK, chainId: 46630, quantityRaw: quantityRaw.toString(), default: "fillOrderAs", fillOrderAs: encodeFillOrderAs(BOOK, body.taker, order, signature, quantityRaw, true).data, fillOrderAsWallet: null, fillOrder: "0x" },
    dryRun: opts.dryRun ?? false,
  };
}

export const NAME220C = instrumentName("NVDA", EXPIRY, 220_000_000n, false);
export const NAME210P = instrumentName("NVDA", EXPIRY, 210_000_000n, true);

export function pnlFixture(asOf: number) {
  return {
    account: ACCOUNT,
    asOf,
    positions: [
      { instrument: NAME220C, market: MARKET, expiry: Number(EXPIRY), strike: "220000000", isPut: false, quantityRaw: ONE.toString(), costRaw: "1688400", avgPriceRaw: "1680000", markMid: 1.625, markBid: 1.57, markAsk: 1.68, markSource: "desk", markAt: asOf, unrealizedRaw: "-55000", settledAt: null, settlementRaw: null },
      { instrument: NAME210P, market: MARKET, expiry: Number(EXPIRY), strike: "210000000", isPut: true, quantityRaw: (-(ONE / 2n)).toString(), costRaw: "-400000", avgPriceRaw: "800000", markMid: 0.7, markBid: 0.65, markAsk: 0.75, markSource: "desk", markAt: asOf, unrealizedRaw: "50000", settledAt: null, settlementRaw: null },
    ],
    realizedRaw: "1200000",
    unrealizedRaw: "-5000",
    feesPaidRaw: "12400",
    totalRaw: "1182600",
    note: "marks at desk mid",
  };
}

export function historyFixture(now: number) {
  return {
    account: ACCOUNT,
    events: [
      { type: "fill", at: now - 3600, txHash: "0x" + "01".repeat(32), instrument: NAME220C, side: "buy", quantityRaw: ONE.toString(), priceRaw: "1680000", premiumRaw: "1680000", feeRaw: "8400", counterparty: maker.address },
      { type: "fill", at: now - 7200, txHash: "0x" + "02".repeat(32), instrument: NAME210P, side: "sell", quantityRaw: (ONE / 2n).toString(), priceRaw: "800000", premiumRaw: "400000", feeRaw: "2000", counterparty: maker.address },
      { type: "settlement", at: now - 86400, instrument: "NVDA-20261023-200-C", settlementPrice: 212.5, payoutRaw: "1250000" },
      { type: "redeem", at: now - 86000, txHash: "0x" + "03".repeat(32), expiry: 1792785600, amountRaw: "1250000" },
    ],
  };
}

export interface FakeWorld {
  fetch: typeof fetch;
  chain: ChainState;
  /** Every backend request: path + parsed body. */
  backend: Array<{ url: URL; body?: unknown }>;
}

/** One fetch for everything: the RPC node, the maker (`https://rfq.test`) and the indexer (`https://index.test`). */
export function fakeWorld(opts: { chain?: ChainState; quoteDryRun?: boolean; quoteFails?: Array<{ status: number; body: unknown }>; indexerDown?: boolean; vaultApi?: boolean } = {}): FakeWorld {
  const chain = opts.chain ?? defaultChain();
  const backend: FakeWorld["backend"] = [];
  const failures = [...(opts.quoteFails ?? [])];
  const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const text = init?.body ? String(init.body) : undefined;
    if (url.origin === RPC) {
      const req = JSON.parse(text!) as { id: number; method: string; params: unknown[] } | Array<{ id: number; method: string; params: unknown[] }>;
      const one = (r: { id: number; method: string; params: unknown[] }) => {
        try {
          return { jsonrpc: "2.0", id: r.id, result: rpcResult(chain, r.method, r.params) };
        } catch (e) {
          if (e instanceof RevertWith) return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: e.message, data: e.data } };
          return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } };
        }
      };
      return new Response(JSON.stringify(Array.isArray(req) ? req.map(one) : one(req)), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = text ? JSON.parse(text) : undefined;
    backend.push({ url, body });
    const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const now = Math.floor(Date.now() / 1000);
    if (url.pathname === "/api/stockyield/funds") return opts.vaultApi ? ok(vaultApiFixture(chain)) : ok({ error: "unavailable" }, 503);
    if (url.pathname === "/v1/rfq") {
      const f = failures.shift();
      if (f) return ok(f.body, f.status);
      return ok(await makerQuote(body as Parameters<typeof makerQuote>[0], { dryRun: opts.quoteDryRun, uiMultiplier: chain.uiMultiplier }));
    }
    if (opts.indexerDown) return ok({ error: "unavailable" }, 503);
    if (url.pathname === "/v1/pnl") return ok(pnlFixture(now));
    if (url.pathname === "/v1/history") {
      const h = historyFixture(now);
      const since = url.searchParams.get("since");
      const limit = url.searchParams.get("limit");
      let events = h.events;
      if (since) events = events.filter((e) => e.at >= Number(since));
      if (limit) events = events.slice(0, Number(limit));
      return ok({ ...h, events });
    }
    if (url.pathname === "/v1/positions") return ok({ account: ACCOUNT, positions: [], leaderboard: { account: ACCOUNT, fills: 2, settledPnlRaw: "1200000" }, agentId: null });
    if (url.pathname === "/v1/fills") return ok({ fills: [] });
    return ok({ error: "unknown_route" }, 404);
  }) as typeof fetch;
  return { fetch: fetchImpl, chain, backend };
}

/** Points the market client's RPC transport (global fetch) at the fake node for the duration of `fn`. */
export async function withGlobalFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}
