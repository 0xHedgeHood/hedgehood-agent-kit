import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Command, Option } from "commander";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  buildRegistrationFile,
  dataUri,
  decodeInstrumentId,
  depositViaGateway,
  describeInstrument,
  encodeInstrumentId,
  instrumentName,
  resolveInstrumentName,
  encodeRegisterAgent,
  formatShares,
  formatSignedUsdg,
  formatStrike,
  formatUsdg,
  orderDigest,
  orderFromJson,
  orderToJson,
  parseShares,
  parseUsdg,
  planClose,
  pnlByInstrument,
  positionPnl,
  type ClosePlan,
  type HistoryEvent,
  type PnlView,
  type TxRequest,
  type VerifiedQuote,
} from "@hedgehood-io/sdk";
import { createContext, loadConfig, requireOwner, requireSession, type KitContext } from "@hedgehood-io/mcp";

const DEFAULT_SESSION_KEY_FILE = "~/.hedgehood/session.key";

function expand(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

interface GlobalOpts {
  chain: string;
  testnet?: boolean;
  mainnet?: boolean;
  rpc?: string;
  rfqUrl?: string;
  indexerUrl?: string;
  gatewayUrl?: string;
  account?: string;
  underlying?: string;
  sessionKeyFile?: string;
  ownerKeyFile?: string;
  json?: boolean;
}

function envFrom(o: GlobalOpts): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (o.chain) env.HEDGEHOOD_CHAIN_ID = o.chain;
  if (o.testnet) env.HEDGEHOOD_CHAIN_ID = "46630";
  if (o.mainnet) env.HEDGEHOOD_CHAIN_ID = "4663";
  if (o.rpc) env.HEDGEHOOD_RPC_URL = o.rpc;
  if (o.rfqUrl) env.HEDGEHOOD_RFQ_URL = o.rfqUrl;
  if (o.indexerUrl) env.HEDGEHOOD_INDEXER_URL = o.indexerUrl;
  if (o.gatewayUrl) env.HEDGEHOOD_GATEWAY_URL = o.gatewayUrl;
  if (o.account) env.HEDGEHOOD_ACCOUNT = o.account;
  if (o.underlying) env.HEDGEHOOD_UNDERLYING = o.underlying;
  if (o.sessionKeyFile) env.HEDGEHOOD_SESSION_KEY_FILE = o.sessionKeyFile;
  else if (!env.HEDGEHOOD_SESSION_KEY_FILE && !env.HEDGEHOOD_SESSION_KEY && existsSync(expand(DEFAULT_SESSION_KEY_FILE))) env.HEDGEHOOD_SESSION_KEY_FILE = DEFAULT_SESSION_KEY_FILE;
  if (o.ownerKeyFile) env.HEDGEHOOD_OWNER_KEY_FILE = o.ownerKeyFile;
  return env;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** `readOnly` commands (markets, instruments) work without any key or account. */
function ctxFrom(cmd: Command, readOnly = false): KitContext {
  const o = cmd.optsWithGlobals() as GlobalOpts;
  const env = envFrom(o);
  if (readOnly && !env.HEDGEHOOD_ACCOUNT && !env.HEDGEHOOD_SESSION_KEY_FILE && !env.HEDGEHOOD_SESSION_KEY && !env.HEDGEHOOD_OWNER_KEY_FILE && !env.HEDGEHOOD_OWNER_KEY) env.HEDGEHOOD_ACCOUNT = ZERO;
  return createContext(loadConfig(env));
}

const sessionKeyOf = (ctx: KitContext) => (ctx.session && ctx.session.address.toLowerCase() !== ctx.account.toLowerCase() ? ctx.session.address : undefined);

const out = (cmd: Command, v: unknown, human?: string) => {
  const o = cmd.optsWithGlobals() as GlobalOpts;
  if (o.json || human === undefined) process.stdout.write(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n");
  else process.stdout.write(human + "\n");
};

/** Simulates, then (with `--send`) broadcasts and waits; returns what to print instead of printing it. */
async function sendResult(ctx: KitContext, who: "session" | "owner", tx: TxRequest, sendFlag: boolean | undefined): Promise<{ json: Record<string, unknown>; human: string; failed: boolean }> {
  const dryRun = !sendFlag;
  if (who === "owner") requireOwner(ctx);
  else requireSession(ctx);
  const m = ctx.market(who);
  const r = await m.send(tx, { dryRun });
  if (r.dryRun) {
    return { json: { dryRun: true, from: r.from, to: tx.to, data: tx.data, summary: tx.summary }, human: `DRY RUN (simulation passed): ${tx.summary}\n  from ${r.from}\n  to   ${tx.to}\n  add --send to broadcast`, failed: false };
  }
  const receipt = await m.waitForReceipt(r.hash!);
  return {
    json: { txHash: r.hash, status: receipt.status, blockNumber: receipt.blockNumber, summary: tx.summary },
    human: `${receipt.status === "success" ? "OK" : "REVERTED"} ${tx.summary}\n  tx ${r.hash}\n  ${m.chain.blockExplorers?.default.url}/tx/${r.hash}`,
    failed: receipt.status !== "success",
  };
}

async function send(cmd: Command, ctx: KitContext, who: "session" | "owner", tx: TxRequest, sendFlag: boolean | undefined) {
  const r = await sendResult(ctx, who, tx, sendFlag);
  out(cmd, r.json, r.human);
  if (r.failed) process.exitCode = 1;
}

/** Fixed-width text table; numeric-looking cells are right-aligned. */
function table(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const numeric = /^[+-]?\d/;
  return all.map((r) => r.map((c, i) => (numeric.test(c) && i > 0 ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

/** `--since`: ISO-8601 date/time or unix seconds (milliseconds accepted) -> unix seconds. */
export function parseSince(v: string): number {
  const t = v.trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n > 1e11 ? Math.floor(n / 1000) : n;
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new RangeError(`--since must be an ISO date/time or unix seconds, got ${v}`);
  return Math.floor(ms / 1000);
}

const usdgOf = (raw: string | null | undefined) => (raw == null ? "-" : formatSignedUsdg(raw)!);
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function pnlHuman(p: PnlView): string {
  const rows = p.positions.map((x) => [x.instrument, formatShares(BigInt(x.quantityRaw)), x.avgPriceRaw == null ? "-" : formatUsdg(BigInt(x.avgPriceRaw)), x.markMid == null ? "-" : String(x.markMid), x.settlementRaw != null ? `settled ${usdgOf(x.settlementRaw)}` : usdgOf(x.unrealizedRaw)]);
  return [
    `account ${p.account}  as of ${iso(p.asOf)}`,
    rows.length ? table(["instrument", "qty", "avg", "mark", "unrealized"], rows) : "  no open positions",
    `realized ${usdgOf(p.realizedRaw)}  unrealized ${usdgOf(p.unrealizedRaw)}  fees ${formatUsdg(BigInt(p.feesPaidRaw))}  total ${usdgOf(p.totalRaw)}${p.note ? `\n  (${p.note})` : ""}`,
  ].join("\n");
}

function historyLine(e: HistoryEvent): string {
  switch (e.type) {
    case "fill":
      return `${iso(e.at)}  fill        ${e.side.padEnd(4)} ${formatShares(BigInt(e.quantityRaw))} ${e.instrument} @ ${formatUsdg(BigInt(e.priceRaw))}  premium ${formatUsdg(BigInt(e.premiumRaw))}  fee ${formatUsdg(BigInt(e.feeRaw))}  tx ${e.txHash}`;
    case "settlement":
      return `${iso(e.at)}  settlement  ${e.instrument} @ ${e.settlementPrice}  payout ${usdgOf(e.payoutRaw)}`;
    case "redeem":
      return `${iso(e.at)}  redeem      expiry ${e.expiry}  ${usdgOf(e.amountRaw)}  tx ${e.txHash}`;
    default:
      return JSON.stringify(e);
  }
}

function closePlanHuman(plan: ClosePlan, underlying: string): string {
  const q = plan.quote;
  return [
    `close ${plan.instrument}: position ${plan.position.quantityRaw > 0n ? "+" : ""}${formatShares(plan.position.quantityRaw)} -> ${plan.side} ${formatShares(plan.quantityRaw)} (remaining ${plan.remainingRaw > 0n ? "+" : ""}${formatShares(plan.remainingRaw)})`,
    quoteHuman(q, underlying, plan.quantityRaw),
  ].join("\n");
}

function closePlanJson(plan: ClosePlan) {
  const q = plan.quote;
  return { instrument: plan.instrument, instrumentId: plan.instrumentId, positionRaw: plan.position.quantityRaw, side: plan.side, quantityRaw: plan.quantityRaw, remainingRaw: plan.remainingRaw, digest: q.digest, pricePerShareRaw: q.pricePerShareRaw, premiumNowRaw: q.premiumNowRaw, feeNowRaw: q.feeNowRaw, netNowRaw: q.netNowRaw, canFill: q.canFill, shortfallRaw: q.shortfallRaw, secondsLeft: q.secondsLeft, fillable: q.fillable, backendDryRun: q.dryRun };
}

/** "<instrumentId>", "NVDA-20261030-220-C" (backend name) or "<expiry>:<strike>:<call|put>". */
async function instrumentArg(ctx: KitContext, v: string): Promise<bigint> {
  if (/^\d+$/.test(v)) return BigInt(v);
  const m = /^(\d+):(\d+(?:\.\d+)?):(call|put|c|p)$/i.exec(v);
  if (m) return encodeInstrumentId(BigInt(m[1]!), parseUsdg(m[2]!), /^p/i.test(m[3]!));
  return resolveInstrumentName(v, await ctx.market("none").openedExpiries());
}

function quoteHuman(q: VerifiedQuote, underlying: string, qty: bigint): string {
  const pays = q.netNowRaw > 0n;
  return [
    `${q.instrument}  (${describeInstrument(q.order.instrumentId, underlying)})  qty ${formatShares(qty)}${q.dryRun ? "  [BACKEND DRY RUN: placeholder signature, not fillable]" : ""}`,
    `  price/share ${formatUsdg(q.pricePerShareRaw)}  premium ${formatUsdg(q.premiumNowRaw)}  fee ${formatUsdg(q.feeNowRaw)}  ${pays ? "you pay" : "you receive"} ${formatUsdg(pays ? q.netNowRaw : -q.netNowRaw)}`,
    `  valid ${q.secondsLeft}s (until ${q.order.validUntil})  canFill ${q.canFill ?? "unknown"}${q.shortfallRaw > 0n ? `  shortfall ${formatUsdg(q.shortfallRaw)}` : ""}${q.funding.note ? `  (${q.funding.note})` : ""}`,
    `  digest ${q.digest}  maker ${q.order.maker}  mark mid ${q.markPrice}`,
  ].join("\n");
}

export function buildProgram(): Command {
  const program = new Command("hedgehood")
    .description("Hedgehood AI-agent options market on Robinhood Chain. Sends are DRY RUN unless --send is given.")
    .version("0.2.0")
    .option("--chain <id>", "46630 (testnet, default) or 4663", process.env.HEDGEHOOD_CHAIN_ID ?? "46630")
    .option("--testnet", "use the Robinhood testnet (46630) deployment (default)")
    .option("--mainnet", "use Robinhood Chain mainnet (4663); no V2 market yet")
    .option("--rpc <url>", "RPC URL override")
    .option("--rfq-url <url>", "quote service override (default https://agent-api.hedgehood.io)")
    .option("--indexer-url <url>", "indexer override (default https://agent-index.hedgehood.io)")
    .option("--gateway-url <url>", "x402 deposit gateway override (default https://agent-pay.hedgehood.io)")
    .option("--account <address>", "trading account (owner) the session key acts for")
    .option("--underlying <ticker>", "NVDA")
    .option("--session-key-file <path>", `session key file (default ${DEFAULT_SESSION_KEY_FILE} when present)`)
    .option("--owner-key-file <path>", "owner key file, only for deposit/withdraw/session/join")
    .option("--json", "machine-readable output");

  program
    .command("join")
    .description("Create a session key (if none), show the addresses, and (with an owner key) authorize it on the market")
    .option("--days <n>", "session validity in days", "30")
    .option("--max-requirement <usdg>", "cap on collateral the session may lock (0 = unlimited)", "0")
    .option("--send", "broadcast instead of dry run")
    .action(async (opts: { days: string; maxRequirement: string; send?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as GlobalOpts;
      const file = expand(g.sessionKeyFile ?? process.env.HEDGEHOOD_SESSION_KEY_FILE ?? DEFAULT_SESSION_KEY_FILE);
      let created = false;
      if (!existsSync(file) && !process.env.HEDGEHOOD_SESSION_KEY) {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, generatePrivateKey() + "\n", { mode: 0o600 });
        chmodSync(file, 0o600);
        created = true;
      }
      if (!g.sessionKeyFile && !process.env.HEDGEHOOD_SESSION_KEY) g.sessionKeyFile = file;
      const ctx = createContext(loadConfig(envFrom(g)));
      const session = ctx.session!;
      const lines = [
        `${created ? "Created" : "Using"} session key file ${file} (chmod 600; never share or commit it)`,
        `session address ${session.address}`,
        `account         ${ctx.account}${ctx.owner ? " (owner key loaded)" : ""}`,
        `chain ${ctx.chainId}  market ${ctx.deployment.market}  book ${ctx.deployment.orderBook}`,
      ];
      if (!ctx.owner) {
        lines.push(
          "",
          "Next, from the OWNER wallet (not this machine, if you can): authorize the session key on the market:",
          `  cast send ${ctx.deployment.market} 'authorizeSession(address,uint64,uint256,uint256)' ${session.address} ${Math.floor(Date.now() / 1000) + Number(opts.days) * 86400} 3 ${parseUsdg(opts.maxRequirement)} --rpc-url <rpc>`,
          "  (scope 3 = trade + cancel; last arg = maxRequirement in USDG raw, 0 = unlimited)",
          "then deposit USDG: `hedgehood deposit <amount> --x402` or `cast send <usdg> 'approve(address,uint256)' ...; cast send <market> 'deposit(address,uint256)' ...`",
          "",
          "MCP config for Claude Code / Codex:",
          JSON.stringify({ mcpServers: { hedgehood: { command: "npx", args: ["-y", "@hedgehood-io/mcp"], env: { HEDGEHOOD_CHAIN_ID: String(ctx.chainId), HEDGEHOOD_SESSION_KEY_FILE: file, HEDGEHOOD_ACCOUNT: "<owner address>" } } } }, null, 2),
        );
        out(cmd, { sessionKeyFile: file, sessionAddress: session.address, account: ctx.account, chainId: ctx.chainId, created }, lines.join("\n"));
        return;
      }
      process.stdout.write(lines.join("\n") + "\n");
      const tx = ctx.market("owner").authorizeSession(session.address, Math.floor(Date.now() / 1000) + Number(opts.days) * 86400, { trade: true, cancel: true, maxRequirement: parseUsdg(opts.maxRequirement) });
      await send(cmd, ctx, "owner", tx, opts.send);
    });

  program
    .command("markets")
    .description("Markets, open expiries and strikes")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd, true);
      const m = ctx.market("none");
      const expiries = await m.openedExpiries();
      const infos = await Promise.all(expiries.map((e) => m.expiryInfo(e)));
      const fee = await m.protocolFeeBps();
      const human = [`${ctx.deployment.underlying} on chain ${ctx.chainId}  market ${m.market}  book ${m.orderBook}  taker fee ${fee} bps`, ...infos.map((i) => `  expiry ${i.expiry} ${new Date(Number(i.expiry) * 1000).toISOString().slice(0, 16)}Z  ${i.settled ? `settled @ ${formatUsdg(i.settlementPrice)}` : i.tradingOpen ? "trading" : "closed"}  anchor ${formatUsdg(i.anchor)}  strikes ${i.strikes.map(formatStrike).join(" ")}`)];
      out(cmd, { chainId: ctx.chainId, market: m.market, orderBook: m.orderBook, takerFeeBps: fee, expiries: infos }, human.join("\n"));
    });

  program
    .command("instruments")
    .description("Instrument ids of an expiry")
    .argument("<expiry>", "unix seconds")
    .action(async (expiry: string, _o: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd, true);
      const info = await ctx.market("none").expiryInfo(BigInt(expiry));
      const rows = info.strikes.flatMap((s) => [false, true].map((p) => ({ instrument: instrumentName(ctx.deployment.underlying, info.expiry, s, p), instrumentId: encodeInstrumentId(info.expiry, s, p), label: describeInstrument(encodeInstrumentId(info.expiry, s, p), ctx.deployment.underlying) })));
      out(cmd, { expiry: info.expiry, tradingOpen: info.tradingOpen, instruments: rows }, rows.map((r) => `${r.instrument}  ${r.instrumentId}`).join("\n"));
    });

  program
    .command("quote")
    .description("Firm RFQ quote for an instrument (NVDA-20261030-220-C, an id, or expiry:strike:call|put)")
    .argument("<instrument>")
    .requiredOption("--side <buy|sell>")
    .option("--qty <shares>", "quantity in shares", "1")
    .option("--out <file>", "save the signed quote JSON for `fill <file>`")
    .action(async (instrument: string, opts: { side: "buy" | "sell"; qty: string; out?: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const m = ctx.market("none");
      const id = await instrumentArg(ctx, instrument);
      const qty = parseShares(opts.qty);
      const q = await ctx.rfq.getQuote({ chainId: ctx.chainId, market: m.market, instrumentId: id, side: opts.side, quantityRaw: qty, taker: ctx.account, sessionKey: sessionKeyOf(ctx), underlying: ctx.deployment.underlying }, { orderBook: m.orderBook, protocolFeeBps: await m.protocolFeeBps() });
      const file = { order: orderToJson(q.order), signature: q.signature, side: opts.side, quantityRaw: qty.toString(), chainId: ctx.chainId, dryRun: q.dryRun };
      if (opts.out) writeFileSync(opts.out, JSON.stringify(file, null, 2));
      out(cmd, { ...file, digest: q.digest, instrument: q.instrument, premiumNowRaw: q.premiumNowRaw, feeNowRaw: q.feeNowRaw, netNowRaw: q.netNowRaw, canFill: q.canFill, shortfallRaw: q.shortfallRaw, funding: q.funding, secondsLeft: q.secondsLeft, fillable: q.fillable }, quoteHuman(q, ctx.deployment.underlying, qty) + (opts.out ? `\n  saved to ${opts.out}` : ""));
    });

  program
    .command("fill")
    .description("Fill a saved quote file, or quote-and-fill an instrument in one go (session key, balance mode)")
    .argument("[quoteFile]")
    .option("--instrument <x>", "quote-and-fill: instrument id or expiry:strike:call|put")
    .option("--side <buy|sell>")
    .option("--qty <shares>", "quantity in shares (default: the quoted quantity)")
    .option("--send", "broadcast instead of dry run")
    .action(async (quoteFile: string | undefined, opts: { instrument?: string; side?: "buy" | "sell"; qty?: string; send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const m = ctx.market("session");
      let order, signature: Hex, qty: bigint;
      if (quoteFile) {
        const f = JSON.parse(readFileSync(quoteFile, "utf8")) as { order: Record<string, unknown>; signature: Hex; quantityRaw?: string; dryRun?: boolean };
        if (f.dryRun) throw new Error("this quote is a backend dry-run placeholder (no signer key on the desk); it cannot be filled");
        order = orderFromJson(f.order);
        signature = f.signature;
        qty = opts.qty ? parseShares(opts.qty) : BigInt(f.quantityRaw ?? order.quantityRaw.toString());
      } else {
        if (!opts.instrument || !opts.side) throw new Error("give a quote file, or --instrument and --side");
        qty = parseShares(opts.qty ?? "1");
        const q = await ctx.rfq.getQuote({ chainId: ctx.chainId, market: m.market, instrumentId: await instrumentArg(ctx, opts.instrument), side: opts.side, quantityRaw: qty, taker: ctx.account, sessionKey: sessionKeyOf(ctx), underlying: ctx.deployment.underlying }, { orderBook: m.orderBook, protocolFeeBps: await m.protocolFeeBps() });
        process.stdout.write(quoteHuman(q, ctx.deployment.underlying, qty) + "\n");
        if (!q.fillable) throw new Error("backend dry-run quote (placeholder signature): nothing to fill");
        if (q.canFill === false) process.stdout.write(`  maker says canFill=false${q.shortfallRaw > 0n ? ` (short ${formatUsdg(q.shortfallRaw)} USDG)` : ""}; the fill will likely revert\n`);
        order = q.order;
        signature = q.signature;
      }
      if (order.taker.toLowerCase() !== ctx.account.toLowerCase()) throw new Error(`quote is addressed to ${order.taker}, not ${ctx.account}`);
      await send(cmd, ctx, "session", m.fillOrderAs(order, signature, qty, true), opts.send);
    });

  program
    .command("close")
    .description("Close an open position before expiry: quotes the opposite side of the same instrument and fills it (session key, balance mode). --all closes every open position")
    .argument("[instrument]", "NVDA-20261030-220-C, an id, or expiry:strike:call|put")
    .option("--all", "close every open position of the account")
    .option("--qty <shares>", "shares to close (default and maximum: the whole position)")
    .option("--send", "broadcast instead of dry run")
    .action(async (instrument: string | undefined, opts: { all?: boolean; qty?: string; send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      requireSession(ctx);
      const m = ctx.market("session");
      const underlying = ctx.deployment.underlying;
      const fee = await m.protocolFeeBps();
      const sessionKey = sessionKeyOf(ctx);
      const g = cmd.optsWithGlobals() as GlobalOpts;
      const closeOne = async (instrumentId: bigint, quantityRaw?: bigint) => {
        const plan = await planClose({ market: m, rfq: ctx.rfq, instrumentId, quantityRaw, sessionKey, protocolFeeBps: fee });
        const human = [closePlanHuman(plan, underlying)];
        if (!plan.quote.fillable) throw new Error(`${plan.instrument}: backend dry-run quote (placeholder signature): nothing to fill`);
        if (plan.quote.canFill === false) human.push(`  maker says canFill=false${plan.quote.shortfallRaw > 0n ? ` (short ${formatUsdg(plan.quote.shortfallRaw)} USDG)` : ""}; the fill will likely revert`);
        const r = await sendResult(ctx, "session", plan.request, opts.send);
        human.push(r.human);
        return { json: { ...closePlanJson(plan), ...r.json }, human: human.join("\n"), failed: r.failed };
      };
      if (opts.all) {
        if (instrument || opts.qty) throw new Error("--all takes no instrument or --qty");
        const now = Math.floor(Date.now() / 1000);
        const open = (await m.snapshot(ctx.account)).positions.filter((p) => Number(p.expiry) > now);
        const results: Array<Record<string, unknown>> = [];
        const human: string[] = [];
        for (const p of open) {
          try {
            const r = await closeOne(p.instrumentId);
            results.push(r.json);
            human.push(r.human);
            if (r.failed) process.exitCode = 1;
          } catch (e) {
            const name = describeInstrument(p.instrumentId, underlying);
            results.push({ instrumentId: p.instrumentId, positionRaw: p.quantityRaw, error: e instanceof Error ? e.message : String(e) });
            human.push(`close ${name}: FAILED ${e instanceof Error ? e.message : String(e)}`);
            process.exitCode = 1;
          }
        }
        out(cmd, { account: ctx.account, dryRun: !opts.send, closed: results }, human.length ? human.join("\n\n") : "no open positions to close");
        return;
      }
      if (!instrument) throw new Error("give an instrument, or --all");
      const r = await closeOne(await instrumentArg(ctx, instrument), opts.qty ? parseShares(opts.qty) : undefined);
      if (g.json) out(cmd, r.json);
      else process.stdout.write(r.human + "\n");
      if (r.failed) process.exitCode = 1;
    });

  program
    .command("positions")
    .description("Balances, open positions (with average price, mark, unrealized P&L and time to expiry) and session status")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const m = ctx.market("none");
      const underlying = ctx.deployment.underlying;
      const s = await m.snapshot(ctx.account);
      const sess = ctx.session ? await m.session(ctx.session.address, ctx.account) : undefined;
      const [indexed, pnl] = await Promise.all([ctx.rfq.positions(ctx.account).catch(() => undefined), ctx.rfq.getPnl(ctx.account).catch(() => undefined)]);
      const rows = pnlByInstrument(pnl);
      const now = Math.floor(Date.now() / 1000);
      const positions = s.positions.map((p) => ({ ...p, ...positionPnl(p, underlying, rows, now), label: describeInstrument(p.instrumentId, underlying) }));
      const lines = [
        `account ${s.account}`,
        `collateral ${formatUsdg(s.collateralRaw)}  locked ${formatUsdg(s.requirementRaw)}  free ${formatUsdg(s.freeCollateralRaw)}  wallet USDG ${formatUsdg(s.walletUsdgRaw)}`,
        positions.length
          ? table(
              ["instrument", "qty", "avg", "mark", "unrealized", "expires in", "id"],
              positions.map((p) => [p.instrument, `${p.quantityRaw > 0n ? "+" : ""}${formatShares(p.quantityRaw)}`, p.avgPrice ?? "-", p.mark == null ? "-" : String(p.mark), p.unrealized ?? "-", p.expiresIn, p.instrumentId.toString()]),
            )
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n")
          : "  no positions",
        sess ? `session ${sess.key} ${sess.active ? "ACTIVE" : "inactive"} trade=${sess.canTrade} cancel=${sess.canCancel} until ${sess.expiresAt} maxRequirement ${sess.maxRequirement === 0n ? "unlimited" : formatUsdg(sess.maxRequirement)}` : "session: none configured",
        pnl ? `pnl: realized ${usdgOf(pnl.realizedRaw)}  unrealized ${usdgOf(pnl.unrealizedRaw)}  fees ${formatUsdg(BigInt(pnl.feesPaidRaw))}  total ${usdgOf(pnl.totalRaw)}` : "pnl: indexer unavailable",
        indexed ? `indexer: ${indexed.positions.length} position(s), fills ${indexed.leaderboard?.fills ?? 0}, settled PnL ${formatUsdg(BigInt(indexed.leaderboard?.settledPnlRaw ?? "0"))}, agentId ${indexed.agentId ?? "none"}` : "indexer: unavailable",
      ];
      out(cmd, { ...s, positions, session: sess, pnl, indexed }, lines.join("\n"));
    });

  program
    .command("pnl")
    .description("Profit and loss: every open position marked at the desk's mid, then realized / unrealized / fees / total (indexer)")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const p = await ctx.rfq.getPnl(ctx.account);
      out(cmd, p, pnlHuman(p));
    });

  program
    .command("history")
    .description("Past activity of the account (fills, settlements, redeems), newest first (indexer)")
    .option("--limit <n>", "at most n events")
    .option("--since <iso|unix>", "only events at or after this time")
    .action(async (opts: { limit?: string; since?: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const limit = opts.limit === undefined ? undefined : Number(opts.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer");
      const h = await ctx.rfq.getHistory(ctx.account, { limit, since: opts.since === undefined ? undefined : parseSince(opts.since) });
      out(cmd, h, [`account ${h.account}  ${h.events.length} event(s)`, ...(h.events.length ? h.events.map(historyLine) : ["  no activity"])].join("\n"));
    });

  program
    .command("deposit")
    .description("Deposit USDG into the market balance: --x402 through the gateway (default), or --wallet approve+deposit from the owner wallet")
    .argument("<amount>", "USDG")
    .option("--x402", "pay through the x402 deposit gateway (default)")
    .option("--wallet", "approve + deposit directly from the owner wallet")
    .option("--send", "broadcast instead of dry run")
    .action(async (amount: string, opts: { x402?: boolean; wallet?: boolean; send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const amountRaw = parseUsdg(amount);
      if (opts.wallet) {
        const owner = requireOwner(ctx);
        const m = ctx.market("owner");
        const allowance = await m.usdgAllowance(owner.address);
        if (allowance < amountRaw) await send(cmd, ctx, "owner", m.approveUsdg(amountRaw), opts.send);
        await send(cmd, ctx, "owner", m.deposit(amountRaw, ctx.account), opts.send);
        return;
      }
      const payer = ctx.owner ?? requireSession(ctx);
      const r = await depositViaGateway({ account: ctx.account, market: ctx.deployment.market, amountRaw }, { signer: payer, chainId: ctx.chainId, gatewayUrl: ctx.config.gatewayUrl, dryRun: !opts.send, maxAmountRaw: parseUsdg(ctx.config.maxDepositUsdg) });
      out(cmd, r, r.dryRun ? `DRY RUN: gateway asks ${formatUsdg(BigInt(r.requirement!.amount))} USDG from ${payer.address} to ${r.requirement!.payTo} (fee ${formatUsdg(BigInt(r.instructions!.fee.raw))}); add --send to pay` : `paid; gateway deposit status ${r.deposit?.status}${r.depositTxHash ? ` tx ${r.depositTxHash}` : ""}  settlement ${JSON.stringify(r.settlement)}`);
    });

  program
    .command("redeem")
    .description("Book a settled expiry into the balance (redeemFor, permissionless)")
    .argument("<expiry>")
    .option("--send")
    .action(async (expiry: string, opts: { send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      await send(cmd, ctx, "session", ctx.market("session").redeemFor(ctx.account, BigInt(expiry)), opts.send);
    });

  program
    .command("withdraw")
    .description("Withdraw free collateral (owner key only)")
    .argument("<amount>", "USDG")
    .option("--to <address>")
    .option("--send")
    .action(async (amount: string, opts: { to?: string; send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const owner = requireOwner(ctx);
      await send(cmd, ctx, "owner", ctx.market("owner").withdraw(parseUsdg(amount), (opts.to ?? owner.address) as Address), opts.send);
    });

  const session = program.command("session").description("Session key management (owner key)");
  session
    .command("authorize")
    .option("--key <address>", "default: the configured session key")
    .option("--days <n>", "validity", "30")
    .option("--max-requirement <usdg>", "0 = unlimited", "0")
    .option("--no-cancel", "do not grant SCOPE_CANCEL")
    .option("--send")
    .action(async (opts: { key?: string; days: string; maxRequirement: string; cancel: boolean; send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const key = (opts.key ?? ctx.session?.address) as Address | undefined;
      if (!key) throw new Error("no session key: pass --key or create one with `hedgehood join`");
      await send(cmd, ctx, "owner", ctx.market("owner").authorizeSession(key, Math.floor(Date.now() / 1000) + Number(opts.days) * 86400, { trade: true, cancel: opts.cancel, maxRequirement: parseUsdg(opts.maxRequirement) }), opts.send);
    });
  session
    .command("revoke")
    .argument("<key>")
    .option("--send")
    .action(async (key: string, opts: { send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      await send(cmd, ctx, "owner", ctx.market("owner").revokeSession(key as Address), opts.send);
    });
  session
    .command("status")
    .option("--key <address>")
    .action(async (opts: { key?: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const key = (opts.key ?? ctx.session?.address) as Address | undefined;
      if (!key) throw new Error("no session key configured");
      const s = await ctx.market("none").session(key, ctx.account);
      out(cmd, s, `session ${s.key} for ${ctx.account}: ${s.active ? "ACTIVE" : "inactive"} trade=${s.canTrade} cancel=${s.canCancel} expiresAt ${s.expiresAt} maxRequirement ${s.maxRequirement === 0n ? "unlimited" : formatUsdg(s.maxRequirement)}`);
    });

  program
    .command("register")
    .description("Register an ERC-8004 agent id (mainnet only; optional)")
    .requiredOption("--name <name>")
    .option("--description <text>")
    .option("--uri <url>", "hosted registration file; default inline data: URI")
    .option("--send")
    .action(async (opts: { name: string; description?: string; uri?: string; send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const uri = opts.uri ?? dataUri(buildRegistrationFile({ name: opts.name, description: opts.description, account: ctx.account, sessionKey: ctx.session?.address, chainId: ctx.chainId }));
      await send(cmd, ctx, "owner", encodeRegisterAgent(ctx.chainId, uri), opts.send);
    });

  program
    .command("decode")
    .description("Decode an instrument id")
    .argument("<instrumentId>")
    .action((id: string, _o: unknown, cmd: Command) => {
      const d = decodeInstrumentId(BigInt(id));
      out(cmd, d, `${describeInstrument(BigInt(id))}  expiry ${d.expiry}  strike ${formatStrike(d.strike)}  ${d.isPut ? "put" : "call"}`);
    });

  program.addOption(new Option("--dry-run", "default; sends are simulated unless --send is given").hideHelp());
  return program;
}

export { privateKeyToAccount };
