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
  formatStrike,
  formatUsdg,
  identityRegistryFor,
  orderDigest,
  orderFromJson,
  orderToJson,
  parseShares,
  parseUsdg,
  SCOPE_CANCEL,
  SCOPE_TRADE,
  type QuoteResponse,
  type TxRequest,
  type VerifiedQuote,
} from "@hedgehood-io/sdk";
import type { Address, Hex } from "viem";
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

function instrumentFrom(args: { instrumentId?: string; expiry?: string; strike?: string; kind?: "call" | "put" }): bigint {
  if (args.instrumentId) return BigInt(args.instrumentId);
  if (args.expiry && args.strike && args.kind) return encodeInstrumentId(BigInt(args.expiry), parseUsdg(args.strike), args.kind === "put");
  throw new Error("give instrumentId, or expiry + strike + kind");
}

async function sendOrExplain(ctx: KitContext, who: "session" | "owner", tx: TxRequest, confirm: boolean, dryRun: boolean | undefined) {
  const dry = dryRun ?? ctx.config.dryRunDefault;
  if (!confirm) {
    return json({ ok: false, needsConfirm: true, wouldSend: tx.summary, to: tx.to, data: tx.data, dryRun: dry, hint: "call again with confirm: true" });
  }
  const signer = who === "owner" ? requireOwner(ctx) : requireSession(ctx);
  const m = ctx.market(who);
  try {
    const r = await m.send(tx, { dryRun: dry });
    if (r.dryRun) return json({ ok: true, dryRun: true, simulated: true, from: signer.address, to: tx.to, data: tx.data, summary: tx.summary, hint: "simulation passed; call again with dryRun: false to broadcast" });
    const receipt = await m.waitForReceipt(r.hash!);
    return json({ ok: receipt.status === "success", dryRun: false, txHash: r.hash, blockNumber: receipt.blockNumber, status: receipt.status, from: signer.address, summary: tx.summary, explorer: `${m.chain.blockExplorers?.default.url}/tx/${r.hash}` });
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
    digest: orderDigest(q.order),
    instrument: describeInstrument(q.order.instrumentId, underlying),
    instrumentId: q.order.instrumentId.toString(),
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
    maker: q.order.maker,
    quoteId: q.quoteId,
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
        backend = await ctx.rfq.markets();
      } catch (e) {
        backend = { unavailable: errorText(e) };
      }
      return json({
        chainId: ctx.chainId,
        account: ctx.account,
        underlying,
        market: m.market,
        orderBook: m.orderBook,
        settlementToken: m.usdg,
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
        let marks: Record<string, string> = {};
        try {
          const list = await ctx.rfq.instruments(m.market, e);
          marks = Object.fromEntries(list.filter((x) => x.markRaw).map((x) => [x.instrumentId, formatUsdg(BigInt(x.markRaw!))]));
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
            return { instrumentId: id.toString(), label: describeInstrument(id, underlying), strike: formatStrike(s), kind: k, mark: marks[id.toString()] };
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
      description: "Indicative mark (and bid/ask when streamed) of one instrument from the backend; not executable. Use get_quote for a firm price.",
      inputSchema: { instrumentId: uintString.optional(), expiry: uintString.optional(), strike: decimalAmount.optional(), kind: z.enum(["call", "put"]).optional() },
    },
    async (args) => {
      const id = instrumentFrom(args);
      const mark = await ctx.rfq.mark(ctx.deployment.market, id);
      return json({ instrument: describeInstrument(id, underlying), instrumentId: id, mark: formatUsdg(BigInt(mark.markRaw)), bid: mark.bidRaw ? formatUsdg(BigInt(mark.bidRaw)) : undefined, ask: mark.askRaw ? formatUsdg(BigInt(mark.askRaw)) : undefined, spot: mark.spotRaw ? formatUsdg(BigInt(mark.spotRaw)) : undefined, iv: mark.iv, observedAt: mark.observedAt });
    },
  );

  server.registerTool(
    "get_quote",
    {
      title: "Get firm quote (RFQ)",
      description: "Asks the maker for a firm, signed quote addressed to your account, verifies the signature, taker and expiry locally, and returns price, fee, time left and a digest to pass to fill_quote. Quotes decay and expire in seconds. Read-only (nothing is sent).",
      inputSchema: {
        instrumentId: uintString.optional().describe("From list_instruments"),
        expiry: uintString.optional(),
        strike: decimalAmount.optional().describe("USDG per share, e.g. \"220\""),
        kind: z.enum(["call", "put"]).optional(),
        side: z.enum(["buy", "sell"]).describe("buy = you buy the option (pay premium); sell = you write it (receive premium, post collateral)"),
        quantity: decimalAmount.describe("Shares, e.g. \"1\" or \"0.5\""),
        ttlSeconds: z.number().int().min(5).max(300).optional(),
      },
    },
    async (args) => {
      const id = instrumentFrom(args);
      const quantityRaw = parseShares(args.quantity);
      const m = ctx.market("none");
      const fee = await m.protocolFeeBps();
      const q = await ctx.rfq.getQuote({ chainId: ctx.chainId, market: m.market, instrumentId: id, side: args.side, quantityRaw, taker: ctx.account, ttlSeconds: args.ttlSeconds }, { orderBook: m.orderBook, protocolFeeBps: fee });
      const digest = orderDigest(q.order);
      ctx.quotes.set(digest, { quote: q, fetchedAt: Date.now(), side: args.side, requestedQuantityRaw: quantityRaw });
      const view = quoteView(q, underlying, args.side, quantityRaw);
      let requirementAfter: string | undefined;
      try {
        requirementAfter = formatUsdg(await m.requirementIfTraded(id, args.side === "buy" ? quantityRaw : -quantityRaw));
      } catch {
        /* optional */
      }
      return json({ ...view, requirementAfter, order: orderToJson(q.order), signature: q.signature, next: "fill_quote with this digest and confirm: true (dryRun first)" });
    },
  );

  server.registerTool(
    "fill_quote",
    {
      title: "Fill a quote",
      description: "Takes a quote from get_quote for your account via fillOrderAs from the session key, in balance mode (premium, fee and collateral settle from your deposited USDG; no approvals). dryRun (default true) simulates only. Requires confirm: true. Reports the tx hash when sent.",
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
        const r = await depositViaGateway({ account: ctx.account, market: ctx.deployment.market, amountRaw }, { signer: payer, chainId: ctx.chainId, apiUrl: ctx.config.apiUrl, fetch: ctx.fetch, dryRun: dry, maxAmountRaw: cap });
        return json({ ok: true, dryRun: r.dryRun, payer: payer.address, account: ctx.account, requirement: r.requirement, settlement: r.settlement, depositTxHash: r.depositTxHash, body: r.body, hint: r.dryRun ? "402 looks right; call again with dryRun: false to pay" : undefined });
      } catch (e) {
        return fail(`deposit failed: ${errorText(e)}`);
      }
    },
  );

  server.registerTool(
    "positions",
    {
      title: "Positions and balances",
      description: "Your market balance (collateral, locked requirement, free), wallet USDG, every open position by instrument, and the session's authority. Read-only.",
      inputSchema: {},
    },
    async () => {
      const m = ctx.market("none");
      const snap = await m.snapshot(ctx.account);
      const settledPending: string[] = [];
      for (const e of snap.expiries) {
        const info = await m.expiryInfo(e);
        if (info.settled) settledPending.push(e.toString());
      }
      const session = ctx.session ? await m.session(ctx.session.address, ctx.account) : undefined;
      return json({
        account: ctx.account,
        collateral: formatUsdg(snap.collateralRaw),
        requirement: formatUsdg(snap.requirementRaw),
        freeCollateral: formatUsdg(snap.freeCollateralRaw),
        walletUsdg: formatUsdg(snap.walletUsdgRaw),
        positions: snap.positions.map((p) => ({ instrumentId: p.instrumentId, label: describeInstrument(p.instrumentId, underlying), quantity: formatShares(p.quantityRaw), side: p.quantityRaw > 0n ? "long" : "short" })),
        expiries: snap.expiries,
        settledAwaitingRedeem: settledPending,
        session: session ? { key: session.key, active: session.active, canTrade: session.canTrade, canCancel: session.canCancel, expiresAt: session.expiresAt, maxRequirement: session.maxRequirement === 0n ? "unlimited" : formatUsdg(session.maxRequirement) } : "no session key configured",
      });
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
    { title: "Leaderboard", description: "Agent leaderboard from the indexer (PnL, volume, fills). Read-only.", inputSchema: { period: z.enum(["7d", "30d", "all"]).default("30d"), limit: z.number().int().min(1).max(100).default(25) } },
    async ({ period, limit }) => json(await ctx.rfq.leaderboard(period, limit)),
  );

  server.registerTool(
    "my_record",
    { title: "My record", description: "Your account's indexed record: PnL, volume, fills, rank, recent trades. Read-only.", inputSchema: {} },
    async () => json(await ctx.rfq.agent(ctx.account)),
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
