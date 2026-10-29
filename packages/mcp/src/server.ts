import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  renderPnlDashboard,
  buildRegistrationFile,
  dataUri,
  decodeInstrumentId,
  depositViaGateway,
  describeInstrument,
  describeSessionCharge,
  encodeInstrumentId,
  encodeRegisterAgent,
  drawFaucet,
  encodeFaucet,
  faucetRefusal,
  getFaucet,
  readFaucet,
  type FaucetStatus,
  expiryOf,
  formatSessionCap,
  formatShares,
  formatSignedUsdg,
  formatStrike,
  formatUsdg,
  identityRegistryFor,
  instrumentName,
  orderDigest,
  orderFromJson,
  orderToJson,
  parseShares,
  parseUsdg,
  planClose,
  pnlByInstrument,
  positionPnl,
  shareStrikeOf,
  Side,
  tokenStrikeOf,
  UNIT_MULTIPLIER,
  UNLIMITED,
  LTV_WARN_FRACTION,
  type BorrowStatus,
  type ClosePlan,
  type LendStatus,
  type LendingPlan,
  type OracleStatus,
  type PlanStep,
  type PlanStepResult,
  type PlannedSessionLeg,
  type QuoteResponse,
  type SessionCharge,
  type TxRequest,
  type VaultAccountInfo,
  type VaultInfo,
  type VaultPlan,
  type VerifiedQuote,
} from "@hedgehood-io/sdk";
import { formatUnits } from "viem";
import type { Address, Chain, Hex } from "viem";
import type { MarketClient } from "@hedgehood-io/sdk";
import { z } from "zod";
import { requireOwner, requireSession, type KitContext } from "./context.js";
import { describeConfig } from "./config.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "address").transform((s) => s as Address);
const uintString = z.string().regex(/^\d+$/, "unsigned integer string");
const decimalAmount = z.string().regex(/^\d+(\.\d+)?$/, "decimal amount, e.g. \"25\" or \"0.5\"");
const sessionCap = z.string().regex(/^(\d+(\.\d+)?|unlimited)$/i, "USDG amount, e.g. \"100\", or \"unlimited\"");

/** "unlimited" -> type(uint256).max, else USDG -> raw. */
function parseCap(v: string): bigint {
  return /^unlimited$/i.test(v.trim()) ? UNLIMITED : parseUsdg(v);
}

const confirmField = z.boolean().default(false).describe("Must be true to act. Without it the tool only explains what it would do.");
const dryRunField = z.boolean().optional().describe("true (default): simulate and return the unsigned transaction, send nothing. false: sign and broadcast.");

function json(v: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const instrumentFields = {
  instrument: z.string().regex(/^[A-Za-z]{1,8}-\d{8}-\d+(\.\d+)?-[CPcp]$/).optional().describe("Backend name, e.g. NVDA-20261030-220-C"),
  instrumentId: uintString.optional().describe("Packed id from list_instruments"),
  expiry: uintString.optional().describe("Unix seconds of the expiry"),
  strike: decimalAmount.optional().describe("Listed per-share strike in USDG, e.g. \"220\" (the name's strike, not the per-token raw)"),
  kind: z.enum(["call", "put"]).optional(),
};

/** An instrument from a backend name, a packed id, or expiry + strike + kind. */
async function instrumentFrom(m: MarketClient, args: { instrument?: string; instrumentId?: string; expiry?: string; strike?: string; kind?: "call" | "put" }): Promise<bigint> {
  if (args.instrumentId) return BigInt(args.instrumentId);
  if (args.instrument) return m.resolveInstrumentName(args.instrument);
  if (args.expiry && args.strike && args.kind) {
    const expiry = BigInt(args.expiry);
    return encodeInstrumentId(expiry, tokenStrikeOf(parseUsdg(args.strike), await m.expiryMultiplier(expiry)), args.kind === "put");
  }
  throw new Error("give instrument (NVDA-20261030-220-C), or instrumentId, or expiry + strike + kind");
}

/**
 * `extra` is merged into every JSON answer (what a close or fill was priced at), never into an error. With the leg's
 * `sessionCharge`, a SessionLimit revert names the budget it draws and what was left.
 */
async function sendOrExplain(ctx: KitContext, who: "session" | "owner", tx: TxRequest, confirm: boolean, dryRun: boolean | undefined, extra: Record<string, unknown> = {}, sessionCharge?: SessionCharge) {
  const dry = dryRun ?? ctx.config.dryRunDefault;
  if (!confirm) {
    return json({ ...extra, ok: false, needsConfirm: true, wouldSend: tx.summary, to: tx.to, data: tx.data, dryRun: dry, hint: "call again with confirm: true" });
  }
  const signer = who === "owner" ? requireOwner(ctx) : requireSession(ctx);
  const m = ctx.market(who);
  try {
    const r = await m.send(tx, { dryRun: dry, sessionCharge });
    if (r.dryRun) return json({ ...extra, ok: true, dryRun: true, simulated: true, from: signer.address, to: tx.to, data: tx.data, summary: tx.summary, hint: "simulation passed; call again with dryRun: false to broadcast" });
    const receipt = await m.waitForReceipt(r.hash!);
    return json({ ...extra, ok: receipt.status === "success", dryRun: false, txHash: r.hash, blockNumber: receipt.blockNumber, status: receipt.status, from: signer.address, summary: tx.summary, explorer: `${m.chain.blockExplorers?.default.url}/tx/${r.hash}` });
  } catch (e) {
    return fail(`${tx.summary} failed: ${errorText(e)}`);
  }
}

/** Error text without anything that could be a key: viem errors never include signers, but keep it short anyway. */
function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n").slice(0, 6).join(" | ").slice(0, 800);
}

function quoteView(q: VerifiedQuote, underlying: string, side: "buy" | "sell", requestedQuantityRaw: bigint, uiMultiplier: bigint = UNIT_MULTIPLIER) {
  return {
    digest: q.digest,
    instrument: q.instrument,
    label: describeInstrument(q.order.instrumentId, underlying, uiMultiplier),
    instrumentId: q.order.instrumentId.toString(),
    fillable: q.fillable,
    backendDryRun: q.dryRun ? "the desk runs without a signer key: this quote carries a placeholder signature and cannot be filled" : undefined,
    side,
    quantity: formatShares(requestedQuantityRaw),
    pricePerShare: formatUsdg(q.pricePerShareRaw),
    premiumNow: formatUsdg(q.premiumNowRaw),
    takerFee: formatUsdg(q.feeNowRaw),
    youPay: q.netNowRaw > 0n ? formatUsdg(q.netNowRaw) : "0",
    youReceive: q.netNowRaw < 0n ? formatUsdg(-q.netNowRaw) : "0",
    decaysTo: formatUsdg((q.premiumAtExpiryRaw * requestedQuantityRaw + q.order.quantityRaw - 1n) / q.order.quantityRaw),
    validUntil: Number(q.order.validUntil),
    secondsLeft: q.secondsLeft,
    canFill: q.canFill,
    shortfall: q.shortfallRaw > 0n ? formatUsdg(q.shortfallRaw) : undefined,
    fundingPreview: q.funding,
    markMidPerShare: q.markPrice,
    maker: q.order.maker,
    makerSigner: q.order.signer,
  };
}

function closeView(plan: ClosePlan, underlying: string) {
  return {
    instrument: plan.instrument,
    label: describeInstrument(plan.instrumentId, underlying, plan.position.uiMultiplier),
    instrumentId: plan.instrumentId.toString(),
    position: formatShares(plan.position.quantityRaw),
    closes: formatShares(plan.quantityRaw),
    remainingAfter: formatShares(plan.remainingRaw),
    side: plan.side,
    quote: quoteView(plan.quote, underlying, plan.side, plan.quantityRaw, plan.position.uiMultiplier),
  };
}

const SESSION_LIMITS =
  "A session key's fills always settle from the account's deposited balance (the market reverts SessionWalletMode on a session leg in wallet mode). Two cumulative budgets bound it (SessionLimit when a fill needs more than is left): every sell leg draws the short-risk budget (riskLeft) by the worst case of the short it opens, ceil(opened short x maxPayout / 1e18) with maxPayout = capHigh - strike (call) or strike - capLow (put) per token, and selling a long held is free (0 = it cannot sell to open); every buy leg draws the spend budget (spendLeft) by its premium + fee less the worst case of the shorts it buys back (0 = buy to close only).";

/** The session charge of a leg the configured session key is about to fill; undefined without a session key or when the reads fail. */
async function sessionChargeFor(ctx: KitContext, m: MarketClient, leg: Omit<PlannedSessionLeg, "key" | "account">): Promise<SessionCharge | undefined> {
  const key = ctx.session && ctx.session.address.toLowerCase() !== ctx.account.toLowerCase() ? ctx.session.address : undefined;
  if (!key) return undefined;
  try {
    return await m.sessionCharge({ ...leg, key, account: ctx.account });
  } catch {
    return undefined;
  }
}

