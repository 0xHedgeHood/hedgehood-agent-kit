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
  describeSessionCharge,
  encodeInstrumentId,
  expiryOf,
  formatSessionCap,
  instrumentName,
  shareStrikeOf,
  Side,
  tokenStrikeOf,
  UNIT_MULTIPLIER,
  UNLIMITED,
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
  LTV_WARN_FRACTION,
  type BorrowStatus,
  type ClosePlan,
  type HistoryEvent,
  type LendStatus,
  type LendingPlan,
  type MarketClient,
  type OracleStatus,
  type PlanStep,
  type PlanStepResult,
  type PnlView,
  type PlannedSessionLeg,
  type SessionCharge,
  type TxRequest,
  type VaultInfo,
  type VaultPlan,
  type VerifiedQuote,
} from "@hedgehood-io/sdk";
import { formatUnits } from "viem";
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
  vaultApiUrl?: string;
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
  if (o.vaultApiUrl) env.HEDGEHOOD_VAULT_API_URL = o.vaultApiUrl;
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
async function sendResult(ctx: KitContext, who: "session" | "owner", tx: TxRequest, sendFlag: boolean | undefined, sessionCharge?: SessionCharge): Promise<{ json: Record<string, unknown>; human: string; failed: boolean }> {
  const dryRun = !sendFlag;
  if (who === "owner") requireOwner(ctx);
  else requireSession(ctx);
  const m = ctx.market(who);
  const r = await m.send(tx, { dryRun, sessionCharge });
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

async function send(cmd: Command, ctx: KitContext, who: "session" | "owner", tx: TxRequest, sendFlag: boolean | undefined, sessionCharge?: SessionCharge) {
  const r = await sendResult(ctx, who, tx, sendFlag, sessionCharge);
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
    quoteHuman(q, underlying, plan.quantityRaw, plan.position.uiMultiplier),
    ...(plan.sessionCharge ? [`  ${describeSessionCharge(plan.sessionCharge)}`] : []),
  ].join("\n");
}

function closePlanJson(plan: ClosePlan) {
  const q = plan.quote;
  return { instrument: plan.instrument, instrumentId: plan.instrumentId, positionRaw: plan.position.quantityRaw, side: plan.side, quantityRaw: plan.quantityRaw, remainingRaw: plan.remainingRaw, digest: q.digest, pricePerShareRaw: q.pricePerShareRaw, premiumNowRaw: q.premiumNowRaw, feeNowRaw: q.feeNowRaw, netNowRaw: q.netNowRaw, canFill: q.canFill, shortfallRaw: q.shortfallRaw, secondsLeft: q.secondsLeft, fillable: q.fillable, backendDryRun: q.dryRun, sessionCharge: plan.sessionCharge };
}

/**
 * "<instrumentId>", "NVDA-20261030-220-C" (backend name, listed per-share strike) or "<expiry>:<strike>:<call|put>"
 * (per-share strike, mapped to the per-token strike under the expiry's uiMultiplier).
 */
async function instrumentArg(ctx: KitContext, v: string): Promise<bigint> {
  if (/^\d+$/.test(v)) return BigInt(v);
  const m = /^(\d+):(\d+(?:\.\d+)?):(call|put|c|p)$/i.exec(v);
  const market = ctx.market("none");
  if (m) {
    const expiry = BigInt(m[1]!);
    return encodeInstrumentId(expiry, tokenStrikeOf(parseUsdg(m[2]!), await market.expiryMultiplier(expiry)), /^p/i.test(m[3]!));
  }
  return market.resolveInstrumentName(v);
}

/** "unlimited" -> type(uint256).max, else USDG -> raw. */
export function parseCap(v: string, flag: string): bigint {
  const t = v.trim();
  if (/^unlimited$/i.test(t)) return UNLIMITED;
  try {
    return parseUsdg(t);
  } catch {
    throw new Error(`${flag} must be a USDG amount or "unlimited", got ${v}`);
  }
}

const MAX_SPEND_HELP = "cumulative USDG of premium + fees the session key may make the account pay as buyer over the session, beyond the worst case of the shorts it buys back (0 = buy to close only; unlimited = no cap)";
const MAX_SHORT_RISK_HELP = "cumulative USDG worst case of the shorts the session key may open over the session: each sell leg costs ceil(opened short x (capHigh - strike | strike - capLow) / 1e18), selling a long held is free (0 = it cannot sell to open; unlimited = no cap)";
const MAX_SPEND_MISSING =
  "--max-spend is required: the most premium + fees this session key may spend for the account over the session. Suggested: --max-spend 100 (or the budget you mean to trade, at most your deposit); --max-spend 0 lets it only sell longs and buy back shorts; --max-spend unlimited removes the cap (not recommended).";
const MAX_REQUIREMENT_GONE =
  "--max-requirement was removed (hedgehood-options #58): sessions now carry a cumulative short-risk budget instead of a cap on the account's requirement. Use --max-short-risk <usdg|unlimited> (default 0 = the key cannot sell to open; each short it opens costs its worst-case payout, e.g. 1 share of a 220 call with capHigh 279.5 costs 59.5).";

