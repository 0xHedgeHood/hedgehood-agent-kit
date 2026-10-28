import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildRegistrationFile,
  dataUri,
  decodeInstrumentId,
  depositViaGateway,
  describeInstrument,
  encodeInstrumentId,
  encodeRegisterAgent,
  formatShares,
  formatSignedUsdg,
  formatStrike,
  formatUsdg,
  identityRegistryFor,
  instrumentName,
  orderDigest,
  resolveInstrumentName,
  orderFromJson,
  orderToJson,
  parseShares,
  parseUsdg,
  planClose,
  pnlByInstrument,
  positionPnl,
  SCOPE_CANCEL,
  SCOPE_TRADE,
  type ClosePlan,
  type QuoteResponse,
  type TxRequest,
  type VerifiedQuote,
} from "@hedgehood-io/sdk";
import type { Address, Hex } from "viem";
import type { MarketClient } from "@hedgehood-io/sdk";
import { z } from "zod";
import { requireOwner, requireSession, type KitContext } from "./context.js";
import { describeConfig } from "./config.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "address").transform((s) => s as Address);
const uintString = z.string().regex(/^\d+$/, "unsigned integer string");
const decimalAmount = z.string().regex(/^\d+(\.\d+)?$/, "decimal amount, e.g. \"25\" or \"0.5\"");

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
  strike: decimalAmount.optional().describe("USDG per share, e.g. \"220\""),
  kind: z.enum(["call", "put"]).optional(),
};

/** An instrument from a backend name, a packed id, or expiry + strike + kind. */
async function instrumentFrom(m: MarketClient, args: { instrument?: string; instrumentId?: string; expiry?: string; strike?: string; kind?: "call" | "put" }): Promise<bigint> {
  if (args.instrumentId) return BigInt(args.instrumentId);
  if (args.instrument) return resolveInstrumentName(args.instrument, await m.openedExpiries());
  if (args.expiry && args.strike && args.kind) return encodeInstrumentId(BigInt(args.expiry), parseUsdg(args.strike), args.kind === "put");
  throw new Error("give instrument (NVDA-20261030-220-C), or instrumentId, or expiry + strike + kind");
}

