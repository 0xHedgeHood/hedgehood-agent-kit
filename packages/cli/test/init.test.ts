import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import qrcode from "qrcode-generator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getDeployment, type AccountView, type MarketAccountView } from "@hedgehood-io/sdk";
import { buildProgram, initDeps } from "../src/cli.js";
import { authorizedMarkets, ensureKeyFile, marketStatusLines, mcpSnippets, ownerLink, parseMarkets, qr, readyLines, waitForAuthorization, writeSettings, type ChainReader } from "../src/init.js";

const OWNER = "0x00000000000000000000000000000000000000aa" as Address;
const tmp = () => mkdtempSync(join(tmpdir(), "hh-init-"));
const mode = (p: string) => statSync(p).mode & 0o777;

function market(underlying: string, o: Partial<MarketAccountView> = {}): MarketAccountView {
  return { underlying, market: "0x0000000000000000000000000000000000000001", orderBook: "0x0000000000000000000000000000000000000002", settlementToken: "0x0000000000000000000000000000000000000003", collateralRaw: 0n, requirementRaw: 0n, freeCollateralRaw: 0n, allowanceRaw: 0n, expiries: [], openPositions: 0, expiredPositions: 0, canTradeFromBalance: false, ...o };
}

const NOW = 1_800_000_000;
const session = (key: Address, o: { expiresAt?: number; spendLeft?: bigint; scope?: bigint } = {}) => {
  const expiresAt = BigInt(o.expiresAt ?? NOW + 30 * 86400);
  const scope = o.scope ?? 3n;
  return { key, expiresAt, authorizedAt: BigInt(NOW - 60), scope, riskLeft: 0n, spendLeft: o.spendLeft ?? 100_000_000n, canTrade: (scope & 1n) !== 0n, canCancel: (scope & 2n) !== 0n, active: expiresAt > BigInt(NOW) && scope !== 0n };
};

function view(markets: MarketAccountView[], key: Address = "0x00000000000000000000000000000000000000bb"): AccountView {
  return { chainId: 4663, account: OWNER, key, keyRole: "session", asOf: NOW, wallet: [], walletUsdgRaw: 0n, totals: { collateralRaw: 0n, requirementRaw: 0n, freeCollateralRaw: 0n, openPositions: 0, expiredPositions: 0 }, markets, tradable: [], failed: [] };
}