/** `--max-requirement` stays only to explain its replacement. */
const maxRequirementAlias = () => new Option("--max-requirement <usdg|unlimited>", "removed: use --max-short-risk").hideHelp();

function sessionLine(s: { key: string; active: boolean; canTrade: boolean; canCancel: boolean; expiresAt: bigint; authorizedAt: bigint; riskLeft: bigint; spendLeft: bigint }): string {
  const at = (t: bigint) => (t === 0n ? "-" : iso(Number(t)));
  return `session ${s.key} ${s.active ? "ACTIVE" : "inactive"} trade=${s.canTrade} cancel=${s.canCancel} authorized ${at(s.authorizedAt)} until ${at(s.expiresAt)} riskLeft ${formatSessionCap(s.riskLeft)} spendLeft ${formatSessionCap(s.spendLeft)}`;
}

/** The session charge of a leg the configured session key is about to fill; undefined without a session key or when the reads fail. */
async function sessionChargeFor(ctx: KitContext, m: MarketClient, leg: Omit<PlannedSessionLeg, "key" | "account">): Promise<SessionCharge | undefined> {
  const key = sessionKeyOf(ctx);
  if (!key) return undefined;
  try {
    return await m.sessionCharge({ ...leg, key, account: ctx.account });
  } catch {
    return undefined;
  }
}

const chargeLine = (c: SessionCharge | undefined) => (c ? `\n  ${describeSessionCharge(c)}` : "");