/** `extra` is merged into every JSON answer (what a close or fill was priced at), never into an error. */
async function sendOrExplain(ctx: KitContext, who: "session" | "owner", tx: TxRequest, confirm: boolean, dryRun: boolean | undefined, extra: Record<string, unknown> = {}) {
  const dry = dryRun ?? ctx.config.dryRunDefault;
  if (!confirm) {
    return json({ ...extra, ok: false, needsConfirm: true, wouldSend: tx.summary, to: tx.to, data: tx.data, dryRun: dry, hint: "call again with confirm: true" });
  }
  const signer = who === "owner" ? requireOwner(ctx) : requireSession(ctx);
  const m = ctx.market(who);
  try {
    const r = await m.send(tx, { dryRun: dry });
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

function quoteView(q: VerifiedQuote, underlying: string, side: "buy" | "sell", requestedQuantityRaw: bigint) {
  return {
    digest: q.digest,
    instrument: q.instrument,
    label: describeInstrument(q.order.instrumentId, underlying),
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
    label: describeInstrument(plan.instrumentId, underlying),
    instrumentId: plan.instrumentId.toString(),
    position: formatShares(plan.position.quantityRaw),
    closes: formatShares(plan.quantityRaw),
    remainingAfter: formatShares(plan.remainingRaw),
    side: plan.side,
    quote: quoteView(plan.quote, underlying, plan.side, plan.quantityRaw),
  };
}

export function createServer(ctx: KitContext): McpServer {
  const server = new McpServer({ name: "hedgehood-options", version: "0.1.0" });
  const underlying = ctx.deployment.underlying;

  server.registerTool(
    "list_markets",
    {
      title: "List markets",
      description: "The option markets this server trades: underlying, chain, contract addresses, open expiries and taker fee. Read-only.",
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
        expiries: infos.map((i) => ({ expiry: i.expiry, date: new Date(Number(i.expiry) * 1000).toISOString(), tradingOpen: i.tradingOpen, settled: i.settled, anchor: formatUsdg(i.anchor), capLow: formatUsdg(i.capLow), capHigh: formatUsdg(i.capHigh), strikes: i.strikes.map(formatStrike) })),
        backend,
        config: describeConfig(ctx.config),
      });
    },
  );

  server.registerTool(
    "list_instruments",
    {
      title: "List instruments",
      description: "Calls and puts of one expiry (or all open expiries): instrument ids, strikes, whether trading is open, and the backend's indicative marks when available. Read-only.",
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
          settlementPrice: info.settled ? formatUsdg(info.settlementPrice) : undefined,
          instruments: info.strikes.flatMap((s) => (["call", "put"] as const).map((k) => {
            const id = encodeInstrumentId(e, s, k === "put");
            return { instrument: instrumentName(underlying, e, s, k === "put"), instrumentId: id.toString(), label: describeInstrument(id, underlying), strike: formatStrike(s), kind: k, listedOcc: listed[id.toString()]?.occ, quotedByBackend: id.toString() in listed };
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
      const id = await instrumentFrom(ctx.market("none"), args);
      const mark = await ctx.rfq.mark({ instrumentId: id, underlying });
      return json({ ...mark, label: describeInstrument(id, underlying), note: mark.executable ? undefined : `not executable now (${mark.reason ?? "no row"}): no quote will be given; try during the listed session` });
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
      const q = await ctx.rfq.getQuote({ chainId: ctx.chainId, market: m.market, instrumentId: id, side: args.side, quantityRaw, taker: ctx.account, sessionKey, underlying }, { orderBook: m.orderBook, protocolFeeBps: fee });
      const digest = q.digest;
      ctx.quotes.set(digest, { quote: q, fetchedAt: Date.now(), side: args.side, requestedQuantityRaw: quantityRaw });
      const view = quoteView(q, underlying, args.side, quantityRaw);
      let requirementAfter: string | undefined;
      try {
        requirementAfter = formatUsdg(await m.requirementIfTraded(id, args.side === "buy" ? quantityRaw : -quantityRaw));
      } catch {
        /* optional */
      }
      return json({ ...view, requirementAfter, order: orderToJson(q.order), signature: q.signature, next: q.fillable ? "fill_quote with this digest and confirm: true (dryRun first)" : "not fillable (backend dry run); nothing to send" });
    },
  );

  server.registerTool(
    "fill_quote",
    {
      title: "Fill a quote",
      description: "Takes a quote from get_quote for your account via fillOrderAs from the session key, in balance mode (premium, fee and collateral settle from your deposited USDG; no approvals). Opens or adds to a position; to exit an existing position before expiry use close_position instead. dryRun (default true) simulates only. Requires confirm: true. Reports the tx hash when sent.",
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
      return sendOrExplain(ctx, "session", tx, args.confirm, args.dryRun);
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
      description: "Your ACTIVE book: market balance (collateral, locked requirement, free), wallet USDG, every open position by instrument with average entry price, the desk's mark, unrealized P&L and time to expiry (when the indexer answers), plus the session's authority. Past activity is get_history; totals are get_pnl; to exit a position before expiry call close_position. Read-only.",
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
          return { instrumentId: p.instrumentId, instrument: f.instrument, label: describeInstrument(p.instrumentId, underlying), quantity: formatShares(p.quantityRaw), side: p.quantityRaw > 0n ? "long" : "short", avgPrice: f.avgPrice, mark: f.mark, markBid: f.markBid, markAsk: f.markAsk, unrealized: f.unrealized, expiry: p.expiry, expiresIn: f.expiresIn, secondsToExpiry: f.secondsToExpiry, closeWith: `close_position { instrument: "${f.instrument}" }` };
        }),
        pnl: pnl ? { asOf: pnl.asOf, realized: formatSignedUsdg(pnl.realizedRaw), unrealized: formatSignedUsdg(pnl.unrealizedRaw), feesPaid: formatUsdg(BigInt(pnl.feesPaidRaw)), total: formatSignedUsdg(pnl.totalRaw), note: pnl.note } : "indexer unavailable: no marks or P&L",
        expiries: snap.expiries,
        settledAwaitingRedeem: settledPending,
        session: session ? { key: session.key, active: session.active, canTrade: session.canTrade, canCancel: session.canCancel, expiresAt: session.expiresAt, maxRequirement: session.maxRequirement === 0n ? "unlimited" : formatUsdg(session.maxRequirement) } : "no session key configured",
      });
    },
  );

  server.registerTool(
    "close_position",
    {
      title: "Close a position (before expiry)",
      description: "Exits an open position before expiry. Positions net out on chain and the maker quotes both sides, so this reads your signed position in the instrument, asks for a firm quote on the OPPOSITE side (a long is sold to the bid, a short is bought back at the ask) for min(|position|, quantity), verifies it and fills it via fillOrderAs from the session key in balance mode, exactly like fill_quote. Without confirm it only prices the close. dryRun (default true) simulates only; dryRun: false broadcasts and reports the tx hash. Requires confirm: true.",
      inputSchema: {
        ...instrumentFields,
        quantity: decimalAmount.optional().describe("Shares to close; default and maximum: the whole position"),
        fromBalance: z.boolean().default(true).describe("Settle inside the deposited balance (default); false pays/receives from the session key's wallet"),
        confirm: confirmField,
        dryRun: dryRunField,
      },
    },
    async (args) => {
      const m = ctx.market("session");
      let plan: ClosePlan;
      try {
        const instrumentId = await instrumentFrom(m, args);
        const sessionKey = ctx.session && ctx.session.address.toLowerCase() !== ctx.account.toLowerCase() ? ctx.session.address : undefined;
        plan = await planClose({ market: m, rfq: ctx.rfq, instrumentId, quantityRaw: args.quantity ? parseShares(args.quantity) : undefined, fromBalance: args.fromBalance, sessionKey, protocolFeeBps: await m.protocolFeeBps() });
      } catch (e) {
        return fail(`close failed: ${errorText(e)}`);
      }
      ctx.quotes.set(plan.quote.digest, { quote: plan.quote, fetchedAt: Date.now(), side: plan.side, requestedQuantityRaw: plan.quantityRaw });
      const view = closeView(plan, underlying);
      if (!plan.quote.fillable) return json({ ...view, ok: false, fillable: false, note: "the desk runs without a signer key: this quote carries a placeholder signature and cannot be filled; nothing to send" });
      if (plan.quote.canFill === false) view.quote.fundingPreview = { ...view.quote.fundingPreview, note: `maker predicts canFill=false${plan.quote.shortfallRaw > 0n ? ` (shortfall ${formatUsdg(plan.quote.shortfallRaw)} USDG)` : ""}` };
      return sendOrExplain(ctx, "session", plan.request, args.confirm, args.dryRun, view);
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
      description: "authorizeSession(key, expiresAt, scope, maxRequirement) from the owner: lets the session key trade for the account (never withdraw). Set maxRequirement to cap the collateral a session may lock. Also used to rotate or extend. dryRun default true. Requires confirm: true.",
      inputSchema: {
        key: address.optional().describe("Session key address; default: the configured session key"),
        days: z.number().int().min(1).max(365).default(30),
        maxRequirement: decimalAmount.optional().describe("USDG cap on total requirement; omit or \"0\" for unlimited"),
        cancel: z.boolean().default(true).describe("Also grant SCOPE_CANCEL"),
        revoke: z.boolean().default(false).describe("true: revokeSession(key) instead"),
        confirm: confirmField,
        dryRun: dryRunField,
      },
    },
    async ({ key, days, maxRequirement, cancel, revoke, confirm, dryRun }) => {
      requireOwner(ctx);
      const k = key ?? ctx.session?.address;
      if (!k) return fail("no session key to authorize: pass key or set HEDGEHOOD_SESSION_KEY_FILE");
      const m = ctx.market("owner");
      if (revoke) return sendOrExplain(ctx, "owner", m.revokeSession(k), confirm, dryRun);
      const expiresAt = Math.floor(Date.now() / 1000) + days * 86400;
      const scope = SCOPE_TRADE | (cancel ? SCOPE_CANCEL : 0n);
      void scope;
      return sendOrExplain(ctx, "owner", m.authorizeSession(k, expiresAt, { trade: true, cancel, maxRequirement: maxRequirement ? parseUsdg(maxRequirement) : 0n }), confirm, dryRun);
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
    "register_agent",
    {
      title: "Register agent identity (ERC-8004, optional)",
      description: "Registers an ERC-8004 agent id for the owner on the Identity Registry (mainnet 4663 only) with a registration file naming this trading account. Optional; the market does not require it. Owner key. dryRun default true. Requires confirm: true.",
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
    { title: "Decode instrument id", description: "Expiry, strike and kind of an instrument id. Pure.", inputSchema: { instrumentId: uintString } },
    async ({ instrumentId }) => {
      const d = decodeInstrumentId(BigInt(instrumentId));
      return json({ ...d, strike: formatStrike(d.strike), date: new Date(Number(d.expiry) * 1000).toISOString(), label: describeInstrument(BigInt(instrumentId), underlying) });
    },
  );

  return server;
}

export type { QuoteResponse };