function sessionChargeView(c: SessionCharge | undefined) {
  if (!c) return undefined;
  return {
    budget: c.budget === "shortRisk" ? "shortRisk (riskLeft)" : "spend (spendLeft)",
    charge: formatUsdg(c.chargeRaw),
    left: c.leftRaw === undefined ? undefined : formatSessionCap(c.leftRaw),
    withinBudget: c.withinBudget,
    openedShort: c.side === "sell" ? formatShares(c.openedShortRaw) : undefined,
    closedShort: c.side === "buy" ? formatShares(c.closedShortRaw) : undefined,
    maxPayoutPerToken: formatUsdg(c.maxPayoutRaw),
    chargeRaw: c.chargeRaw,
    leftRaw: c.leftRaw,
    note: describeSessionCharge(c),
  };
}

function sessionView(s: Awaited<ReturnType<MarketClient["session"]>>) {
  return {
    key: s.key,
    active: s.active,
    canTrade: s.canTrade,
    canCancel: s.canCancel,
    expiresAt: s.expiresAt,
    authorizedAt: s.authorizedAt,
    authorizedAtIso: s.authorizedAt === 0n ? undefined : new Date(Number(s.authorizedAt) * 1000).toISOString(),
    riskLeft: formatSessionCap(s.riskLeft),
    spendLeft: formatSessionCap(s.spendLeft),
    riskLeftRaw: s.riskLeft,
    spendLeftRaw: s.spendLeft,
  };
}