function quoteHuman(q: VerifiedQuote, underlying: string, qty: bigint, uiMultiplier: bigint = UNIT_MULTIPLIER): string {
  const pays = q.netNowRaw > 0n;
  return [
    `${q.instrument}  (${describeInstrument(q.order.instrumentId, underlying, uiMultiplier)})  qty ${formatShares(qty)}${q.dryRun ? "  [BACKEND DRY RUN: placeholder signature, not fillable]" : ""}`,
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
    .option("--owner-key-file <path>", "owner key file, only for deposit/withdraw/session/join and every vault action")
    .option("--vault-api-url <url|off>", "Stock Yield fund snapshot API for `vaults` (default: hedgehood.app on mainnet; off = chain only)")
    .option("--json", "machine-readable output");

  program
    .command("join")
    .description("Create a session key (if none), show the addresses, and (with an owner key) authorize it on the market")
    .option("--days <n>", "session validity in days", "30")
    .option("--max-spend <usdg|unlimited>", `${MAX_SPEND_HELP}; required to authorize`)
    .option("--max-short-risk <usdg|unlimited>", MAX_SHORT_RISK_HELP, "0")
    .addOption(maxRequirementAlias())
    .option("--send", "broadcast instead of dry run")
    .action(async (opts: { days: string; maxSpend?: string; maxShortRisk: string; maxRequirement?: string; send?: boolean }, cmd: Command) => {
      if (opts.maxRequirement !== undefined) throw new Error(MAX_REQUIREMENT_GONE);
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
      const maxShortRisk = parseCap(opts.maxShortRisk, "--max-short-risk");
      const maxSpend = opts.maxSpend === undefined ? undefined : parseCap(opts.maxSpend, "--max-spend");
      if (!ctx.owner) {
        lines.push(
          "",
          "Next, from the OWNER wallet (not this machine, if you can): authorize the session key on the market:",
          `  cast send ${ctx.deployment.market} 'authorizeSession(address,uint64,uint256,uint256,uint256)' ${session.address} ${Math.floor(Date.now() / 1000) + Number(opts.days) * 86400} 3 ${maxShortRisk} ${maxSpend ?? "<maxSpendRaw>"} --rpc-url <rpc>`,
          "  (scope 3 = trade + cancel; then maxShortRisk and maxSpend, cumulative budgets in USDG raw (6 decimals): 0 = none, 115792089237316195423570985008687907853269984665640564039457584007913129639935 = unlimited.",
          "   maxSpend: premium + fees the key may pay over the session beyond buying back shorts, e.g. 100000000 = 100 USDG;",
          "   maxShortRisk: summed worst-case payout of the shorts it may open; 0 = it cannot sell to open)",
          "then deposit USDG: `hedgehood deposit <amount> --x402` or `cast send <usdg> 'approve(address,uint256)' ...; cast send <market> 'deposit(address,uint256)' ...`",
          "",
          "MCP config for Claude Code / Codex:",
          JSON.stringify({ mcpServers: { hedgehood: { command: "npx", args: ["-y", "@hedgehood-io/mcp"], env: { HEDGEHOOD_CHAIN_ID: String(ctx.chainId), HEDGEHOOD_SESSION_KEY_FILE: file, HEDGEHOOD_ACCOUNT: "<owner address>" } } } }, null, 2),
        );
        out(cmd, { sessionKeyFile: file, sessionAddress: session.address, account: ctx.account, chainId: ctx.chainId, created }, lines.join("\n"));
        return;
      }
      if (maxSpend === undefined) throw new Error(MAX_SPEND_MISSING);
      process.stdout.write(lines.join("\n") + "\n");
      const tx = ctx.market("owner").authorizeSession(session.address, Math.floor(Date.now() / 1000) + Number(opts.days) * 86400, { trade: true, cancel: true, maxShortRisk, maxSpend });
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
      const human = [`${ctx.deployment.underlying} on chain ${ctx.chainId}  market ${m.market}  book ${m.orderBook}  taker fee ${fee} bps`, ...infos.map((i) => `  expiry ${i.expiry} ${new Date(Number(i.expiry) * 1000).toISOString().slice(0, 16)}Z  ${i.settled ? `settled @ ${formatUsdg(i.settlementPrice)}` : i.tradingOpen ? "trading" : "closed"}  anchor ${formatUsdg(i.anchor)}${i.uiMultiplier === UNIT_MULTIPLIER ? "" : ` (per token; uiMultiplier ${formatUnits(i.uiMultiplier, 18)})`}  strikes ${i.shareStrikes.map(formatStrike).join(" ")}`)];
      out(cmd, { chainId: ctx.chainId, market: m.market, orderBook: m.orderBook, takerFeeBps: fee, expiries: infos }, human.join("\n"));
    });

  program
    .command("instruments")
    .description("Instrument ids of an expiry")
    .argument("<expiry>", "unix seconds")
    .action(async (expiry: string, _o: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd, true);
      const info = await ctx.market("none").expiryInfo(BigInt(expiry));
      const rows = info.strikes.flatMap((s) => [false, true].map((p) => ({ instrument: instrumentName(ctx.deployment.underlying, info.expiry, s, p, info.uiMultiplier), instrumentId: encodeInstrumentId(info.expiry, s, p), strike: formatStrike(shareStrikeOf(s, info.uiMultiplier)), strikeRaw: s, label: describeInstrument(encodeInstrumentId(info.expiry, s, p), ctx.deployment.underlying, info.uiMultiplier) })));
      out(cmd, { expiry: info.expiry, tradingOpen: info.tradingOpen, uiMultiplier: info.uiMultiplier, instruments: rows }, rows.map((r) => `${r.instrument}  ${r.instrumentId}`).join("\n"));
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
      const uiMultiplier = await m.expiryMultiplier(expiryOf(id));
      const q = await ctx.rfq.getQuote({ chainId: ctx.chainId, market: m.market, instrumentId: id, side: opts.side, quantityRaw: qty, taker: ctx.account, sessionKey: sessionKeyOf(ctx), underlying: ctx.deployment.underlying, uiMultiplier }, { orderBook: m.orderBook, protocolFeeBps: await m.protocolFeeBps() });
      const file = { order: orderToJson(q.order), signature: q.signature, side: opts.side, quantityRaw: qty.toString(), chainId: ctx.chainId, dryRun: q.dryRun };
      if (opts.out) writeFileSync(opts.out, JSON.stringify(file, null, 2));
      const charge = await sessionChargeFor(ctx, m, { instrumentId: id, side: opts.side, quantityRaw: qty, order: q.order, protocolFeeBps: q.feeBps });
      out(cmd, { ...file, digest: q.digest, instrument: q.instrument, premiumNowRaw: q.premiumNowRaw, feeNowRaw: q.feeNowRaw, netNowRaw: q.netNowRaw, canFill: q.canFill, shortfallRaw: q.shortfallRaw, funding: q.funding, secondsLeft: q.secondsLeft, fillable: q.fillable, sessionCharge: charge }, quoteHuman(q, ctx.deployment.underlying, qty, uiMultiplier) + chargeLine(charge) + (opts.out ? `\n  saved to ${opts.out}` : ""));
    });

  program
    .command("fill")
    .description("Fill a saved quote file, or quote-and-fill an instrument in one go (session key, always balance mode; a sell that opens a short draws the short-risk budget, a buy the spend budget beyond the shorts it closes)")
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
        const id = await instrumentArg(ctx, opts.instrument);
        const uiMultiplier = await m.expiryMultiplier(expiryOf(id));
        const q = await ctx.rfq.getQuote({ chainId: ctx.chainId, market: m.market, instrumentId: id, side: opts.side, quantityRaw: qty, taker: ctx.account, sessionKey: sessionKeyOf(ctx), underlying: ctx.deployment.underlying, uiMultiplier }, { orderBook: m.orderBook, protocolFeeBps: await m.protocolFeeBps() });
        process.stdout.write(quoteHuman(q, ctx.deployment.underlying, qty, uiMultiplier) + "\n");
        if (!q.fillable) throw new Error("backend dry-run quote (placeholder signature): nothing to fill");
        if (q.canFill === false) process.stdout.write(`  maker says canFill=false${q.shortfallRaw > 0n ? ` (short ${formatUsdg(q.shortfallRaw)} USDG)` : ""}; the fill will likely revert\n`);
        order = q.order;
        signature = q.signature;
      }
      if (order.taker.toLowerCase() !== ctx.account.toLowerCase()) throw new Error(`quote is addressed to ${order.taker}, not ${ctx.account}`);
      const charge = await sessionChargeFor(ctx, m, { instrumentId: order.instrumentId, side: order.side === Side.Ask ? "buy" : "sell", quantityRaw: qty, order });
      if (charge) process.stdout.write(`  ${describeSessionCharge(charge)}\n`);
      await send(cmd, ctx, "session", m.fillOrderAs(order, signature, qty, true), opts.send, charge);
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
        const r = await sendResult(ctx, "session", plan.request, opts.send, plan.sessionCharge);
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
            const name = describeInstrument(p.instrumentId, underlying, p.uiMultiplier);
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
      const positions = s.positions.map((p) => ({ ...p, ...positionPnl(p, underlying, rows, now), label: describeInstrument(p.instrumentId, underlying, p.uiMultiplier) }));
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
        sess ? sessionLine(sess) : "session: none configured",
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
    .description("authorizeSession(key, expiresAt, scope, maxShortRisk, maxSpend); re-authorizing resets both budgets and voids orders the key signed before")
    .option("--key <address>", "default: the configured session key")
    .option("--days <n>", "validity", "30")
    .option("--max-spend <usdg|unlimited>", `${MAX_SPEND_HELP}; required, e.g. 100`)
    .option("--max-short-risk <usdg|unlimited>", MAX_SHORT_RISK_HELP, "0")
    .addOption(maxRequirementAlias())
    .option("--no-cancel", "do not grant SCOPE_CANCEL")
    .option("--send")
    .action(async (opts: { key?: string; days: string; maxSpend?: string; maxShortRisk: string; maxRequirement?: string; cancel: boolean; send?: boolean }, cmd: Command) => {
      if (opts.maxRequirement !== undefined) throw new Error(MAX_REQUIREMENT_GONE);
      if (opts.maxSpend === undefined) throw new Error(MAX_SPEND_MISSING);
      const maxSpend = parseCap(opts.maxSpend, "--max-spend");
      const maxShortRisk = parseCap(opts.maxShortRisk, "--max-short-risk");
      const ctx = ctxFrom(cmd);
      const key = (opts.key ?? ctx.session?.address) as Address | undefined;
      if (!key) throw new Error("no session key: pass --key or create one with `hedgehood join`");
      await send(cmd, ctx, "owner", ctx.market("owner").authorizeSession(key, Math.floor(Date.now() / 1000) + Number(opts.days) * 86400, { trade: true, cancel: opts.cancel, maxShortRisk, maxSpend }), opts.send);
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
      out(cmd, s, `${sessionLine(s)}\n  account ${ctx.account}; a session key fills in balance mode only; shorts it opens come out of riskLeft (their worst case), buys out of spendLeft beyond the shorts they close (SessionLimit when either runs out)`);
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
    .description("Decode an instrument id; the strike shown is the listed per-share strike under the expiry's uiMultiplier (read from the market unless --multiplier)")
    .argument("<instrumentId>")
    .option("--multiplier <raw>", "the expiry's uiMultiplier (1e18 = 1.0); default: read from the market, else 1e18")
    .action(async (id: string, opts: { multiplier?: string }, cmd: Command) => {
      const d = decodeInstrumentId(BigInt(id));
      let m = opts.multiplier ? BigInt(opts.multiplier) : undefined;
      if (m === undefined) {
        try {
          m = await ctxFrom(cmd, true).market("none").expiryMultiplier(d.expiry);
        } catch {
          m = UNIT_MULTIPLIER;
        }
      }
      const shareStrike = shareStrikeOf(d.strike, m);
      const g = cmd.optsWithGlobals() as GlobalOpts;
      const underlying = g.underlying ?? "";
      out(cmd, { ...d, shareStrike, uiMultiplier: m }, `${describeInstrument(BigInt(id), underlying, m)}  expiry ${d.expiry}  strike ${formatStrike(shareStrike)}${m === UNIT_MULTIPLIER ? "" : ` (per token ${formatStrike(d.strike)}, uiMultiplier ${formatUnits(m, 18)})`}  ${d.isPut ? "put" : "call"}`);
    });

  registerVaultCommands(program);
  registerLendingCommands(program);

  program.addOption(new Option("--dry-run", "default; sends are simulated unless --send is given").hideHelp());
  return program;
}

// ---------------------------------------------------------------- Stock Yield vaults

const VAULT_NOTE = "Vault requests queue until the next epoch freeze (Monday morning New York on mainnet); a redeem is paid in kind after the current weekly option expires, then claimed. Up to a week.";

const whenIso = (t?: bigint) => (t === undefined || t === 0n ? "-" : iso(Number(t)));
const navOf = (v: VaultInfo) => (v.nav.usdgPerShareRaw === undefined ? "-" : formatUsdg(v.nav.usdgPerShareRaw));
const pendingOf = (v: VaultInfo) => {
  const p: string[] = [];
  if (v.my?.pendingDeposit) p.push(`dep ${v.my.pendingDeposit.usdgRaw ? formatUsdg(v.my.pendingDeposit.usdgRaw) + " USDG" : ""}${v.my.pendingDeposit.stockRaw ? " " + formatShares(v.my.pendingDeposit.stockRaw) + " stk" : ""} (e${v.my.pendingDeposit.epoch}${v.my.pendingDeposit.cancellable ? "" : ", frozen"})`);
  if (v.my?.pendingRedeem) p.push(`red ${formatShares(v.my.pendingRedeem.sharesRaw)} (e${v.my.pendingRedeem.epoch}${v.my.pendingRedeem.cancellable ? "" : ", frozen"})`);
  return p.length ? p.join("; ") : "-";
};
const claimableOf = (v: VaultInfo) => (v.my && (v.my.claimableStockRaw !== 0n || v.my.claimableUsdgRaw !== 0n) ? `${formatShares(v.my.claimableStockRaw)} stk + ${formatUsdg(v.my.claimableUsdgRaw)} USDG` : "-");

function vaultsHuman(list: VaultInfo[], chainId: number, withAccount: boolean): string {
  const rows = list.map((v) => {
    const r = [v.symbol, v.epoch.state, whenIso(v.epoch.nextFreezeAt), navOf(v), formatUsdg(v.nav.navUsdgRaw), `${formatUsdg(v.capUsedUsdgRaw)}/${formatUsdg(v.depositCapUsdgRaw)}`, v.lastEpoch?.weeklyYieldBps === undefined ? "-" : `${(v.lastEpoch.weeklyYieldBps / 100).toFixed(2)}%`];
    if (withAccount) r.push(v.my ? formatShares(v.my.sharesRaw) : "-", pendingOf(v), claimableOf(v));
    return r;
  });
  const header = ["fund", "epoch", "next freeze (UTC)", "NAV/share", "NAV USDG", "cap used", "last wk"];
  if (withAccount) header.push("my shares", "pending", "claimable");
  return [`Stock Yield vaults on chain ${chainId}${list[0]?.source === "api" ? " (snapshot: hedgehood.app API + chain)" : " (chain)"}`, table(header, rows), VAULT_NOTE].join("\n");
}

function vaultJson(v: VaultInfo) {
  return {
    ...v,
    nav: { ...v.nav, usdgPerShare: v.nav.usdgPerShareRaw === undefined ? null : formatUsdg(v.nav.usdgPerShareRaw), stockPrice: v.nav.priceRaw === 0n ? null : formatUnits(v.nav.priceRaw, 18) },
    epoch: { ...v.epoch, nextFreezeAtIso: v.epoch.nextFreezeAt ? iso(Number(v.epoch.nextFreezeAt)) : null, nextSettleAtIso: v.epoch.nextSettleAt ? iso(Number(v.epoch.nextSettleAt)) : null },
  };
}

function vaultStatusHuman(v: VaultInfo): string {
  const m = v.my!;
  return [
    `${v.symbol} ${v.vault}  epoch ${v.epoch.index} ${v.epoch.state}  next freeze ${whenIso(v.epoch.nextFreezeAt)}  expiry ${whenIso(v.epoch.nextSettleAt)}  NAV/share ${navOf(v)}`,
    `  shares ${formatShares(m.sharesRaw)}${m.uncreditedSharesRaw ? ` (${formatShares(m.uncreditedSharesRaw)} not credited yet)` : ""}  pending ${pendingOf(v)}  claimable ${claimableOf(v)}`,
    `  wallet ${formatUsdg(m.walletUsdgRaw)} USDG, ${formatShares(m.walletStockRaw)} ${v.stock.symbol}  canDeposit ${m.canDeposit}`,
  ].join("\n");
}

/** Runs a plan of owner-key steps (vault or lending): dry run unless --send; prints every step. */
async function runSteps(cmd: Command, client: { sendPlan: (p: never, o: { dryRun: boolean }) => Promise<PlanStepResult[]>; chain: { blockExplorers?: { default: { url: string } } } }, plan: { steps: PlanStep[]; summary: string }, header: string[], jsonHead: Record<string, unknown>, sendFlag: boolean | undefined) {
  const results = await client.sendPlan(plan as never, { dryRun: !sendFlag });
  const lines = [...header];
  for (const r of results) {
    if (r.dryRun) lines.push(`DRY RUN${r.simulated ? " (simulation passed)" : " (not simulated: needs the approval above mined first)"}: ${r.request.summary}\n  from ${r.from}\n  to   ${r.request.to}\n  data ${r.request.data}`);
    else lines.push(`${r.status === "success" ? "OK" : "REVERTED"} ${r.request.summary}\n  tx ${r.hash}\n  ${client.chain.blockExplorers?.default.url}/tx/${r.hash}`);
  }
  if (results.some((r) => r.dryRun)) lines.push("  add --send to broadcast");
  const failed = !results.every((r) => r.dryRun || r.status === "success") || results.length !== plan.steps.length;
  out(cmd, { ...jsonHead, summary: plan.summary, dryRun: !sendFlag, steps: results.map((r) => ({ kind: r.kind, to: r.request.to, data: r.request.data, summary: r.request.summary, simulated: r.simulated, txHash: r.hash, status: r.status, blockNumber: r.blockNumber })) }, lines.join("\n"));
  if (failed) process.exitCode = 1;
}

/** Runs a vault plan from the owner key: dry run unless --send; prints every step. */
async function runPlan(cmd: Command, ctx: KitContext, plan: VaultPlan, sendFlag: boolean | undefined) {
  requireOwner(ctx);
  await runSteps(cmd, ctx.vault("owner"), plan, [plan.summary, `  ${VAULT_NOTE}`], { vault: plan.vault, symbol: plan.symbol, account: plan.account }, sendFlag);
}

function registerVaultCommands(program: Command) {
  program
    .command("vaults")
    .description("Stock Yield vaults (v2 EpochFund): NAV per share, epoch state, next freeze, cap, last week's premium yield, and your shares / pending / claimable when an account is known")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd, true);
      const v = ctx.vault("none");
      const withAccount = ctx.account.toLowerCase() !== ZERO;
      const list = await v.listVaults({ account: withAccount ? ctx.account : null });
      out(cmd, { chainId: ctx.chainId, account: withAccount ? ctx.account : undefined, registry: v.registry, api: v.apiUrl ?? null, vaults: list.map(vaultJson) }, vaultsHuman(list, ctx.chainId, withAccount));
    });

  const vault = program.command("vault").description("Stock Yield vault actions: deposit, redeem, claim, cancel (owner key; dry run unless --send). " + VAULT_NOTE);
  vault
    .command("status")
    .description("Your shares, queued requests and claimables per vault")
    .option("--vault <addr|symbol>", "one fund; default: every fund you touched or can deposit into")
    .action(async (opts: { vault?: string }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      const v = ctx.vault("none");
      const vaults = opts.vault ? [await v.resolveVault(opts.vault)] : undefined;
      const list = await v.status(ctx.account, { vaults });
      const shown = opts.vault ? list : list.filter((x) => x.my && (x.my.sharesRaw !== 0n || x.my.pendingDeposit || x.my.pendingRedeem || x.my.claimableStockRaw !== 0n || x.my.claimableUsdgRaw !== 0n || x.my.canDeposit));
      out(cmd, { chainId: ctx.chainId, account: ctx.account, vaults: shown.map(vaultJson) }, [`account ${ctx.account}`, ...(shown.length ? shown.map(vaultStatusHuman) : ["  no vault positions"])].join("\n"));
    });
  vault
    .command("deposit")
    .description("Queue a USDG (and/or stock) deposit from the owner wallet: approve + requestDeposit")
    .argument("<usdg>", "USDG amount (0 when depositing stock only)")
    .requiredOption("--vault <addr|symbol>", "fund address, hhNVDA-CC / NVDA-CC, or a stock ticker naming one fund")
    .option("--stock <amount>", "stock tokens to deposit as well (18 decimals)")
    .option("--receiver <address>", "account credited with the shares; default: the account")
    .option("--send", "broadcast instead of dry run")
    .action(async (usdg: string, opts: { vault: string; stock?: string; receiver?: string; send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      requireOwner(ctx);
      const v = ctx.vault("owner");
      const usdgRaw = parseUsdg(usdg);
      const plan = await v.planDeposit({ vault: await v.resolveVault(opts.vault), usdgRaw: usdgRaw || undefined, stockRaw: opts.stock ? parseShares(opts.stock) : undefined, receiver: opts.receiver as Address | undefined });
      await runPlan(cmd, ctx, plan, opts.send);
    });
  vault
    .command("redeem")
    .description("Queue a redemption of shares (or `all`); paid in kind at the next freeze after the current option expires, then `vault claim`")
    .argument("<shares|all>")
    .requiredOption("--vault <addr|symbol>")
    .option("--send", "broadcast instead of dry run")
    .action(async (shares: string, opts: { vault: string; send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      requireOwner(ctx);
      const v = ctx.vault("owner");
      const plan = await v.planRedeem({ vault: await v.resolveVault(opts.vault), shares });
      await runPlan(cmd, ctx, plan, opts.send);
    });
  vault
    .command("claim")
    .description("Pay out redeemed or refunded stock + USDG (claim(account, to))")
    .requiredOption("--vault <addr|symbol>")
    .option("--to <address>", "recipient; default: the owner address")
    .option("--send", "broadcast instead of dry run")
    .action(async (opts: { vault: string; to?: string; send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      requireOwner(ctx);
      const v = ctx.vault("owner");
      const plan = await v.planClaim({ vault: await v.resolveVault(opts.vault), to: opts.to as Address | undefined });
      await runPlan(cmd, ctx, plan, opts.send);
    });
  vault
    .command("cancel")
    .description("Cancel a queued deposit (returned to --to, default the owner) or redemption, until the cohort's cutoff")
    .argument("<deposit|redeem>")
    .requiredOption("--vault <addr|symbol>")
    .option("--to <address>", "deposit only: where the returned assets go")
    .option("--send", "broadcast instead of dry run")
    .action(async (which: string, opts: { vault: string; to?: string; send?: boolean }, cmd: Command) => {
      if (which !== "deposit" && which !== "redeem") throw new Error("cancel takes `deposit` or `redeem`");
      const ctx = ctxFrom(cmd);
      requireOwner(ctx);
      const v = ctx.vault("owner");
      const addr = await v.resolveVault(opts.vault);
      const plan = which === "deposit" ? await v.planCancelDeposit({ vault: addr, to: opts.to as Address | undefined }) : await v.planCancelRedeem({ vault: addr });
      await runPlan(cmd, ctx, plan, opts.send);
    });
}

// ---------------------------------------------------------------- Share lending

const LENDING_NOTE = "Instant (no epochs). Borrowers are liquidated below health factor 1; the collateral oracle is re-marked weekly after the Monday lock, so keep LTV <= 70% of the LLTV. The market id is read from the lending vault (it changes on an oracle migration).";

const pctOf = (x: number | null | undefined) => (x === null || x === undefined ? "-" : `${(x * 100).toFixed(2)}%`);
const oracleLine = (o: OracleStatus) => `oracle ${o.address} ${o.state}${o.collateralPriceUsdgRaw !== undefined ? ` ${formatUsdg(o.collateralPriceUsdgRaw)} USDG/share` : ""}${o.spotRaw !== undefined ? ` (stock ${formatUnits(o.spotRaw, 18)})` : ""}${o.error ? ` ${o.error}` : ""}`;

function lendHuman(s: LendStatus): string {
  const lines = [
    `${s.symbol} ${s.vault} (${s.name})  total ${formatUsdg(s.totalAssetsRaw)} USDG  idle ${formatUsdg(s.idleRaw)}  supplied ${formatUsdg(s.allocatedRaw)}  cap ${formatUsdg(s.capRaw)} (room ${formatUsdg(s.capLeftRaw)})`,
    `  supply rate ${pctOf(s.supplyApy)}  utilization ${pctOf(s.utilization)}  withdrawable now ${formatUsdg(s.liquidityRaw)}  performance fee ${pctOf(s.performanceFee)}${s.supplyApyNote ? `\n  (${s.supplyApyNote})` : ""}`,
  ];
  if (s.market) lines.push(`  market ${s.market.id}  borrow rate ${pctOf(s.market.borrowRate)}  borrowed ${formatUsdg(s.market.totalBorrowRaw)} of ${formatUsdg(s.market.totalSupplyRaw)}  ${oracleLine(s.market.oracleStatus)}`);
  if (s.discovery === "config") lines.push("  (vault unreadable: market from the deployment registry)");
  if (s.my) lines.push(`  my ${formatUnits(s.my.sharesRaw, 18)} ${s.symbol} = ${formatUsdg(s.my.assetsRaw)} USDG  wallet ${formatUsdg(s.my.walletUsdgRaw)} USDG  canDeposit ${s.my.canDeposit}  canWithdraw ${s.my.canWithdraw}`);
  lines.push(`  ${LENDING_NOTE}`);
  return lines.join("\n");
}

function borrowHuman(s: BorrowStatus): string {
  const m = s.market;
  const my = s.my;
  const lines = [
    `market ${m.id}${m.isLiquidityMarket ? " (the vault's liquidity market)" : ""}  LLTV ${pctOf(Number(m.lltv) / 1e18)}  collateral ${m.collateralToken}  loan ${m.loanToken}`,
    `  ${oracleLine(m.oracleStatus)}`,
    `  borrow rate ${pctOf(m.borrowRate)} APR  utilization ${pctOf(m.utilization)}  supplied ${formatUsdg(m.totalSupplyRaw)}  borrowed ${formatUsdg(m.totalBorrowRaw)}  available ${formatUsdg(m.available)}`,
    `  my collateral ${formatShares(my.collateralRaw)} shares${my.collateralValueRaw !== null ? ` = ${formatUsdg(my.collateralValueRaw)} USDG` : ""}  debt ${formatUsdg(my.borrowAssetsRaw)} USDG  max borrow ${my.maxBorrowRaw === null ? "-" : formatUsdg(my.maxBorrowRaw)}  borrowable ${my.borrowableRaw === null ? "-" : formatUsdg(my.borrowableRaw)} (recommended ${my.recommendedBorrowableRaw === null ? "-" : formatUsdg(my.recommendedBorrowableRaw)})`,
    `  health factor ${my.healthFactor ?? "-"}  LTV ${pctOf(my.ltv)}  liquidation at ${my.liquidationPriceUsdgRaw === null ? "-" : formatUsdg(my.liquidationPriceUsdgRaw) + " USDG/share"}  wallet ${formatShares(my.walletSharesRaw)} shares, ${formatUsdg(my.walletUsdgRaw)} USDG`,
  ];
  for (const w of s.warnings) lines.push(`  ! ${w}`);
  lines.push(`  ${LENDING_NOTE}`);
  return lines.join("\n");
}

function lendingJson(s: LendStatus | BorrowStatus) {
  return s;
}

async function runLendingPlan(cmd: Command, ctx: KitContext, plan: LendingPlan, sendFlag: boolean | undefined) {
  requireOwner(ctx);
  const header = [plan.summary, ...plan.warnings.map((w) => `  ! ${w}`)];
  if (plan.after) header.push(`  after: collateral ${formatShares(plan.after.collateralRaw)} shares, debt ${formatUsdg(plan.after.borrowAssetsRaw)} USDG, health factor ${plan.after.healthFactor ?? "-"}, LTV ${pctOf(plan.after.ltv)}, liquidation at ${plan.after.liquidationPriceUsdgRaw === null ? "-" : formatUsdg(plan.after.liquidationPriceUsdgRaw) + " USDG/share"}`);
  header.push(`  ${LENDING_NOTE}`);
  await runSteps(cmd, ctx.lending("owner"), plan, header, { action: plan.action, account: plan.account, market: plan.market?.id, warnings: plan.warnings, after: plan.after }, sendFlag);
}

function registerLendingCommands(program: Command) {
  const lend = program.command("lend").description("Lend USDG in the hhUSDG lending vault (Morpho Vault V2; instant; owner key for writes, dry run unless --send). " + LENDING_NOTE);
  lend
    .command("status")
    .description("The lending vault: size, cap, liquidity, supply rate, the market it supplies, your hhUSDG shares")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = ctxFrom(cmd, true);
      const withAccount = ctx.account.toLowerCase() !== ZERO;
      const s = await ctx.lending("none").lendStatus(withAccount ? ctx.account : null);
      out(cmd, { account: withAccount ? ctx.account : undefined, ...lendingJson(s) }, lendHuman(s));
    });
  lend
    .command("deposit")
    .description("Lend USDG: approve + deposit(usdg, account) into the vault")
    .argument("<usdg>")
    .option("--receiver <address>", "account credited with the hhUSDG shares; default: the account")
    .option("--send", "broadcast instead of dry run")
    .action(async (usdg: string, opts: { receiver?: string; send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      requireOwner(ctx);
      const plan = await ctx.lending("owner").planLendDeposit({ usdgRaw: parseUsdg(usdg), receiver: opts.receiver as Address | undefined });
      await runLendingPlan(cmd, ctx, plan, opts.send);
    });
  lend
    .command("withdraw")
    .description("Withdraw lent USDG (an amount, or `all` = redeem every share); instant while the vault has liquidity")
    .argument("<usdg|all>")
    .option("--receiver <address>", "recipient; default: the owner address")
    .option("--send", "broadcast instead of dry run")
    .action(async (usdg: string, opts: { receiver?: string; send?: boolean }, cmd: Command) => {
      const ctx = ctxFrom(cmd);
      requireOwner(ctx);
      const plan = await ctx.lending("owner").planLendWithdraw({ usdg, receiver: opts.receiver as Address | undefined });
      await runLendingPlan(cmd, ctx, plan, opts.send);
    });

  const borrow = program.command("borrow").description("Borrow USDG against Stock Yield fund shares on Morpho Blue (owner key for writes, dry run unless --send). " + LENDING_NOTE);
  const marketOpt = (c: Command) => c.option("--market <id>", "Blue market id; default: the market the lending vault supplies");
  marketOpt(borrow.command("status").description("The market (LLTV, oracle, rate, liquidity) and your position (collateral, debt, health factor, LTV, liquidation price)")).action(async (opts: { market?: string }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const s = await ctx.lending("none").borrowStatus(ctx.account, opts.market);
    out(cmd, { account: ctx.account, ...lendingJson(s) }, borrowHuman(s));
  });
  marketOpt(borrow.command("collateral").description("Pledge fund shares from the wallet (or `all`): approve + supplyCollateral; claim them from the fund first (`vault claim`)").argument("<shares|all>").option("--send", "broadcast instead of dry run")).action(async (shares: string, opts: { market?: string; send?: boolean }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    requireOwner(ctx);
    const plan = await ctx.lending("owner").planSupplyCollateral({ shares, marketId: opts.market });
    await runLendingPlan(cmd, ctx, plan, opts.send);
  });
  marketOpt(borrow.command("take").description(`Borrow USDG against the pledged shares; refused below health factor 1 or without an oracle price, warns above ${LTV_WARN_FRACTION * 100}% of the LLTV`).argument("<usdg>").option("--receiver <address>", "recipient; default: the owner address").option("--send", "broadcast instead of dry run")).action(async (usdg: string, opts: { market?: string; receiver?: string; send?: boolean }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    requireOwner(ctx);
    const plan = await ctx.lending("owner").planBorrow({ usdgRaw: parseUsdg(usdg), receiver: opts.receiver as Address | undefined, marketId: opts.market });
    await runLendingPlan(cmd, ctx, plan, opts.send);
  });
  marketOpt(borrow.command("repay").description("Repay USDG debt (an amount, or `all` = by borrow shares, exact): approve + repay").argument("<usdg|all>").option("--send", "broadcast instead of dry run")).action(async (usdg: string, opts: { market?: string; send?: boolean }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    requireOwner(ctx);
    const plan = await ctx.lending("owner").planRepay({ usdg, marketId: opts.market });
    await runLendingPlan(cmd, ctx, plan, opts.send);
  });
  marketOpt(borrow.command("withdraw-collateral").description("Take pledged shares back (an amount, or `all` once the debt is repaid); the health factor after must stay >= 1").argument("<shares|all>").option("--receiver <address>", "recipient; default: the owner address").option("--send", "broadcast instead of dry run")).action(async (shares: string, opts: { market?: string; receiver?: string; send?: boolean }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    requireOwner(ctx);
    const plan = await ctx.lending("owner").planWithdrawCollateral({ shares, receiver: opts.receiver as Address | undefined, marketId: opts.market });
    await runLendingPlan(cmd, ctx, plan, opts.send);
  });
}

export { privateKeyToAccount };
