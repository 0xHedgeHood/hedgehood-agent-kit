import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import qrcode from "qrcode-generator";
import { createPublicClient, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chains, erc20Abi, formatSessionCap, formatUsdg, getDeployment, instrumentName, MarketClient, readAccount, type AccountView, type MarketAccountView } from "@hedgehood-io/sdk";
import { readKeyFile, readSettings, type SettingsFile } from "@hedgehood-io/mcp";

/**
 * `hedgehood init` / `hedgehood status` building blocks ("mode A": the human owns the account in their own wallet; the
 * agent holds a session key the owner authorizes per market with a budget, and optionally a separate payment wallet
 * that funds the owner's market balances over x402). Pure helpers plus a small chain reader the commands inject, so
 * every piece is testable without a node.
 */

export const DEFAULT_SITE_URL = "https://hedgehood.io";
/** The site page that reads `agent`, `chain`, `markets`, `maxSpend`, `days` and asks the owner's wallet to authorize. */
export const AUTHORIZE_PATH = "/options/account";

export interface KeyFileInfo {
  path: string;
  address: Address;
  created: boolean;
}

/**
 * The key in `path`, created (0x + 64 hex, mode 600, parent directory 700) when the file does not exist. An existing
 * file is only read (and refused when group/world-readable): never overwritten. The private key is never returned.
 */
export function ensureKeyFile(path: string): KeyFileInfo {
  let created = false;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, generatePrivateKey() + "\n", { mode: 0o600, flag: "wx" });
      created = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (created) chmodSync(path, 0o600);
  }
  return { path, address: privateKeyToAccount(readKeyFile(path)).address, created };
}

/** Merges `patch` into the settings file (mode 600) and returns the result. Undefined fields are left as they were. */
export function writeSettings(path: string, patch: SettingsFile): SettingsFile {
  const next: SettingsFile = { ...readSettings(path) };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return next;
}

export interface OwnerLinkParams {
  siteUrl?: string;
  /** The agent's session key address. */
  agent: Address;
  chainId: number;
  /** Tickers to preselect (validated against the chain's markets). */
  markets?: string[];
  /** Suggested spend budget, USDG (decimal). */
  maxSpend?: string;
  /** Suggested session validity in days. */
  days?: number;
}

