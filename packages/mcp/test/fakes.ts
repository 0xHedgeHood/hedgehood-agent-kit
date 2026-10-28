/**
 * Test doubles shared by the MCP and CLI tests: a JSON-RPC node answering the market's reads from fixtures, a maker
 * quoting both sides of every instrument, and an indexer with /v1/pnl and /v1/history rows. Everything goes through one
 * `fetch` so no network is touched.
 */
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeFillOrderAs, encodeInstrumentId, epochFundAbi, erc20Abi, instrumentName, marketV2Abi, openDepositGateAbi, orderBookV2Abi, orderDigest, orderToJson, Side, signOrder, vaultRegistryAbi, type Order, type QuoteResponse } from "@hedgehood-io/sdk";

export const ACCOUNT = "0x3333333333333333333333333333333333333333" as Address;
export const BOOK = "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5" as Address;
export const MARKET = "0xC289617d613C9865a6595B365DaD88277282e0Ac" as Address;
export const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const EXPIRY = 1793390400n; // 2026-10-30 16:00 New York
export const STRIKES = [210_000_000n, 220_000_000n];
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
  /** The Stock Yield fund (testnet hhNVDA-CC addresses). */
  vault: VaultState;
}

export function defaultChain(): ChainState {
  return { positions: [0n, -(ONE / 2n), ONE, 0n], collateralRaw: 100_000_000n, requirementRaw: 10_000_000n, simulated: [], vault: defaultVault() };
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
    switch (functionName) {
      case "symbol":
        return enc(usdg ? "tUSDG" : "NVDA");
      case "balanceOf":
        return enc((a[0] as string).toLowerCase() === VAULT.toLowerCase() ? 0n : usdg ? v.walletUsdg : v.walletStock);
      case "allowance":
        return enc(usdg ? v.usdgAllowance : v.stockAllowance);
      case "approve":
        state.simulated.push(call.data);
        return enc(true);
    }
  }
  if (to === VAULT.toLowerCase()) {
    switch (functionName) {
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
  if (method !== "eth_call") throw new Error(`fake rpc: unexpected ${method}`);
  const call = params[0] as { to: Address; data: Hex; from?: Address };
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
      return enc(STRIKES);
    case "positions":
      return enc(state.positions);
    case "protocolFeeBps":
      return enc(50n);
    case "tradingOpen":
      return enc(true);
    case "requirementIfTraded":
      return enc(0n);
    case "uiMultiplier":
      return enc(ONE);
    case "expiryInfo":
      return enc({ openedAt: 1792785600n, settled: false, settledByOwner: false, uiMultiplier: ONE, anchor: 215_000_000n, capLow: 150_500_000n, capHigh: 279_500_000n, settlementPrice: 0n, rawSettlementPrice: 0n, strikes: STRIKES });
    case "sessions":
      return enc([BigInt(Math.floor(Date.now() / 1000) + 86400), 3n, 0n]);
    case "fillOrderAs":
      state.simulated.push(call.data);
      return "0x";
    default:
      throw new Error(`fake rpc: no fixture for ${functionName}(${(args as unknown as unknown[] | undefined)?.join(", ") ?? ""})`);
  }
}

/** The maker's `POST /v1/rfq` answer for a request body, signed for real so the SDK's verification passes. */
export async function makerQuote(body: { instrument: string; side: "buy" | "sell"; quantity: string; taker: Address }, opts: { now?: number; dryRun?: boolean } = {}): Promise<QuoteResponse> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const isPut = body.instrument.endsWith("-P");
  const strike = BigInt(Math.round(Number(body.instrument.split("-")[2]) * 1e6));
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
      return ok(await makerQuote(body as Parameters<typeof makerQuote>[0], { dryRun: opts.quoteDryRun }));
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