export function createServer(ctx: KitContext): McpServer {
  const server = new McpServer({ name: "hedgehood-options", version: "0.3.0" });
  const underlying = ctx.marketDeployment?.underlying ?? "NVDA";

  server.registerTool(
    "list_markets",
    {
      title: "List markets",
      description: "The option markets this server trades: underlying, chain, contract addresses, open expiries (with the uiMultiplier each snapshotted and its listed per-share strikes) and taker fee. Anchor and caps are per token. Read-only.",
      inputSchema: {},
    },
    async () => {
      const m = ctx.market("none");
      const [expiries, fee, mult] = await Promise.all([m.openedExpiries(), m.protocolFeeBps(), m.uiMultiplier().catch(() => undefined)]);
      const infos = await Promise.all(expiries.map((e) => m.expiryInfo(e)));
      let backend: unknown = undefined;
      try {
        backend = (await ctx.rfq.markets()).filter((x) => x.market.toLowerCase() === m.market.toLowerCase() || x.underlying === underlying);
      } catch (e) {
        backend = { unavailable: errorText(e), hosts: ctx.rfq.hosts };
      }
      return json({
        chainId: ctx.chainId,
        account: ctx.account,
        underlying,
        market: m.market,
        orderBook: m.orderBook,
        settlementToken: m.usdg,
        backendHosts: ctx.rfq.hosts,
        takerFeeBps: fee,
        uiMultiplier: mult,
        expiries: infos.map((i) => ({ expiry: i.expiry, date: new Date(Number(i.expiry) * 1000).toISOString(), tradingOpen: i.tradingOpen, settled: i.settled, uiMultiplier: i.uiMultiplier, anchor: formatUsdg(i.anchor), capLow: formatUsdg(i.capLow), capHigh: formatUsdg(i.capHigh), strikes: i.shareStrikes.map(formatStrike), perTokenStrikesRaw: i.uiMultiplier === UNIT_MULTIPLIER ? undefined : i.strikes })),
        backend,
        config: describeConfig(ctx.config),
      });
    },
  );

  server.registerTool(
    "list_instruments",
    {
      title: "List instruments",
      description: "Calls and puts of one expiry (or all open expiries): instrument names and ids, listed per-share strikes (and the per-token raw strike in the id when the expiry's uiMultiplier is not 1), whether trading is open, and whether the backend quotes them. Read-only.",
      inputSchema: { expiry: uintString.optional().describe("Unix seconds of the expiry; omit for every open expiry") },
    },
    async ({ expiry }) => {
      const m = ctx.market("none");
      const expiries = expiry ? [BigInt(expiry)] : await m.openedExpiries();
      const out = [];
      for (const e of expiries) {
        const info = await m.expiryInfo(e);
        let listed: Record<string, { occ: string; settled: boolean }> = {};
        try {
          const list = await ctx.rfq.instruments(underlying, e);
          listed = Object.fromEntries(list.map((x) => [x.instrumentId, { occ: x.occ, settled: x.settled }]));
        } catch {
          /* backend optional */
        }
        out.push({
          expiry: e,
          date: new Date(Number(e) * 1000).toISOString(),
          tradingOpen: info.tradingOpen,
          settled: info.settled,
          uiMultiplier: info.uiMultiplier,
          settlementPrice: info.settled ? formatUsdg(info.settlementPrice) : undefined,
          instruments: info.strikes.flatMap((s) => (["call", "put"] as const).map((k) => {
            const id = encodeInstrumentId(e, s, k === "put");
            return { instrument: instrumentName(underlying, e, s, k === "put", info.uiMultiplier), instrumentId: id.toString(), label: describeInstrument(id, underlying, info.uiMultiplier), strike: formatStrike(shareStrikeOf(s, info.uiMultiplier)), strikeRaw: s.toString(), kind: k, listedOcc: listed[id.toString()]?.occ, quotedByBackend: id.toString() in listed };
          })),
        });
      }
      return json(out);
    },
  );

  server.registerTool(
    "get_mark",
    {
      title: "Get mark",
      description: "The desk's indicative bid / ask / mid per share (USDG), delta, iv and whether it is executable right now; not a firm price. Use get_quote for one.",
      inputSchema: instrumentFields,
    },
    async (args) => {
      const m = ctx.market("none");
      const id = await instrumentFrom(m, args);
      const uiMultiplier = await m.expiryMultiplier(expiryOf(id));
      const mark = await ctx.rfq.mark({ instrumentId: id, underlying, uiMultiplier });
      return json({ ...mark, label: describeInstrument(id, underlying, uiMultiplier), note: mark.executable ? undefined : `not executable now (${mark.reason ?? "no row"}): no quote will be given; try during the listed session` });
    },
  );

  server.registerTool(
    "get_quote",
    {
      title: "Get firm quote (RFQ)",
      description: "Asks the maker for a firm, signed quote addressed to your account, verifies the signature, taker and expiry locally, and returns price, fee, time left and a digest to pass to fill_quote. Quotes decay and expire in seconds. Read-only (nothing is sent).",
      inputSchema: {
        ...instrumentFields,
        side: z.enum(["buy", "sell"]).describe("buy = you buy the option (pay premium); sell = you write it (receive premium, post collateral)"),
        quantity: decimalAmount.describe("Shares, e.g. \"1\" or \"0.5\""),
      },
    },
    async (args) => {
      const m = ctx.market("none");
      const id = await instrumentFrom(m, args);
      const quantityRaw = parseShares(args.quantity);
      const fee = await m.protocolFeeBps();
      const sessionKey = ctx.session && ctx.session.address.toLowerCase() !== ctx.account.toLowerCase() ? ctx.session.address : undefined;
      const uiMultiplier = await m.expiryMultiplier(expiryOf(id));
      const q = await ctx.rfq.getQuote({ chainId: ctx.chainId, market: m.market, instrumentId: id, side: args.side, quantityRaw, taker: ctx.account, sessionKey, underlying, uiMultiplier }, { orderBook: m.orderBook, protocolFeeBps: fee });
      const digest = q.digest;
      ctx.quotes.set(digest, { quote: q, fetchedAt: Date.now(), side: args.side, requestedQuantityRaw: quantityRaw });
      const view = quoteView(q, underlying, args.side, quantityRaw, uiMultiplier);
      let requirementAfter: string | undefined;
      try {
        requirementAfter = formatUsdg(await m.requirementIfTraded(id, args.side === "buy" ? quantityRaw : -quantityRaw));
      } catch {
        /* optional */
      }
      const charge = await sessionChargeFor(ctx, m, { instrumentId: id, side: args.side, quantityRaw, order: q.order, protocolFeeBps: fee });
      const next = !q.fillable ? "not fillable (backend dry run); nothing to send" : charge?.withinBudget === false ? `the session key cannot fill this: ${charge.budget === "shortRisk" ? "riskLeft" : "spendLeft"} is short (SessionLimit); smaller size, or the owner re-authorizes with a larger ${charge.budget === "shortRisk" ? "maxShortRisk" : "maxSpend"}` : "fill_quote with this digest and confirm: true (dryRun first)";
      return json({ ...view, requirementAfter, sessionCharge: sessionChargeView(charge), order: orderToJson(q.order), signature: q.signature, next });
    },
  );

  server.registerTool(
    "fill_quote",
    {
      title: "Fill a quote",
      description: "Takes a quote from get_quote for your account via fillOrderAs from the session key, always in balance mode (premium, fee and collateral settle from your deposited USDG; no approvals). A sell that opens a short draws the session's short-risk budget (riskLeft) by its worst case, a buy the spend budget (spendLeft) beyond the shorts it closes; the answer carries `sessionCharge`. SessionLimit means the leg needs more than its budget has left, SessionWalletMode that a session leg was not in balance mode. Opens or adds to a position; to exit an existing position before expiry use close_position instead. dryRun (default true) simulates only. Requires confirm: true. Reports the tx hash when sent.",
      inputSchema: {
        digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe("Digest returned by get_quote"),
        order: z.record(z.unknown()).optional().describe("Alternatively the order JSON from get_quote"),
        signature: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
        quantity: decimalAmount.optional().describe("Shares to fill; default: the quoted quantity"),
        confirm: confirmField,
        dryRun: dryRunField,
      },
    },
    async (args) => {
      let order;
      let signature: Hex;
      let quantityRaw: bigint;
      if (args.digest) {
        const cached = ctx.quotes.get(args.digest as Hex);
        if (!cached) return fail("unknown digest; call get_quote again (quotes expire in seconds)");
        if (!cached.quote.fillable) return fail("this quote is a backend dry-run placeholder (no signer key on the desk); it cannot be filled");
        order = cached.quote.order;
        signature = cached.quote.signature;
        quantityRaw = args.quantity ? parseShares(args.quantity) : cached.requestedQuantityRaw;
      } else if (args.order && args.signature) {
        order = orderFromJson(args.order);
        signature = args.signature as Hex;
        quantityRaw = args.quantity ? parseShares(args.quantity) : order.quantityRaw;
      } else {
        return fail("give a digest from get_quote, or order + signature");
      }
      const now = Math.floor(Date.now() / 1000);
      if (BigInt(now) >= order.validUntil) return fail(`quote expired at ${order.validUntil} (now ${now}); call get_quote again`);
      if (order.taker.toLowerCase() !== ctx.account.toLowerCase()) return fail(`quote is addressed to ${order.taker}, not your account ${ctx.account}`);
      const m = ctx.market("session");
      const tx = m.fillOrderAs(order, signature, quantityRaw, true);
      const charge = await sessionChargeFor(ctx, m, { instrumentId: order.instrumentId, side: order.side === Side.Ask ? "buy" : "sell", quantityRaw, order });
      return sendOrExplain(ctx, "session", tx, args.confirm, args.dryRun, charge ? { sessionCharge: sessionChargeView(charge) } : {}, charge);
    },
  );

  server.registerTool(
    "deposit_x402",
    {
      title: "Deposit USDG via x402",
      description: "Funds your market balance through the x402 deposit gateway: signs an EIP-3009 USDG transfer from the paying key's wallet (owner key if set, else session key) and the gateway calls market.deposit(account, amount). dryRun (default true) fetches the 402 and shows what would be signed. Requires confirm: true.",
      inputSchema: { amount: decimalAmount.describe("USDG, e.g. \"25\""), confirm: confirmField, dryRun: dryRunField },
    },
    async ({ amount, confirm, dryRun }) => {
      const amountRaw = parseUsdg(amount);
      const cap = parseUsdg(ctx.config.maxDepositUsdg);
      if (amountRaw > cap) return fail(`amount ${amount} exceeds HEDGEHOOD_MAX_DEPOSIT ${ctx.config.maxDepositUsdg} USDG`);
      const payer = ctx.owner ?? ctx.session;
      if (!payer) return fail("no key to pay with");
      const dry = dryRun ?? ctx.config.dryRunDefault;
      if (!confirm) return json({ ok: false, needsConfirm: true, wouldDo: `pay ${amount} USDG from ${payer.address} to the gateway, credited to ${ctx.account}`, dryRun: dry });
      try {
        const r = await depositViaGateway({ account: ctx.account, market: ctx.deployment.market, amountRaw }, { signer: payer, chainId: ctx.chainId, gatewayUrl: ctx.config.gatewayUrl, fetch: ctx.fetch, dryRun: dry, maxAmountRaw: cap });
        return json({
          ok: true,
          dryRun: r.dryRun,
          payer: payer.address,
          account: ctx.account,
          gateway: { payTo: r.instructions?.payTo, feeRaw: r.instructions?.fee?.raw, limits: r.instructions?.limits },
          requirement: r.requirement,
          settlement: r.settlement,
          deposit: r.deposit,
          depositTxHash: r.depositTxHash,
          hint: r.dryRun ? "402 looks right; call again with dryRun: false to pay" : r.deposit?.status === "prepared" ? "payment collected; the gateway runs with SEND=0 and only prepared the deposit transaction (operator sends it)" : undefined,
        });
      } catch (e) {
        return fail(`deposit failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "positions",
    {
      title: "Positions and balances (active)",
      description: "Your ACTIVE book: market balance (collateral, locked requirement, free), wallet USDG, every open position by instrument with average entry price, the desk's mark, unrealized P&L and time to expiry (when the indexer answers), plus the session's authority (expiry, authorizedAt, riskLeft = worst case of the shorts it may still open, spendLeft = premium + fees it may still pay beyond buying back shorts). Past activity is get_history; totals are get_pnl; to exit a position before expiry call close_position. Read-only.",
      inputSchema: {},
    },
    async () => {
      const m = ctx.market("none");
      const [snap, pnl] = await Promise.all([m.snapshot(ctx.account), ctx.rfq.getPnl(ctx.account).catch(() => undefined)]);
      const settledPending: string[] = [];
      for (const e of snap.expiries) {
        const info = await m.expiryInfo(e);
        if (info.settled) settledPending.push(e.toString());
      }
      const session = ctx.session ? await m.session(ctx.session.address, ctx.account) : undefined;
      const rows = pnlByInstrument(pnl);
      const now = Math.floor(Date.now() / 1000);
      return json({
        account: ctx.account,
        collateral: formatUsdg(snap.collateralRaw),
        requirement: formatUsdg(snap.requirementRaw),
        freeCollateral: formatUsdg(snap.freeCollateralRaw),
        walletUsdg: formatUsdg(snap.walletUsdgRaw),
        positions: snap.positions.map((p) => {
          const f = positionPnl(p, underlying, rows, now);
          return { instrumentId: p.instrumentId, instrument: f.instrument, label: describeInstrument(p.instrumentId, underlying, p.uiMultiplier), strike: formatStrike(p.shareStrike), quantity: formatShares(p.quantityRaw), side: p.quantityRaw > 0n ? "long" : "short", avgPrice: f.avgPrice, mark: f.mark, markBid: f.markBid, markAsk: f.markAsk, unrealized: f.unrealized, expiry: p.expiry, expiresIn: f.expiresIn, secondsToExpiry: f.secondsToExpiry, closeWith: `close_position { instrument: "${f.instrument}" }` };
        }),
        pnl: pnl ? { asOf: pnl.asOf, realized: formatSignedUsdg(pnl.realizedRaw), unrealized: formatSignedUsdg(pnl.unrealizedRaw), feesPaid: formatUsdg(BigInt(pnl.feesPaidRaw)), total: formatSignedUsdg(pnl.totalRaw), note: pnl.note } : "indexer unavailable: no marks or P&L",
        expiries: snap.expiries,
        settledAwaitingRedeem: settledPending,
        session: session ? sessionView(session) : "no session key configured",
      });
    },
  );

  server.registerTool(
    "close_position",
    {
      title: "Close a position (before expiry)",
      description: "Exits an open position before expiry. Positions net out on chain and the maker quotes both sides, so this reads your signed position in the instrument, asks for a firm quote on the OPPOSITE side (a long is sold to the bid, a short is bought back at the ask) for min(|position|, quantity), verifies it and fills it via fillOrderAs from the session key in balance mode, exactly like fill_quote. A close is normally free of the session budgets (selling a long held opens no short; buying back a short is charged only above its worst case); `sessionCharge` says what it draws and whether it fits. Without confirm it only prices the close. dryRun (default true) simulates only; dryRun: false broadcasts and reports the tx hash. Requires confirm: true.",
      inputSchema: {
        ...instrumentFields,
        quantity: decimalAmount.optional().describe("Shares to close; default and maximum: the whole position"),
        fromBalance: z.boolean().default(true).describe("Settle inside the deposited balance (default). A session key always settles in balance mode (the market reverts SessionWalletMode otherwise), so false is ignored for it; false (wallet mode) only applies when the signing key is the account itself"),
        confirm: confirmField,
        dryRun: dryRunField,
      },
    },
    async (args) => {
      const m = ctx.market("session");
      let plan: ClosePlan;
      // a session key cannot fill in wallet mode (SessionWalletMode): force balance mode and say so
      const forced = !args.fromBalance && m.signsAsSession;
      const fromBalance = forced ? true : args.fromBalance;
      try {
        const instrumentId = await instrumentFrom(m, args);
        const sessionKey = ctx.session && ctx.session.address.toLowerCase() !== ctx.account.toLowerCase() ? ctx.session.address : undefined;
        plan = await planClose({ market: m, rfq: ctx.rfq, instrumentId, quantityRaw: args.quantity ? parseShares(args.quantity) : undefined, fromBalance, sessionKey, protocolFeeBps: await m.protocolFeeBps() });
      } catch (e) {
        return fail(`close failed: ${errorText(e)}`);
      }
      ctx.quotes.set(plan.quote.digest, { quote: plan.quote, fetchedAt: Date.now(), side: plan.side, requestedQuantityRaw: plan.quantityRaw });
      const view: ReturnType<typeof closeView> & { fromBalance: boolean; note?: string; sessionCharge?: ReturnType<typeof sessionChargeView> } = { ...closeView(plan, underlying), fromBalance, sessionCharge: sessionChargeView(plan.sessionCharge) };
      if (forced) view.note = "fromBalance: false ignored: a session key always settles in balance mode (the market reverts SessionWalletMode on a session leg in wallet mode)";
      if (!plan.quote.fillable) return json({ ...view, ok: false, fillable: false, note: "the desk runs without a signer key: this quote carries a placeholder signature and cannot be filled; nothing to send" });
      if (plan.quote.canFill === false) view.quote.fundingPreview = { ...view.quote.fundingPreview, note: `maker predicts canFill=false${plan.quote.shortfallRaw > 0n ? ` (shortfall ${formatUsdg(plan.quote.shortfallRaw)} USDG)` : ""}` };
      return sendOrExplain(ctx, "session", plan.request, args.confirm, args.dryRun, view, plan.sessionCharge);
    },
  );

  server.registerTool(
    "get_dashboard",
    {
      title: "Account dashboard (ASCII)",
      description: "Read-only account-wide option portfolio from the indexer: realized/unrealized P&L, fees, active positions and signed ASCII bars. Returns the same display as `hedgehood dashboard`, plus structured raw data. Show the display verbatim in a fenced text block. Bars compare current positions, not historical returns. Missing values stay unknown; no keys or trades are needed.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      const p = await ctx.rfq.getPnl(ctx.account);
      const display = renderPnlDashboard(p, ctx.chainId);
      const data = { chainId: ctx.chainId, ...p, display };
      return {
        content: [{ type: "text" as const, text: "```text\n" + display + "\n```" }, { type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    },
  );

  server.registerTool(
    "get_pnl",
    {
      title: "Profit and loss",
      description: "Your P&L from the indexer: every open position with cost basis, average entry price, the desk's mark (bid / mid / ask per share) and unrealized P&L, then realized (settled) P&L, unrealized total, fees paid and total, all in USDG. Amounts ending in Raw are signed USDG with 6 decimals (quantityRaw: 1e18 shares). Read-only.",
      inputSchema: {},
    },
    async () => {
      const p = await ctx.rfq.getPnl(ctx.account);
      return json({ ...p, summary: { realized: formatSignedUsdg(p.realizedRaw), unrealized: formatSignedUsdg(p.unrealizedRaw), feesPaid: formatUsdg(BigInt(p.feesPaidRaw)), total: formatSignedUsdg(p.totalRaw) } });
    },
  );

  server.registerTool(
    "get_history",
    {
      title: "Past activity",
      description: "Your PAST activity from the indexer, newest first: fills (side, quantity, price per share, premium, fee, counterparty, tx), settlements (settlement price, payout) and redeems (expiry, amount). Open positions are `positions`; totals are get_pnl. Read-only.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe("At most this many events"),
        since: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional().describe("Only events at or after this time: unix seconds or an ISO-8601 date/time"),
      },
    },
    async ({ limit, since }) => {
      let sinceUnix: number | undefined;
      if (typeof since === "number") sinceUnix = since;
      else if (typeof since === "string") {
        const ms = /^\d+$/.test(since) ? Number(since) * (Number(since) > 1e11 ? 1 : 1000) : Date.parse(since);
        if (Number.isNaN(ms)) return fail(`since must be unix seconds or an ISO date/time, got ${since}`);
        sinceUnix = Math.floor(ms / 1000);
      }
      return json(await ctx.rfq.getHistory(ctx.account, { limit, since: sinceUnix }));
    },
  );

  server.registerTool(
    "redeem",
    {
      title: "Redeem a settled expiry",
      description: "Books your settled position of one expiry into your market balance (redeemFor(account, expiry); permissionless, the keeper usually does it). dryRun default true. Requires confirm: true.",
      inputSchema: { expiry: uintString, confirm: confirmField, dryRun: dryRunField },
    },
    async ({ expiry, confirm, dryRun }) => {
      const m = ctx.market("session");
      return sendOrExplain(ctx, "session", m.redeemFor(ctx.account, BigInt(expiry)), confirm, dryRun);
    },
  );

  server.registerTool(
    "withdraw",
    {
      title: "Withdraw USDG (owner key only)",
      description: "Moves free collateral from the market to a wallet. Only the account owner can withdraw; a session key cannot. dryRun default true. Requires confirm: true.",
      inputSchema: { amount: decimalAmount, to: address.optional().describe("Recipient; default: the owner address"), confirm: confirmField, dryRun: dryRunField },
    },
    async ({ amount, to, confirm, dryRun }) => {
      const owner = requireOwner(ctx);
      const m = ctx.market("owner");
      return sendOrExplain(ctx, "owner", m.withdraw(parseUsdg(amount), to ?? owner.address), confirm, dryRun);
    },
  );

  server.registerTool(
    "authorize_session",
    {
      title: "Authorize session key (owner key only)",
      description: "authorizeSession(key, expiresAt, scope, maxShortRisk, maxSpend) from the owner: lets the session key trade for the account (never withdraw). maxSpend (required) is the cumulative premium + fees the key may make the account pay over the session beyond the worst case of the shorts it buys back (\"0\" = buy to close only; \"unlimited\" = no cap; a budget such as \"100\" is recommended). maxShortRisk is the cumulative worst-case payout of the shorts it may open (default \"0\" = it cannot sell to open; e.g. \"60\" covers one share of a 220 call with capHigh 279.5; \"unlimited\" = no cap). " + SESSION_LIMITS + " Re-authorizing (rotate or extend) replaces the terms, resets both budgets and voids every order the key signed before. dryRun default true. Requires confirm: true.",
      inputSchema: {
        key: address.optional().describe("Session key address; default: the configured session key"),
        days: z.number().int().min(1).max(365).default(30),
        maxSpend: sessionCap.optional().describe("Required unless revoke: cumulative USDG of premium + fees the key may spend for the account over the session beyond buying back shorts, e.g. \"100\"; \"0\" = buy to close only; \"unlimited\" = no cap"),
        maxShortRisk: sessionCap.default("0").describe("Cumulative USDG worst case of the shorts the key may open (each sell leg: ceil(opened short x maxPayout / 1e18)); \"0\" (default) = cannot sell to open; \"unlimited\" = no cap"),
        maxRequirement: z.string().optional().describe("Removed (hedgehood-options #58): use maxShortRisk"),
        cancel: z.boolean().default(true).describe("Also grant SCOPE_CANCEL"),
        revoke: z.boolean().default(false).describe("true: revokeSession(key) instead"),
        confirm: confirmField,
        dryRun: dryRunField,
      },
    },
    async ({ key, days, maxSpend, maxShortRisk, maxRequirement, cancel, revoke, confirm, dryRun }) => {
      if (maxRequirement !== undefined) return fail("maxRequirement was removed (hedgehood-options #58): sessions carry a cumulative short-risk budget instead of a cap on the account's requirement. Pass maxShortRisk (USDG; \"0\" = the key cannot sell to open; each short it opens costs its worst-case payout, e.g. one share of a 220 call with capHigh 279.5 costs 59.5).");
      requireOwner(ctx);
      const k = key ?? ctx.session?.address;
      if (!k) return fail("no session key to authorize: pass key or set HEDGEHOOD_SESSION_KEY_FILE");
      const m = ctx.market("owner");
      if (revoke) return sendOrExplain(ctx, "owner", m.revokeSession(k), confirm, dryRun);
      if (maxSpend === undefined) return fail("maxSpend is required: the USDG of premium + fees this key may spend for the account over the session (e.g. \"100\"; \"0\" = buy to close only; \"unlimited\" = no cap)");
      const expiresAt = Math.floor(Date.now() / 1000) + days * 86400;
      const terms = { maxShortRisk: formatSessionCap(parseCap(maxShortRisk)), maxSpend: formatSessionCap(parseCap(maxSpend)), expiresAt, note: "both budgets are cumulative over the session; re-authorizing resets them and voids orders this key signed before" };
      return sendOrExplain(ctx, "owner", m.authorizeSession(k, expiresAt, { trade: true, cancel, maxShortRisk: parseCap(maxShortRisk), maxSpend: parseCap(maxSpend) }), confirm, dryRun, { terms });
    },
  );

  server.registerTool(
    "leaderboard",
    {
      title: "Leaderboard",
      description: "Indexer leaderboard per account or per ERC-8004 agent id: fills, premium paid/received, fees, settled PnL, volume (USDG raw). Read-only.",
      inputSchema: {
        by: z.enum(["account", "agent"]).default("account"),
        order: z.enum(["settledPnlRaw", "fills", "volumeRaw", "premiumPaidRaw", "premiumReceivedRaw"]).default("settledPnlRaw"),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    async ({ by, order, limit }) => json(await ctx.rfq.leaderboard({ by, order, limit })),
  );

  server.registerTool(
    "my_record",
    { title: "My record", description: "Your account as the indexer sees it: positions reconciled from fills (with cost basis), your leaderboard row and ERC-8004 agent id, recent raw fills. For marked P&L use get_pnl; for a readable timeline use get_history. Read-only.", inputSchema: { includeSettled: z.boolean().default(false) } },
    async ({ includeSettled }) => {
      const [view, fills] = await Promise.all([ctx.rfq.positions(ctx.account, includeSettled), ctx.rfq.fills({ account: ctx.account, limit: 20 }).catch(() => [])]);
      return json({ ...view, recentFills: fills });
    },
  );

  server.registerTool(
    "get_agent_record",
    { title: "Agent record (ERC-8004)", description: "The ERC-8004 record (owner, agentURI) of an agent id and the accounts seen trading under it. Read-only.", inputSchema: { agentId: uintString } },
    async ({ agentId }) => json(await ctx.rfq.agent(agentId)),
  );

  server.registerTool(
    "faucet",
    {
      title: "Test funds (testnet faucet)",
      description: "TESTNET only: draws test USD (TestUSD hUSD-test, no value) from its public faucet into the sending wallet (owner key if set, else the session key; deposit(account, amount) is permissionless, so either can then fund the account). faucet() mints 1,000 once per 24 h per address; the answer says when the next draw is allowed. Onboarding: faucet -> deposit (wallet approve + deposit, or x402) -> authorize_session -> get_quote -> fill_quote. Refused on mainnet (USDG has value). dryRun default true. Requires confirm: true.",
      inputSchema: { confirm: confirmField, dryRun: dryRunField },
    },
    async ({ confirm, dryRun }) => {
      let f;
      try {
        f = getFaucet(ctx.chainId);
      } catch (e) {
        return fail(errorText(e));
      }
      const signer = ctx.owner ?? requireSession(ctx);
      const dry = dryRun ?? ctx.config.dryRunDefault;
      try {
        const viewOf = (st: FaucetStatus) => ({ token: f.token, symbol: f.symbol, wallet: signer.address, balance: formatUsdg(st.balanceRaw), nextFaucetAt: st.nextFaucetAt.toString(), canDrawNow: st.canDrawNow });
        if (!confirm) {
          const st = await readFaucet(ctx.chainId, signer.address, { rpcUrl: ctx.config.rpcUrl });
          const refused = faucetRefusal(st);
          if (refused) return json({ ok: false, refused, ...viewOf(st) });
          const tx = encodeFaucet(ctx.chainId);
          return json({ ok: false, needsConfirm: true, wouldSend: tx.summary, to: tx.to, data: tx.data, dryRun: dry, ...viewOf(st), hint: "call again with confirm: true" });
        }
        const d = await drawFaucet(ctx.chainId, signer, { rpcUrl: ctx.config.rpcUrl, dryRun: dry });
        const view = viewOf(d.before);
        if (d.refused) return json({ ok: false, refused: d.refused, ...view });
        if (d.send?.dryRun) return json({ ok: true, dryRun: true, simulated: true, to: d.request.to, data: d.request.data, summary: d.request.summary, ...view, hint: "simulation passed; call again with dryRun: false to broadcast" });
        return json({ ok: d.status === "success", dryRun: false, txHash: d.send?.hash, status: d.status, ...view, balanceAfter: formatUsdg(d.after?.balanceRaw ?? 0n), nextFaucetAt: d.after?.nextFaucetAt.toString(), next: "deposit the test USD: deposit tool, or approve + deposit(account, amount) from the wallet" });
      } catch (e) {
        return fail(`faucet failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "register_agent",
    {
      title: "Register agent identity (ERC-8004, optional)",
      description: "Registers an ERC-8004 agent id for the owner on the chain's Identity Registry (the ERC-8004 reference deployment: 0x8004A169… on mainnet, 0x8004A818… on testnet) with a registration file naming this trading account. Optional; the market does not require it. Owner key. dryRun default true. Requires confirm: true.",
      inputSchema: {
        name: z.string().min(1).max(80),
        description: z.string().max(400).optional(),
        agentURI: z.string().url().optional().describe("Hosted registration file; default: an inline data: URI"),
        confirm: confirmField,
        dryRun: dryRunField,
      },
    },
    async ({ name, description, agentURI, confirm, dryRun }) => {
      requireOwner(ctx);
      let registry: Address;
      try {
        registry = identityRegistryFor(ctx.chainId);
      } catch (e) {
        return fail(errorText(e));
      }
      const uri = agentURI ?? dataUri(buildRegistrationFile({ name, description, account: ctx.account, sessionKey: ctx.session?.address, chainId: ctx.chainId }));
      return sendOrExplain(ctx, "owner", encodeRegisterAgent(ctx.chainId, uri, registry), confirm, dryRun);
    },
  );

  server.registerTool(
    "decode_instrument",
    {
      title: "Decode instrument id",
      description: "Expiry, strike and kind of an instrument id, with its backend name. The id packs the per-token strike; `strike` is the listed per-share strike under the expiry's snapshotted uiMultiplier (read from the market when the expiry is open, else 1, or pass uiMultiplier). Read-only.",
      inputSchema: { instrumentId: uintString, uiMultiplier: uintString.optional().describe("The expiry's uiMultiplier (1e18 = 1.0); default: read from the market") },
    },
    async ({ instrumentId, uiMultiplier }) => {
      const id = BigInt(instrumentId);
      const d = decodeInstrumentId(id);
      let m = uiMultiplier ? BigInt(uiMultiplier) : undefined;
      if (m === undefined && ctx.marketDeployment) m = await ctx.market("none").expiryMultiplier(d.expiry).catch(() => undefined);
      const mult = m && m > 0n ? m : UNIT_MULTIPLIER;
      return json({ ...d, strike: formatStrike(shareStrikeOf(d.strike, mult)), strikeRaw: d.strike, uiMultiplier: mult, date: new Date(Number(d.expiry) * 1000).toISOString(), instrument: instrumentName(underlying, d.expiry, d.strike, d.isPut, mult), label: describeInstrument(id, underlying, mult) });
    },
  );

  registerVaultTools(server, ctx);
  registerLendingTools(server, ctx);
  return server;
}

// ---------------------------------------------------------------- Stock Yield vaults

const VAULT_CYCLE =
  "Vaults are asynchronous: a request queues until the fund's next epoch freeze (Monday morning New York for the mainnet funds), " +
  "the freeze prices deposits at NAV and pays redemptions in kind (stock + USDG), and the result is then claimed with vault_claim. " +
  "Deposits are not instant and a redeem waits for the current weekly option to expire, so it can take up to a week. Requests can be cancelled until the cutoff with vault_cancel.";

const iso = (t?: bigint) => (t === undefined || t === 0n ? undefined : new Date(Number(t) * 1000).toISOString());

function vaultAccountView(my: VaultAccountInfo) {
  return {
    account: my.account,
    shares: formatShares(my.sharesRaw),
    uncreditedShares: my.uncreditedSharesRaw !== 0n ? formatShares(my.uncreditedSharesRaw) : undefined,
    pendingDeposit: my.pendingDeposit ? { epoch: my.pendingDeposit.epoch, usdg: formatUsdg(my.pendingDeposit.usdgRaw), stock: formatShares(my.pendingDeposit.stockRaw), cancellable: my.pendingDeposit.cancellable } : null,
    pendingRedeem: my.pendingRedeem ? { epoch: my.pendingRedeem.epoch, shares: formatShares(my.pendingRedeem.sharesRaw), cancellable: my.pendingRedeem.cancellable } : null,
    claimable: { stock: formatShares(my.claimableStockRaw), usdg: formatUsdg(my.claimableUsdgRaw) },
    canDeposit: my.canDeposit,
    wallet: { usdg: formatUsdg(my.walletUsdgRaw), stock: formatShares(my.walletStockRaw) },
    nextAction:
      my.claimableStockRaw !== 0n || my.claimableUsdgRaw !== 0n
        ? "vault_claim: redeemed or refunded assets are waiting"
        : my.pendingRedeem
          ? `wait for the freeze of epoch ${my.pendingRedeem.epoch}, then vault_claim`
          : my.pendingDeposit
            ? `wait for the freeze of epoch ${my.pendingDeposit.epoch}; the shares appear on your next action`
            : my.sharesRaw !== 0n
              ? "holding shares; vault_redeem to exit (paid at the next freeze after the current option expires)"
              : my.canDeposit
                ? "vault_deposit to join the next epoch"
                : "not admitted by the deposit gate",
  };
}

export function vaultView(v: VaultInfo) {
  const nav = v.nav.usdgPerShareRaw;
  return {
    vault: v.vault,
    symbol: v.symbol,
    name: v.name,
    strategy: v.strategy,
    stock: v.stock,
    usdg: v.usdg,
    gate: v.gate,
    paused: v.paused,
    depositCap: formatUsdg(v.depositCapUsdgRaw),
    capUsed: formatUsdg(v.capUsedUsdgRaw),
    capLeft: formatUsdg(v.capUsedUsdgRaw >= v.depositCapUsdgRaw ? 0n : v.depositCapUsdgRaw - v.capUsedUsdgRaw),
    totalShares: formatShares(v.totalSharesRaw),
    holdings: { stock: formatShares(v.stockHeldRaw), usdg: formatUsdg(v.usdgHeldRaw) },
    nav: { usdgPerShare: nav === undefined ? null : formatUsdg(nav), navUsdg: formatUsdg(v.nav.navUsdgRaw), stockPrice: v.nav.priceRaw === 0n ? null : formatUnits(v.nav.priceRaw, 18), source: v.nav.source },
    epoch: {
      index: v.epoch.index,
      state: v.epoch.state,
      phase: v.epoch.phase,
      nextFreezeAt: iso(v.epoch.nextFreezeAt),
      nextSettleAt: iso(v.epoch.nextSettleAt),
      nextCohort: v.epoch.nextCohort,
      schedule: { depositCutoff: iso(v.epoch.schedule.depositCutoff), tradeStart: iso(v.epoch.schedule.tradeStart), tradeEnd: iso(v.epoch.schedule.tradeEnd), expiry: iso(v.epoch.schedule.expiry) },
    },
    lastEpoch: v.lastEpoch ? { index: v.lastEpoch.index, premiumIncome: formatUsdg(v.lastEpoch.incomeUsdgRaw), navAtFreeze: formatUsdg(v.lastEpoch.navAtFreezeUsdgRaw), weeklyYield: v.lastEpoch.weeklyYieldBps === undefined ? null : `${(v.lastEpoch.weeklyYieldBps / 100).toFixed(2)}%`, settledAt: iso(v.lastEpoch.settledAt) } : null,
    feeBps: v.feeBps,
    source: v.source,
    my: v.my ? vaultAccountView(v.my) : undefined,
  };
}

function planView(plan: VaultPlan) {
  return { vault: plan.vault, symbol: plan.symbol, account: plan.account, summary: plan.summary, steps: plan.steps.map((s) => ({ kind: s.kind, to: s.to, data: s.data, summary: s.summary })) };
}

/** Same gating as sendOrExplain, for a plan of one or more owner-key transactions (vault or lending). */
async function runPlanOrExplain(ctx: KitContext, plan: { steps: PlanStep[]; summary: string }, client: { sendPlan: (p: never, o: { dryRun: boolean }) => Promise<PlanStepResult[]>; chain: Chain }, view: Record<string, unknown>, confirm: boolean, dryRun: boolean | undefined, extra: Record<string, unknown>) {
  const dry = dryRun ?? ctx.config.dryRunDefault;
  if (!confirm) return json({ ...view, ok: false, needsConfirm: true, wouldSend: plan.summary, dryRun: dry, hint: "call again with confirm: true", ...extra });
  const owner = requireOwner(ctx);
  try {
    const results = await client.sendPlan(plan as never, { dryRun: dry });
    if (dry) {
      return json({ ...view, ok: true, dryRun: true, from: owner.address, steps: results.map((r) => ({ kind: r.kind, to: r.request.to, data: r.request.data, summary: r.request.summary, simulated: r.simulated })), hint: `simulation passed${results.some((r) => !r.simulated) ? " (a step after an approval is not simulated until the approval is mined)" : ""}; call again with dryRun: false to broadcast`, ...extra });
    }
    const ok = results.length === plan.steps.length && results.every((r) => r.status === "success");
    return json({ ...view, ok, dryRun: false, from: owner.address, steps: results.map((r) => ({ kind: r.kind, txHash: r.hash, status: r.status, blockNumber: r.blockNumber, summary: r.request.summary, explorer: `${client.chain.blockExplorers?.default.url}/tx/${r.hash}` })), ...extra });
  } catch (e) {
    return fail(`${plan.summary} failed: ${errorText(e)}`);
  }
}

function sendPlanOrExplain(ctx: KitContext, plan: VaultPlan, confirm: boolean, dryRun: boolean | undefined) {
  return runPlanOrExplain(ctx, plan, ctx.vault("owner"), planView(plan), confirm, dryRun, { cycle: VAULT_CYCLE });
}

const vaultRef = z.string().min(1).describe("Fund address, share symbol (hhNVDA-CC, NVDA-CC) or stock ticker when it names one fund (GOOGL)");

function registerVaultTools(server: McpServer, ctx: KitContext) {
  server.registerTool(
    "list_vaults",
    {
      title: "List Stock Yield vaults",
      description:
        "Hedgehood's Stock Yield vaults (v2 EpochFund) on this chain: for each fund its share symbol, strategy, stock, deposit gate, cap and cap used, total shares, NAV per share in USDG, the epoch (index, state open|frozen|locked|settling, next freeze and next settlement times), the last settled epoch's premium income, and your shares / pending requests / claimables. Reads the chain (VaultRegistry) and, on mainnet, the public fund snapshot API. Read-only. " +
        VAULT_CYCLE +
        " Non-US only.",
      inputSchema: {},
    },
    async () => {
      try {
        const v = ctx.vault("none");
        const list = await v.listVaults({ account: ctx.account });
        return json({ chainId: ctx.chainId, account: ctx.account, registry: v.registry, api: v.apiUrl ?? null, vaults: list.map(vaultView), cycle: VAULT_CYCLE });
      } catch (e) {
        return fail(`list_vaults failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "vault_status",
    {
      title: "My vault positions",
      description: "Your position in the Stock Yield vaults: shares held (and not yet credited), a queued deposit or redemption with its epoch and whether it can still be cancelled, assets waiting to be claimed, wallet balances, and the suggested next action. One fund with `vault`, else every fund you touched or can deposit into. Read-only. " + VAULT_CYCLE,
      inputSchema: { vault: vaultRef.optional() },
    },
    async ({ vault }) => {
      try {
        const v = ctx.vault("none");
        const vaults = vault ? [await v.resolveVault(vault)] : undefined;
        const list = await v.status(ctx.account, { vaults });
        const touched = vault ? list : list.filter((x) => x.my && (x.my.sharesRaw !== 0n || x.my.pendingDeposit || x.my.pendingRedeem || x.my.claimableStockRaw !== 0n || x.my.claimableUsdgRaw !== 0n || x.my.canDeposit));
        return json({ chainId: ctx.chainId, account: ctx.account, vaults: touched.map((x) => ({ vault: x.vault, symbol: x.symbol, epoch: vaultView(x).epoch, nav: vaultView(x).nav, ...vaultAccountView(x.my!) })) });
      } catch (e) {
        return fail(`vault_status failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "vault_deposit",
    {
      title: "Deposit into a Stock Yield vault (owner key)",
      description:
        "Queues a deposit of USDG (and/or the fund's stock) from the owner wallet into a vault for your account: ERC-20 approve(s) to the fund when the allowance is short, then requestDeposit(stock, usdg, receiver). " +
        VAULT_CYCLE +
        " Checks the deposit gate, pause, cap, minimums and wallet balance first. Owner key (HEDGEHOOD_OWNER_KEY_FILE); a market session key cannot do this. dryRun (default true) simulates and returns the unsigned transactions; false broadcasts them in order and reports the tx hashes. Requires confirm: true.",
      inputSchema: {
        vault: vaultRef,
        usdg: decimalAmount.optional().describe("USDG to deposit, e.g. \"100\""),
        stock: decimalAmount.optional().describe("Stock tokens to deposit instead of / besides USDG, e.g. \"0.5\" (18 decimals)"),
        receiver: address.optional().describe("Account credited with the shares; default: your account"),
        confirm: confirmField,
        dryRun: dryRunField,
      },
    },
    async ({ vault, usdg, stock, receiver, confirm, dryRun }) => {
      try {
        requireOwner(ctx);
        const v = ctx.vault("owner");
        const plan = await v.planDeposit({ vault: await v.resolveVault(vault), usdgRaw: usdg ? parseUsdg(usdg) : undefined, stockRaw: stock ? parseShares(stock) : undefined, receiver });
        return sendPlanOrExplain(ctx, plan, confirm, dryRun);
      } catch (e) {
        return fail(`vault_deposit failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "vault_redeem",
    {
      title: "Redeem Stock Yield vault shares (owner key)",
      description:
        "Queues a redemption of shares (an amount or \"all\") for your account: requestRedeem(shares, account). The shares move to escrow now and are paid in kind (stock + USDG, pro rata) at the cohort's freeze, which comes after the current weekly option expires; then call vault_claim. " +
        VAULT_CYCLE +
        " Owner key. dryRun (default true) simulates only. Requires confirm: true.",
      inputSchema: { vault: vaultRef, shares: z.string().regex(/^(all|\d+(\.\d+)?)$/i).describe("Shares to redeem, e.g. \"2.5\", or \"all\""), confirm: confirmField, dryRun: dryRunField },
    },
    async ({ vault, shares, confirm, dryRun }) => {
      try {
        requireOwner(ctx);
        const v = ctx.vault("owner");
        const plan = await v.planRedeem({ vault: await v.resolveVault(vault), shares });
        return sendPlanOrExplain(ctx, plan, confirm, dryRun);
      } catch (e) {
        return fail(`vault_redeem failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "vault_claim",
    {
      title: "Claim from a Stock Yield vault (owner key)",
      description: "Pays your redeemed (or refunded) stock and USDG out of a vault: claim(account, to). Only possible once the cohort of your redemption has frozen; vault_status shows what is claimable. Owner key. dryRun (default true) simulates only. Requires confirm: true.",
      inputSchema: { vault: vaultRef, to: address.optional().describe("Recipient; default: the owner address"), confirm: confirmField, dryRun: dryRunField },
    },
    async ({ vault, to, confirm, dryRun }) => {
      try {
        requireOwner(ctx);
        const v = ctx.vault("owner");
        const plan = await v.planClaim({ vault: await v.resolveVault(vault), to });
        return sendPlanOrExplain(ctx, plan, confirm, dryRun);
      } catch (e) {
        return fail(`vault_claim failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "vault_cancel",
    {
      title: "Cancel a queued vault request (owner key)",
      description: "Cancels your queued deposit (returned to `to`, default the owner wallet) or queued redemption (shares back to your balance) in a vault, possible until that cohort's cutoff (vault_status: cancellable). Owner key. dryRun (default true) simulates only. Requires confirm: true.",
      inputSchema: { vault: vaultRef, which: z.enum(["deposit", "redeem"]), to: address.optional().describe("deposit only: where the returned assets go; default: the owner address"), confirm: confirmField, dryRun: dryRunField },
    },
    async ({ vault, which, to, confirm, dryRun }) => {
      try {
        requireOwner(ctx);
        const v = ctx.vault("owner");
        const addr = await v.resolveVault(vault);
        const plan = which === "deposit" ? await v.planCancelDeposit({ vault: addr, to }) : await v.planCancelRedeem({ vault: addr });
        return sendPlanOrExplain(ctx, plan, confirm, dryRun);
      } catch (e) {
        return fail(`vault_cancel failed: ${errorText(e)}`);
      }
    },
  );
}

// ---------------------------------------------------------------- Share lending (hhUSDG vault + Blue market on fund shares)

const LENDING_NOTE =
  "Share lending is instant (no epochs): the USDG lending vault hhUSDG is a Morpho Vault V2 (ERC-4626) whose USDG is supplied to the Morpho Blue market " +
  "where Stock Yield fund shares (hhNVDA-CC) are collateral; interest accrues per second from borrowers. Borrowers are liquidated when the health factor falls below 1 " +
  "(debt above LLTV 62.5% of the oracle's share value); the collateral oracle (ShareRiskOracle) is a conservative share value re-marked every week after the Monday lock, " +
  "so keep the LTV at or below 70% of the LLTV. Collateral shares must be in the wallet: shares a fund paid out are claimed first with vault_claim, deposited shares appear " +
  "on the account's next fund action. The market id can change (an oracle migration creates a new market); the tools read the current one from the vault. Non-US only.";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? null : `${(x * 100).toFixed(2)}%`);

function oracleView(o: OracleStatus) {
  return {
    address: o.address,
    state: o.state,
    meaning: o.state === "live" ? "the fund's own price answers" : o.state === "held" ? "stock market closed: the feed's last print is held (decays after a long outage in trading hours)" : "no usable price: borrow, withdrawCollateral and liquidate are frozen until it answers (repay and supplyCollateral work)",
    collateralPriceUsdgPerShare: o.collateralPriceUsdgRaw === undefined ? null : formatUsdg(o.collateralPriceUsdgRaw),
    priceRaw: o.priceRaw,
    stockSpot: o.spotRaw === undefined ? null : formatUnits(o.spotRaw, 18),
    nav: o.navRaw === undefined ? null : formatUsdg(o.navRaw),
    openCallLiabilities: o.liabilitiesRaw === undefined ? null : formatUsdg(o.liabilitiesRaw),
    error: o.error,
  };
}

function marketView(m: BorrowStatus["market"]) {
  return {
    id: m.id,
    loanToken: m.loanToken,
    collateralToken: m.collateralToken,
    oracle: m.oracle,
    irm: m.irm,
    lltv: pct(Number(m.lltv) / 1e18),
    lltvRaw: m.lltv,
    oraclePriceRaw: m.oraclePriceRaw,
    collateralPriceUsdgPerShare: m.collateralPriceUsdgRaw === null ? null : formatUsdg(m.collateralPriceUsdgRaw),
    borrowRate: pct(m.borrowRate),
    borrowRatePerSecondRaw: m.borrowRatePerSecondRaw,
    utilization: pct(m.utilization),
    totalSupply: formatUsdg(m.totalSupplyRaw),
    totalSupplyRaw: m.totalSupplyRaw,
    totalBorrow: formatUsdg(m.totalBorrowRaw),
    totalBorrowRaw: m.totalBorrowRaw,
    available: formatUsdg(m.available),
    availableRaw: m.available,
    isLiquidityMarket: m.isLiquidityMarket,
    note: m.note,
    oracleStatus: oracleView(m.oracleStatus),
  };
}

export function lendView(s: LendStatus) {
  return {
    vault: s.vault,
    name: s.name,
    symbol: s.symbol,
    asset: s.asset,
    totalAssets: formatUsdg(s.totalAssetsRaw),
    totalAssetsRaw: s.totalAssetsRaw,
    idle: formatUsdg(s.idleRaw),
    allocated: formatUsdg(s.allocatedRaw),
    cap: formatUsdg(s.capRaw),
    capRaw: s.capRaw,
    capLeft: formatUsdg(s.capLeftRaw),
    withdrawableNow: formatUsdg(s.liquidityRaw),
    utilization: pct(s.utilization),
    supplyApy: pct(s.supplyApy),
    supplyApyNote: s.supplyApyNote,
    performanceFee: pct(s.performanceFee),
    market: s.market ? { id: s.market.id, borrowRate: pct(s.market.borrowRate), utilization: pct(s.market.utilization), totalBorrow: formatUsdg(s.market.totalBorrowRaw), available: formatUsdg(s.market.available), collateralToken: s.market.collateralToken, oracle: s.market.oracle } : null,
    oracle: s.oracle ? oracleView(s.oracle) : null,
    discovery: s.discovery === "vault" ? "market read from the vault's liquidity adapter" : "vault unreadable: market from the deployment registry",
    my: s.my
      ? {
          account: s.my.account,
          shares: formatUnits(s.my.sharesRaw, 18),
          sharesRaw: s.my.sharesRaw,
          assets: formatUsdg(s.my.assetsRaw),
          assetsRaw: s.my.assetsRaw,
          walletUsdg: formatUsdg(s.my.walletUsdgRaw),
          walletUsdgRaw: s.my.walletUsdgRaw,
          canDeposit: s.my.canDeposit,
          canWithdraw: s.my.canWithdraw,
          nextAction: s.my.sharesRaw !== 0n ? "holding hhUSDG; lend_withdraw (amount or \"all\") any time there is liquidity" : s.my.walletUsdgRaw !== 0n ? "lend_deposit to start earning" : "fund the wallet with USDG first",
        }
      : undefined,
  };
}

export function borrowView(s: BorrowStatus) {
  const my = s.my;
  return {
    blue: s.blue,
    market: marketView(s.market),
    my: {
      account: my.account,
      collateralShares: formatShares(my.collateralRaw),
      collateralRaw: my.collateralRaw,
      collateralValue: my.collateralValueRaw === null ? null : formatUsdg(my.collateralValueRaw),
      debt: formatUsdg(my.borrowAssetsRaw),
      borrowAssetsRaw: my.borrowAssetsRaw,
      borrowSharesRaw: my.borrowSharesRaw,
      maxBorrow: my.maxBorrowRaw === null ? null : formatUsdg(my.maxBorrowRaw),
      maxBorrowRaw: my.maxBorrowRaw,
      borrowable: my.borrowableRaw === null ? null : formatUsdg(my.borrowableRaw),
      recommendedBorrowable: my.recommendedBorrowableRaw === null ? null : formatUsdg(my.recommendedBorrowableRaw),
      healthFactor: my.healthFactor,
      ltv: pct(my.ltv),
      liquidationPriceUsdgPerShare: my.liquidationPriceUsdgRaw === null ? null : formatUsdg(my.liquidationPriceUsdgRaw),
      liquidationPriceRaw: my.liquidationPriceRaw,
      wallet: { fundShares: formatShares(my.walletSharesRaw), usdg: formatUsdg(my.walletUsdgRaw) },
      nextAction:
        my.healthFactor !== null && my.healthFactor < 1
          ? "LIQUIDATABLE: borrow_repay or borrow_supply_collateral now"
          : my.borrowAssetsRaw !== 0n
            ? `debt open at health factor ${my.healthFactor}; borrow_repay (amount or "all") to reduce it, borrow_withdraw_collateral only while it stays >= 1`
            : my.collateralRaw !== 0n
              ? `collateral pledged, no debt: borrow_take up to ${my.recommendedBorrowableRaw === null ? "-" : formatUsdg(my.recommendedBorrowableRaw)} USDG keeps LTV <= ${LTV_WARN_FRACTION * 100}% of LLTV, or borrow_withdraw_collateral`
              : my.walletSharesRaw !== 0n
                ? "fund shares in the wallet: borrow_supply_collateral to pledge them"
                : "no fund shares in the wallet: deposit into a Stock Yield vault first (vault_deposit), or vault_claim shares the fund owes you",
    },
    discovery: s.discovery === "vault" ? "market read from the vault's liquidity adapter" : "vault unreadable: market from the deployment registry",
    warnings: s.warnings,
  };
}

function lendingPlanView(plan: LendingPlan) {
  return {
    action: plan.action,
    account: plan.account,
    market: plan.market ? { id: plan.market.id, oracle: plan.market.oracle, lltv: pct(Number(plan.market.lltv) / 1e18) } : undefined,
    summary: plan.summary,
    warnings: plan.warnings,
    after: plan.after ? { collateralShares: formatShares(plan.after.collateralRaw), debt: formatUsdg(plan.after.borrowAssetsRaw), healthFactor: plan.after.healthFactor, ltv: pct(plan.after.ltv), liquidationPriceUsdgPerShare: plan.after.liquidationPriceUsdgRaw === null ? null : formatUsdg(plan.after.liquidationPriceUsdgRaw) } : undefined,
    steps: plan.steps.map((s) => ({ kind: s.kind, to: s.to, data: s.data, summary: s.summary })),
  };
}

function sendLendingPlanOrExplain(ctx: KitContext, plan: LendingPlan, confirm: boolean, dryRun: boolean | undefined) {
  return runPlanOrExplain(ctx, plan, ctx.lending("owner"), lendingPlanView(plan), confirm, dryRun, { note: LENDING_NOTE });
}

const marketIdField = z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe("Blue market id; default: the market the lending vault currently supplies (read from the vault, so a migration needs no change)");
const usdgOrAll = z.string().regex(/^(all|\d+(\.\d+)?)$/i);
const sharesOrAll = z.string().regex(/^(all|\d+(\.\d+)?)$/i);

function registerLendingTools(server: McpServer, ctx: KitContext) {
  server.registerTool(
    "lend_status",
    {
      title: "Lending vault status (hhUSDG)",
      description:
        "Hedgehood's USDG lending vault: size, idle vs supplied, the curator's cap and room left, what can be withdrawn right now, utilization and the current supply rate (borrow rate x utilization, after the 10% performance fee), the Blue market it supplies and the collateral oracle's state, plus your hhUSDG shares, their USDG value and wallet USDG. Read-only. " +
        LENDING_NOTE,
      inputSchema: {},
    },
    async () => {
      try {
        const s = await ctx.lending("none").lendStatus(ctx.account);
        return json({ chainId: ctx.chainId, account: ctx.account, ...lendView(s), note: LENDING_NOTE });
      } catch (e) {
        return fail(`lend_status failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "lend_deposit",
    {
      title: "Lend USDG (owner key)",
      description:
        "Deposits USDG from the owner wallet into the hhUSDG lending vault for your account: ERC-20 approve when the allowance is short, then deposit(assets, onBehalf). Instant; the USDG is supplied to the Blue market and earns the supply rate from that block; withdraw any time there is unborrowed liquidity (lend_withdraw). Checks the wallet, the vault's gate and the cap first. Owner key (HEDGEHOOD_OWNER_KEY_FILE). dryRun (default true) simulates and returns the unsigned transactions; false broadcasts them in order. Requires confirm: true. " +
        LENDING_NOTE,
      inputSchema: { usdg: decimalAmount.describe("USDG to lend, e.g. \"100\""), receiver: address.optional().describe("Account credited with the hhUSDG shares; default: your account"), confirm: confirmField, dryRun: dryRunField },
    },
    async ({ usdg, receiver, confirm, dryRun }) => {
      try {
        requireOwner(ctx);
        const plan = await ctx.lending("owner").planLendDeposit({ usdgRaw: parseUsdg(usdg), receiver });
        return sendLendingPlanOrExplain(ctx, plan, confirm, dryRun);
      } catch (e) {
        return fail(`lend_deposit failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "lend_withdraw",
    {
      title: "Withdraw lent USDG (owner key)",
      description:
        "Withdraws USDG from the hhUSDG lending vault to the owner wallet: withdraw(assets, receiver, account) for an amount, redeem(all shares) for \"all\". Instant while the vault has liquidity (idle USDG + the market's unborrowed USDG); when borrowers hold the rest, only that much can leave until they repay. Owner key. dryRun (default true) simulates only. Requires confirm: true.",
      inputSchema: { usdg: usdgOrAll.describe("USDG to withdraw, e.g. \"50\", or \"all\""), receiver: address.optional().describe("Recipient; default: the owner address"), confirm: confirmField, dryRun: dryRunField },
    },
    async ({ usdg, receiver, confirm, dryRun }) => {
      try {
        requireOwner(ctx);
        const plan = await ctx.lending("owner").planLendWithdraw({ usdg, receiver });
        return sendLendingPlanOrExplain(ctx, plan, confirm, dryRun);
      } catch (e) {
        return fail(`lend_withdraw failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "borrow_status",
    {
      title: "Borrow position on fund shares",
      description:
        "The Blue market where Stock Yield fund shares are collateral for USDG (default: the market the lending vault supplies; `marketId` for another): LLTV, the collateral oracle's price and state (live | held | unavailable), borrow rate, utilization, supplied / borrowed / available; and your position: collateral shares and their value, debt (interest accrued to now), max borrow at the LLTV, what you can still borrow (and what keeps LTV <= 70% of LLTV), health factor, LTV, the share price at which you would be liquidated, wallet fund shares and USDG. Read-only. " +
        LENDING_NOTE,
      inputSchema: { marketId: marketIdField },
    },
    async ({ marketId }) => {
      try {
        const s = await ctx.lending("none").borrowStatus(ctx.account, marketId);
        return json({ chainId: ctx.chainId, account: ctx.account, ...borrowView(s), note: LENDING_NOTE });
      } catch (e) {
        return fail(`borrow_status failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "borrow_supply_collateral",
    {
      title: "Pledge fund shares as collateral (owner key)",
      description:
        "Moves Stock Yield fund shares (hhNVDA-CC) from the owner wallet into the Blue market as collateral for your account: ERC-20 approve to Blue when short, then supplyCollateral(market, shares, account). The shares must already be in the wallet: shares the fund owes you are claimed first with vault_claim; pledged shares keep earning the fund's premium (NAV) but cannot be redeemed from the fund until withdrawn from Blue. Nothing is borrowed yet; works even while the oracle is unavailable. Owner key. dryRun (default true) simulates only. Requires confirm: true. " +
        LENDING_NOTE,
      inputSchema: { shares: sharesOrAll.describe("Fund shares to pledge, e.g. \"10\", or \"all\" (the wallet balance)"), marketId: marketIdField, confirm: confirmField, dryRun: dryRunField },
    },
    async ({ shares, marketId, confirm, dryRun }) => {
      try {
        requireOwner(ctx);
        const plan = await ctx.lending("owner").planSupplyCollateral({ shares, marketId });
        return sendLendingPlanOrExplain(ctx, plan, confirm, dryRun);
      } catch (e) {
        return fail(`borrow_supply_collateral failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "borrow_take",
    {
      title: "Borrow USDG against fund shares (owner key)",
      description:
        `Borrows USDG from the Blue market against your pledged fund shares: borrow(market, usdg, account, receiver). Refused when the collateral oracle has no usable price, when the market lacks liquidity, or when the health factor after the loan would be below 1; WARNS when the LTV after would exceed ${LTV_WARN_FRACTION * 100}% of the LLTV (the oracle is re-marked weekly; a stock drop or a wide mark can liquidate a tight position). Interest accrues per second at the market's rate. Owner key. dryRun (default true) simulates only. Requires confirm: true. ` +
        LENDING_NOTE,
      inputSchema: { usdg: decimalAmount.describe("USDG to borrow, e.g. \"500\""), receiver: address.optional().describe("Recipient of the USDG; default: the owner address"), marketId: marketIdField, confirm: confirmField, dryRun: dryRunField },
    },
    async ({ usdg, receiver, marketId, confirm, dryRun }) => {
      try {
        requireOwner(ctx);
        const plan = await ctx.lending("owner").planBorrow({ usdgRaw: parseUsdg(usdg), receiver, marketId });
        return sendLendingPlanOrExplain(ctx, plan, confirm, dryRun);
      } catch (e) {
        return fail(`borrow_take failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "borrow_repay",
    {
      title: "Repay USDG debt (owner key)",
      description:
        "Repays your USDG debt on the Blue market from the owner wallet: ERC-20 approve to Blue when short, then repay by assets for an amount or by borrow shares for \"all\" (so the debt that keeps accruing until the block is cleared exactly; the approval carries a small margin). Works while the oracle is unavailable. Owner key. dryRun (default true) simulates only. Requires confirm: true.",
      inputSchema: { usdg: usdgOrAll.describe("USDG to repay, e.g. \"100\", or \"all\""), marketId: marketIdField, confirm: confirmField, dryRun: dryRunField },
    },
    async ({ usdg, marketId, confirm, dryRun }) => {
      try {
        requireOwner(ctx);
        const plan = await ctx.lending("owner").planRepay({ usdg, marketId });
        return sendLendingPlanOrExplain(ctx, plan, confirm, dryRun);
      } catch (e) {
        return fail(`borrow_repay failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "borrow_withdraw_collateral",
    {
      title: "Withdraw collateral shares (owner key)",
      description:
        "Takes pledged fund shares back out of the Blue market to the owner wallet: withdrawCollateral(market, shares, account, receiver). With debt open the health factor after must stay at or above 1 (and the oracle must answer); \"all\" requires the debt to be repaid first. Afterwards the shares can be redeemed from the fund again (vault_redeem). Owner key. dryRun (default true) simulates only. Requires confirm: true.",
      inputSchema: { shares: sharesOrAll.describe("Collateral shares to withdraw, e.g. \"5\", or \"all\""), receiver: address.optional().describe("Recipient; default: the owner address"), marketId: marketIdField, confirm: confirmField, dryRun: dryRunField },
    },
    async ({ shares, receiver, marketId, confirm, dryRun }) => {
      try {
        requireOwner(ctx);
        const plan = await ctx.lending("owner").planWithdrawCollateral({ shares, receiver, marketId });
        return sendLendingPlanOrExplain(ctx, plan, confirm, dryRun);
      } catch (e) {
        return fail(`borrow_withdraw_collateral failed: ${errorText(e)}`);
      }
    },
  );
}

export type { QuoteResponse };