/** Tickers from "nvda, TSLA" -> ["NVDA", "TSLA"], refusing tickers the chain does not list. */
export function parseMarkets(v: string | undefined, chainId: number): string[] | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const listed = getDeployment(chainId).markets.map((m) => m.underlying.toUpperCase());
  const out = [...new Set(v.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const unknown = out.filter((t) => !listed.includes(t));
  if (unknown.length) throw new Error(`--markets: ${unknown.join(", ")} not listed on chain ${chainId} (listed: ${listed.join(" ")})`);
  return out;
}

/**
 * The owner's authorize link: `<site>/options/account?agent=<session key>&chain=<id>[&markets=NVDA,TSLA][&maxSpend=100][&days=30]`.
 * Values are percent-encoded except the commas between tickers.
 */
export function ownerLink(p: OwnerLinkParams): string {
  const base = (p.siteUrl ?? DEFAULT_SITE_URL).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/?#]+/i.test(base)) throw new Error(`site URL must be http(s)://host, got ${p.siteUrl}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.agent)) throw new Error(`agent must be an address, got ${p.agent}`);
  const q: Array<[string, string]> = [["agent", p.agent], ["chain", String(p.chainId)]];
  if (p.markets?.length) q.push(["markets", p.markets.join(",")]);
  if (p.maxSpend !== undefined) {
    if (!/^\d+(\.\d{1,6})?$/.test(p.maxSpend)) throw new Error(`--max-spend must be a USDG amount, got ${p.maxSpend}`);
    q.push(["maxSpend", p.maxSpend]);
  }
  if (p.days !== undefined) {
    if (!Number.isInteger(p.days) || p.days < 1 || p.days > 365) throw new Error(`--days must be a whole number from 1 to 365, got ${p.days}`);
    q.push(["days", String(p.days)]);
  }
  return `${base}${AUTHORIZE_PATH}?${q.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/gi, ",")}`).join("&")}`;
}

export interface QrCode {
  /** Exactly what the code encodes. */
  payload: string;
  /** Modules per side, without the quiet zone. */
  size: number;
  /** Terminal rendering: two module rows per text line. */
  text: string;
}

/**
 * A QR code (error correction M) for the terminal. With `ansi` (a colour TTY) it draws dark modules black on a white
 * background, which scans on light and dark themes alike; without colour it draws the light modules as blocks, the
 * qrcode-terminal convention for dark terminals.
 */
export function qr(payload: string, opts: { ansi?: boolean; margin?: number } = {}): QrCode {
  const code = qrcode(0, "M");
  code.addData(payload, "Byte");
  code.make();
  const n = code.getModuleCount();
  const margin = opts.margin ?? 2;
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && code.isDark(r, c);
  const lines: string[] = [];
  for (let r = -margin; r < n + margin; r += 2) {
    let line = "";
    for (let c = -margin; c < n + margin; c++) {
      const bottomInside = r + 1 < n + margin;
      let top = dark(r, c);
      let bottom = bottomInside && dark(r + 1, c);
      if (!opts.ansi) {
        top = !top;
        bottom = bottomInside ? !bottom : false;
      }
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(opts.ansi ? `\x1b[30;107m${line}\x1b[0m` : line);
  }
  return { payload, size: n, text: lines.join("\n") };
}

export interface McpSnippetParams {
  chainId: number;
  sessionKeyFile: string;
  payerKeyFile?: string;
  account?: Address;
  hostedMcpUrl: string;
}

export interface McpSnippets {
  env: Record<string, string>;
  claudeCode: string;
  json: { mcpServers: { hedgehood: { command: string; args: string[]; env: Record<string, string> } } };
  hosted: string;
  hostedClaudeCode: string;
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** MCP config for Claude Code, Claude Desktop / Cursor (JSON) and the hosted read-only server. Key paths only, never keys. */
export function mcpSnippets(p: McpSnippetParams): McpSnippets {
  const env: Record<string, string> = { HEDGEHOOD_CHAIN_ID: String(p.chainId), HEDGEHOOD_SESSION_KEY_FILE: p.sessionKeyFile };
  if (p.payerKeyFile) env.HEDGEHOOD_PAYER_KEY_FILE = p.payerKeyFile;
  env.HEDGEHOOD_ACCOUNT = p.account ?? "<owner wallet address>";
  const claudeCode = `claude mcp add hedgehood ${Object.entries(env).map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`).join(" ")} -- npx -y @hedgehood-io/mcp`;
  return {
    env,
    claudeCode,
    json: { mcpServers: { hedgehood: { command: "npx", args: ["-y", "@hedgehood-io/mcp"], env } } },
    hosted: p.hostedMcpUrl,
    hostedClaudeCode: `claude mcp add --transport http hedgehood-readonly ${p.hostedMcpUrl}`,
  };
}

/** What `init`, `status` and `--wait` read from the chain; injectable for tests. */
export interface ChainReader {
  accountView(account: Address, key: Address): Promise<AccountView>;
  usdgBalance(address: Address): Promise<bigint>;
  /** A call instrument of the nearest open expiry with a strike near the middle, for the sample command. */
  sampleInstrument?(underlying: string): Promise<string | undefined>;
}

export function chainReader(chainId: number, rpcUrl?: string): ChainReader {
  const chain = chains[chainId];
  if (!chain) throw new Error(`unsupported chain id ${chainId}`);
  const dep = getDeployment(chainId);
  const client = createPublicClient({ chain, transport: http(rpcUrl ?? chain.rpcUrls.default.http[0]!, { batch: true }) });
  return {
    accountView: (account, key) => readAccount({ chainId, rpcUrl, account, key, markets: dep.markets }),
    usdgBalance: (address) => client.readContract({ address: dep.usdg, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    async sampleInstrument(underlying) {
      const deployment = dep.markets.find((m) => m.underlying.toUpperCase() === underlying.toUpperCase());
      if (!deployment) return undefined;
      const m = new MarketClient({ chainId, rpcUrl, deployment, account: "0x0000000000000000000000000000000000000000" });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const expiries = (await m.openedExpiries()).filter((e) => e > now).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const e of expiries) {
        const info = await m.expiryInfo(e);
        if (!info.tradingOpen || info.strikes.length === 0) continue;
        const strike = info.strikes[Math.floor(info.strikes.length / 2)]!;
        return instrumentName(deployment.underlying, info.expiry, strike, false, info.uiMultiplier);
      }
      return undefined;
    },
  };
}

const day = (t: bigint) => new Date(Number(t) * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z";

/** A market the session key can trade in now: an active session with the TRADE scope. */
export const isAuthorized = (m: MarketAccountView) => !!m.session?.active && m.session.canTrade;

export function authorizedMarkets(view: AccountView): string[] {
  return view.markets.filter(isAuthorized).map((m) => m.underlying);
}

/** One line per market: authorization, budgets left, expiry, balance. */
export function marketStatusLines(view: AccountView): string[] {
  const w = Math.max(4, ...view.markets.map((m) => m.underlying.length));
  return view.markets.map((m) => {
    const name = m.underlying.padEnd(w);
    if (m.error) return `${name}  read failed: ${m.error}`;
    const s = m.session;
    const auth = isAuthorized(m)
      ? `authorized   spend left ${formatSessionCap(s!.spendLeft)}  short risk left ${formatSessionCap(s!.riskLeft)}  until ${day(s!.expiresAt)}`
      : s && s.expiresAt !== 0n && s.expiresAt <= BigInt(view.asOf)
        ? `expired ${day(s.expiresAt)}`
        : s && s.expiresAt !== 0n
          ? "authorized without the trade scope"
          : "not authorized";
    return `${name}  ${auth}  balance ${formatUsdg(m.collateralRaw)} (free ${formatUsdg(m.freeCollateralRaw)})`;
  });
}

export interface WaitOptions {
  read: () => Promise<AccountView>;
  intervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Default: a timer that ends early on `signal`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Default Date.now. */
  now?: () => number;
  /** Each poll: the view (or the read error). */
  onTick?: (view: AccountView | undefined, error?: unknown) => void;
}

export interface WaitResult {
  status: "ready" | "timeout" | "aborted";
  view?: AccountView;
  /** Markets the key can trade in (status "ready": at least one). */
  authorized: string[];
  polls: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Polls until the session key is authorized (TRADE, unexpired) on at least one market, the timeout, or `signal`. Read errors keep polling. */
export async function waitForAuthorization(o: WaitOptions): Promise<WaitResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const deadline = now() + o.timeoutMs;
  let view: AccountView | undefined;
  let polls = 0;
  for (;;) {
    if (o.signal?.aborted) return { status: "aborted", view, authorized: view ? authorizedMarkets(view) : [], polls };
    try {
      view = await o.read();
      polls++;
      o.onTick?.(view);
      const authorized = authorizedMarkets(view);
      if (authorized.length) return { status: "ready", view, authorized, polls };
    } catch (e) {
      polls++;
      o.onTick?.(undefined, e);
    }
    if (o.signal?.aborted) return { status: "aborted", view, authorized: [], polls };
    const left = deadline - now();
    if (left <= 0) return { status: "timeout", view, authorized: [], polls };
    await sleep(Math.min(o.intervalMs, left), o.signal);
  }
}

/** The "ready" block: what the key can trade and a first quote + buy of 1 share. */
export function readyLines(view: AccountView, sample?: string): string[] {
  const ready = view.markets.filter(isAuthorized);
  const first = ready.find((m) => m.freeCollateralRaw > 0n) ?? ready[0]!;
  const u = first.underlying;
  const inst = sample ?? `<${u} instrument, e.g. ${u}-YYYYMMDD-STRIKE-C>`;
  const lines = [
    `READY: the agent can trade ${ready.map((m) => m.underlying).join(" ")} for ${view.account}`,
    "first trade (quotes in US regular hours; week 1: at most 2 shares per option, 2.5 per underlying, opening premium >= 5 USDG):",
    `  hedgehood quote ${inst} --side buy --qty 1`,
    `  hedgehood fill --instrument ${inst} --side buy --qty 1 --send`,
  ];
  if (!sample) lines.push(`  (list instruments: hedgehood markets --underlying ${u})`);
  if (first.freeCollateralRaw === 0n) lines.push(`the ${u} balance is empty: the owner deposits on the site, or the payment wallet pays one in: hedgehood deposit 25 --market ${u} --send`);
  return lines;
}