describe("key files", () => {
  it("creates the key once with mode 600 in a 700 directory, then only reads it", () => {
    const dir = join(tmp(), "home");
    const file = join(dir, "session.key");
    const a = ensureKeyFile(file);
    expect(a.created).toBe(true);
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^0x[0-9a-f]{64}\n$/);
    expect(privateKeyToAccount(text.trim() as `0x${string}`).address).toBe(a.address);
    const b = ensureKeyFile(file);
    expect(b).toEqual({ path: file, address: a.address, created: false });
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("refuses an existing key file others can read", () => {
    const file = join(tmp(), "loose.key");
    writeFileSync(file, "0x" + "11".repeat(32));
    chmodSync(file, 0o644);
    expect(() => ensureKeyFile(file)).toThrow(/chmod 600/);
  });

  it("merges settings into a 600 file", () => {
    const file = join(tmp(), "cfg", "config.json");
    writeSettings(file, { chainId: 4663, sessionKeyFile: "/k/session.key" });
    const s = writeSettings(file, { account: OWNER, payerKeyFile: undefined });
    expect(s).toEqual({ chainId: 4663, sessionKeyFile: "/k/session.key", account: OWNER });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(s);
    expect(mode(file)).toBe(0o600);
  });
});

describe("owner link", () => {
  const agent = "0x1D2435f16D4d63Dd12a6d4e992029F7a02f17718" as Address;
  it("carries agent and chain, and the optional markets / maxSpend / days", () => {
    expect(ownerLink({ agent, chainId: 4663 })).toBe(`https://hedgehood.io/options/account?agent=${agent}&chain=4663`);
    const link = ownerLink({ siteUrl: "https://staging.hedgehood.io/", agent, chainId: 46630, markets: ["NVDA", "TSLA"], maxSpend: "100.5", days: 30 });
    expect(link).toBe(`https://staging.hedgehood.io/options/account?agent=${agent}&chain=46630&markets=NVDA,TSLA&maxSpend=100.5&days=30`);
    const u = new URL(link);
    expect(Object.fromEntries(u.searchParams)).toEqual({ agent, chain: "46630", markets: "NVDA,TSLA", maxSpend: "100.5", days: "30" });
  });

  it("validates its inputs", () => {
    expect(() => ownerLink({ agent, chainId: 4663, siteUrl: "hedgehood.io" })).toThrow(/site URL/);
    expect(() => ownerLink({ agent: "0x12" as Address, chainId: 4663 })).toThrow(/address/);
    expect(() => ownerLink({ agent, chainId: 4663, maxSpend: "1e3" })).toThrow(/max-spend/);
    expect(() => ownerLink({ agent, chainId: 4663, days: 0 })).toThrow(/days/);
    expect(parseMarkets(" nvda, TSLA ,nvda", 4663)).toEqual(["NVDA", "TSLA"]);
    expect(parseMarkets(undefined, 4663)).toBeUndefined();
    expect(() => parseMarkets("NVDA,AAPL", 4663)).toThrow(/AAPL not listed/);
  });
});

describe("qr", () => {
  /** The plain rendering back to a module matrix (light modules are drawn), quiet zone stripped. */
  function decodeArt(text: string, n: number, margin = 2): boolean[][] {
    const rows: boolean[][] = [];
    for (const line of text.split("\n")) {
      const top: boolean[] = [];
      const bottom: boolean[] = [];
      for (const ch of line) {
        top.push(!(ch === "█" || ch === "▀"));
        bottom.push(!(ch === "█" || ch === "▄"));
      }
      rows.push(top, bottom);
    }
    return rows.slice(margin, margin + n).map((r) => r.slice(margin, margin + n));
  }

  it("encodes exactly the payload, module for module", () => {
    for (const payload of ["0x1D2435f16D4d63Dd12a6d4e992029F7a02f17718", ownerLink({ agent: "0x1D2435f16D4d63Dd12a6d4e992029F7a02f17718", chainId: 4663, markets: ["NVDA", "TSLA", "MU", "GOOGL", "CRCL", "MSTR", "AMD"], maxSpend: "1000", days: 30 })]) {
      const code = qr(payload);
      expect(code.payload).toBe(payload);
      const ref = qrcode(0, "M");
      ref.addData(payload, "Byte");
      ref.make();
      expect(code.size).toBe(ref.getModuleCount());
      const m = decodeArt(code.text, code.size);
      for (let r = 0; r < code.size; r++) for (let c = 0; c < code.size; c++) expect(m[r]![c], `${r},${c}`).toBe(ref.isDark(r, c));
      const lines = code.text.split("\n");
      expect(lines.length).toBe(Math.ceil((code.size + 4) / 2));
      expect(new Set(lines.map((l) => [...l].length))).toEqual(new Set([code.size + 4]));
    }
  });

  it("colour output wraps every line", () => {
    const t = qr("0x00000000000000000000000000000000000000aa", { ansi: true }).text;
    for (const l of t.split("\n")) expect(l).toMatch(/^\x1b\[30;107m.*\x1b\[0m$/);
  });
});

describe("mcp snippets", () => {
  it("names the key paths and the owner, never a key", () => {
    const s = mcpSnippets({ chainId: 4663, sessionKeyFile: "/Users/a b/.hedgehood/session.key", payerKeyFile: "/h/payer.key", account: OWNER, hostedMcpUrl: "https://mcp.hedgehood.io/mcp" });
    expect(s.claudeCode).toBe(`claude mcp add hedgehood -e HEDGEHOOD_CHAIN_ID=4663 -e 'HEDGEHOOD_SESSION_KEY_FILE=/Users/a b/.hedgehood/session.key' -e HEDGEHOOD_PAYER_KEY_FILE=/h/payer.key -e HEDGEHOOD_ACCOUNT=${OWNER} -- npx -y @hedgehood-io/mcp`);
    expect(s.json.mcpServers.hedgehood.env).toEqual({ HEDGEHOOD_CHAIN_ID: "4663", HEDGEHOOD_SESSION_KEY_FILE: "/Users/a b/.hedgehood/session.key", HEDGEHOOD_PAYER_KEY_FILE: "/h/payer.key", HEDGEHOOD_ACCOUNT: OWNER });
    expect(s.hostedClaudeCode).toBe("claude mcp add --transport http hedgehood-readonly https://mcp.hedgehood.io/mcp");
    const noOwner = mcpSnippets({ chainId: 46630, sessionKeyFile: "/k", hostedMcpUrl: "x" });
    expect(noOwner.env).toEqual({ HEDGEHOOD_CHAIN_ID: "46630", HEDGEHOOD_SESSION_KEY_FILE: "/k", HEDGEHOOD_ACCOUNT: "<owner wallet address>" });
  });
});

describe("waitForAuthorization", () => {
  const key = "0x00000000000000000000000000000000000000bb" as Address;
  const fakeClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("polls through unauthorized views and read errors until a market is authorized", async () => {
    const seq: Array<AccountView | Error> = [view([market("NVDA"), market("TSLA")]), new Error("rpc down"), view([market("NVDA", { session: session(key, { expiresAt: NOW - 1 }) })]), view([market("NVDA"), market("TSLA", { session: session(key), collateralRaw: 25_000_000n, freeCollateralRaw: 25_000_000n })])];
    const ticks: string[] = [];
    const clock = fakeClock();
    const r = await waitForAuthorization({ read: async () => { const v = seq.shift()!; if (v instanceof Error) throw v; return v; }, intervalMs: 10_000, timeoutMs: 600_000, ...clock, onTick: (v, e) => ticks.push(v ? "view" : String(e)) });
    expect(r.status).toBe("ready");
    expect(r.authorized).toEqual(["TSLA"]);
    expect(r.polls).toBe(4);
    expect(ticks).toEqual(["view", "Error: rpc down", "view", "view"]);
    expect(clock.now()).toBe(30_000);
  });

  it("times out, and stops on abort", async () => {
    const clock = fakeClock();
    const r = await waitForAuthorization({ read: async () => view([market("NVDA")]), intervalMs: 10_000, timeoutMs: 25_000, ...clock });
    expect(r).toMatchObject({ status: "timeout", authorized: [], polls: 4 });
    expect(clock.now()).toBe(25_000);
    const ac = new AbortController();
    let n = 0;
    const a = await waitForAuthorization({ read: async () => { if (++n === 2) ac.abort(); return view([market("NVDA")]); }, intervalMs: 5, timeoutMs: 60_000, signal: ac.signal });
    expect(a.status).toBe("aborted");
    expect(n).toBe(2);
  });

  it("an authorization without the trade scope does not count", () => {
    const v = view([market("NVDA", { session: session(key, { scope: 2n }) })]);
    expect(authorizedMarkets(v)).toEqual([]);
    expect(marketStatusLines(v)[0]).toContain("authorized without the trade scope");
  });
});

describe("status lines", () => {
  const key = "0x00000000000000000000000000000000000000bb" as Address;
  it("per market: authorization, budgets, expiry, balance", () => {
    const v = view([market("NVDA", { session: session(key), collateralRaw: 25_000_000n, freeCollateralRaw: 20_000_000n }), market("TSLA"), market("MU", { session: session(key, { expiresAt: NOW - 5 }) }), market("AMD", { error: "execution reverted" })]);
    expect(marketStatusLines(v)).toEqual([
      "NVDA  authorized   spend left 100  short risk left none (0)  until 2027-02-14 08:00Z  balance 25 (free 20)",
      "TSLA  not authorized  balance 0 (free 0)",
      "MU    expired 2027-01-15 07:59Z  balance 0 (free 0)",
      "AMD   read failed: execution reverted",
    ]);
    const ready = readyLines(v, "NVDA-20261106-205-C");
    expect(ready[0]).toBe(`READY: the agent can trade NVDA for ${OWNER}`);
    expect(ready).toContain("  hedgehood quote NVDA-20261106-205-C --side buy --qty 1");
    expect(ready).toContain("  hedgehood fill --instrument NVDA-20261106-205-C --side buy --qty 1 --send");
    const empty = readyLines(view([market("TSLA", { session: session(key) })]));
    expect(empty.join("\n")).toContain("hedgehood markets --underlying TSLA");
    expect(empty.join("\n")).toContain("hedgehood deposit 25 --market TSLA --send");
  });
});

describe("hedgehood init / status (CLI)", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const VARS = ["HEDGEHOOD_HOME", "HEDGEHOOD_CONFIG", "HEDGEHOOD_CHAIN_ID", "HEDGEHOOD_ACCOUNT", "HEDGEHOOD_SESSION_KEY", "HEDGEHOOD_SESSION_KEY_FILE", "HEDGEHOOD_PAYER_KEY", "HEDGEHOOD_PAYER_KEY_FILE", "HEDGEHOOD_SITE_URL"];
  const realReader = initDeps.chainReader;
  let reads: { usdg: Address[]; views: Array<[Address, Address]>; next: (key: Address) => AccountView };

  beforeEach(() => {
    home = join(tmp(), ".hedgehood");
    for (const v of VARS) saved[v] = process.env[v];
    for (const v of VARS) delete process.env[v];
    process.env.HEDGEHOOD_HOME = home;
    reads = { usdg: [], views: [], next: (key) => view([market("NVDA"), market("TSLA")], key) };
    initDeps.chainReader = (chainId): ChainReader => {
      expect([4663, 46630]).toContain(chainId);
      return {
        usdgBalance: async (a) => (reads.usdg.push(a), 12_500_000n),
        accountView: async (account, key) => (reads.views.push([account, key]), reads.next(key)),
        sampleInstrument: async (u) => `${u}-20261106-205-C`,
      };
    };
  });
  afterEach(() => {
    initDeps.chainReader = realReader;
    for (const v of VARS) if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
    process.exitCode = undefined;
  });

  async function run(args: string[]) {
    let text = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => ((text += s), true)) as typeof process.stdout.write;
    try {
      await buildProgram().exitOverride().parseAsync(["node", "hedgehood", ...args]);
    } finally {
      process.stdout.write = orig;
    }
    return text;
  }

  it("creates both keys, saves the settings, prints link + QR + MCP config, and is idempotent", async () => {
    const t = await run(["init", "--mainnet", "--account", OWNER, "--with-payer", "--markets", "nvda,tsla", "--max-spend", "100", "--days", "30"]);
    const sessionKey = readFileSync(join(home, "session.key"), "utf8").trim();
    const payerKey = readFileSync(join(home, "payer.key"), "utf8").trim();
    const sessionAddr = privateKeyToAccount(sessionKey as `0x${string}`).address;
    const payerAddr = privateKeyToAccount(payerKey as `0x${string}`).address;
    expect(mode(join(home, "session.key"))).toBe(0o600);
    expect(mode(join(home, "payer.key"))).toBe(0o600);
    expect(t).not.toContain(sessionKey.slice(2));
    expect(t).not.toContain(payerKey.slice(2));
    expect(t).toContain("Robinhood Chain mainnet (4663)");
    expect(t).toContain(`address ${sessionAddr}`);
    expect(t).toContain(`address ${payerAddr}`);
    expect(t).toContain("USDG balance 12.5");
    expect(t).toContain("No ETH needed");
    expect(t).toContain(`https://hedgehood.io/options/account?agent=${sessionAddr}&chain=4663&markets=NVDA,TSLA&maxSpend=100&days=30`);
    expect(t).toContain(`claude mcp add hedgehood -e HEDGEHOOD_CHAIN_ID=4663 -e HEDGEHOOD_SESSION_KEY_FILE=${join(home, "session.key")} -e HEDGEHOOD_PAYER_KEY_FILE=${join(home, "payer.key")} -e HEDGEHOOD_ACCOUNT=${OWNER} -- npx -y @hedgehood-io/mcp`);
    expect(t).toContain(getDeployment(4663).api.mcp);
    expect(t).toContain("█");
    expect(t).toContain("NVDA  not authorized");
    expect(reads.usdg).toEqual([payerAddr]);
    expect(reads.views).toEqual([[OWNER, sessionAddr]]);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual({ chainId: 4663, account: OWNER, sessionKeyFile: join(home, "session.key"), payerKeyFile: join(home, "payer.key") });
    expect(mode(join(home, "config.json"))).toBe(0o600);

    // second run, no flags: the settings file supplies chain, owner and both key files; the keys are kept
    const j = JSON.parse(await run(["--json", "init", "--no-qr"]));
    expect(j).toMatchObject({ chainId: 4663, account: OWNER, session: { address: sessionAddr, created: false }, payer: { address: payerAddr, created: false, usdgRaw: "12500000" }, ownerLink: `https://hedgehood.io/options/account?agent=${sessionAddr}&chain=4663` });
    expect(readFileSync(join(home, "session.key"), "utf8").trim()).toBe(sessionKey);
  });

  it("without --account still creates the key and says where to set the owner later; no payer unless asked", async () => {
    const t = await run(["init", "--testnet", "--no-qr"]);
    expect(t).toContain("owner account not set: re-run with --account 0xYourWallet");
    expect(t).toContain("&chain=46630");
    expect(t).not.toContain("payment wallet");
    expect(t).not.toContain("█");
    expect(reads.views).toEqual([]);
    expect(() => statSync(join(home, "payer.key"))).toThrow();
    await expect(run(["init", "--wait"])).rejects.toThrow(/--wait needs the owner address/);
  });

  it("refuses the session key as the owner account", async () => {
    await run(["init", "--no-qr"]);
    const addr = privateKeyToAccount(readFileSync(join(home, "session.key"), "utf8").trim() as `0x${string}`).address;
    await expect(run(["init", "--account", addr])).rejects.toThrow(/not the agent's session key/);
  });

  it("--wait polls until the owner authorizes, then prints READY and a first trade", async () => {
    let n = 0;
    reads.next = (key) => (++n < 2 ? view([market("NVDA"), market("TSLA")], key) : view([market("NVDA"), market("TSLA", { session: session(key), collateralRaw: 25_000_000n, freeCollateralRaw: 25_000_000n })], key));
    const t = await run(["init", "--mainnet", "--account", OWNER, "--no-qr", "--wait", "--interval", "0.01", "--timeout", "5"]);
    expect(t).toContain("waiting for the owner to authorize");
    expect(t).toContain(`READY: the agent can trade TSLA for ${OWNER}`);
    expect(t).toContain("hedgehood fill --instrument TSLA-20261106-205-C --side buy --qty 1 --send");
    expect(process.exitCode).toBeUndefined();
  });

  it("--wait times out with exit code 1", async () => {
    const t = await run(["init", "--mainnet", "--account", OWNER, "--no-qr", "--wait", "--interval", "0.01", "--timeout", "0.03"]);
    expect(t).toContain("not authorized after");
    expect(process.exitCode).toBe(1);
  });

  it("status shows owner, session key, payer with USDG and per-market state; --qr re-prints the codes", async () => {
    await run(["init", "--mainnet", "--account", OWNER, "--with-payer", "--no-qr"]);
    reads.next = (key) => view([market("NVDA", { session: session(key), collateralRaw: 25_000_000n, freeCollateralRaw: 25_000_000n }), market("TSLA")], key);
    const t = await run(["status"]);
    expect(t).toContain("chain 4663 (mainnet)");
    expect(t).toContain(`owner account   ${OWNER}`);
    expect(t).toMatch(/payment wallet {2}0x[0-9a-fA-F]{40} {2}USDG 12\.5/);
    expect(t).toContain("NVDA  authorized   spend left 100");
    expect(t).toContain("authorized on NVDA");
    expect(t).not.toContain("█");
    const q = await run(["status", "--qr"]);
    expect(q.split("owner link (scan").length).toBe(2);
    expect(q).toContain("█");
    const j = JSON.parse(await run(["--json", "status"]));
    expect(j).toMatchObject({ chainId: 4663, account: OWNER, authorized: ["NVDA"], payerUsdgRaw: "12500000" });
  });

  it("precedence: flags > environment > settings file", async () => {
    await run(["init", "--mainnet", "--account", OWNER, "--no-qr"]);
    expect(JSON.parse(await run(["--json", "status"])).chainId).toBe(4663);
    process.env.HEDGEHOOD_CHAIN_ID = "46630";
    process.env.HEDGEHOOD_ACCOUNT = "0x00000000000000000000000000000000000000cc";
    const env = JSON.parse(await run(["--json", "status"]));
    expect(env).toMatchObject({ chainId: 46630, account: "0x00000000000000000000000000000000000000cc" });
    const flag = JSON.parse(await run(["--json", "--mainnet", "--account", "0x00000000000000000000000000000000000000dd", "status"]));
    expect(flag).toMatchObject({ chainId: 4663, account: "0x00000000000000000000000000000000000000dd" });
    process.env.HEDGEHOOD_CONFIG = "off";
    delete process.env.HEDGEHOOD_CHAIN_ID;
    delete process.env.HEDGEHOOD_ACCOUNT;
    const off = JSON.parse(await run(["--json", "status"]));
    expect(off.settingsFile).toBeNull();
    expect(off.chainId).toBe(46630);
  });
});
