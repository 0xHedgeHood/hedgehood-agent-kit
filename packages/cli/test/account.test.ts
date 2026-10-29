import { afterEach, describe, expect, it } from "vitest";
import { decodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, instrumentName, marketV2Abi, orderBookV2Abi } from "@hedgehood-io/sdk";
import { buildProgram } from "../src/cli.js";
import { AMD_MARKET, EXPIRY, GOOGL_BOOK, GOOGL_MARKET, MARKET, NAME220C, fakeWorld, multiMarketChain, withGlobalFetch, type FakeWorld } from "../../mcp/test/fakes.js";

const SESSION_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const OWNER_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const owner = privateKeyToAccount(OWNER_KEY);
const GOOGL220C = instrumentName("GOOGL", EXPIRY, 220_000_000n, false);
const abi = [...marketV2Abi, ...orderBookV2Abi, ...erc20Abi];
const GLOBALS = ["--account", owner.address, "--rfq-url", "https://rfq.test", "--indexer-url", "https://index.test"];

/** Runs the CLI with only the session key, or only the owner key (the account itself), against the fakes. */
async function run(as: "session" | "owner", args: string[], world: FakeWorld) {
  let captured = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    captured += s;
    return true;
  }) as typeof process.stdout.write;
  const prev = { s: process.env.HEDGEHOOD_SESSION_KEY, o: process.env.HEDGEHOOD_OWNER_KEY };
  if (as === "session") process.env.HEDGEHOOD_SESSION_KEY = SESSION_KEY;
  else process.env.HEDGEHOOD_OWNER_KEY = OWNER_KEY;
  try {
    await withGlobalFetch(world.fetch, () => buildProgram().exitOverride().parseAsync(["node", "hedgehood", ...GLOBALS, ...args]));
  } finally {
    process.stdout.write = orig;
    for (const [k, v] of [["HEDGEHOOD_SESSION_KEY", prev.s], ["HEDGEHOOD_OWNER_KEY", prev.o]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return captured;
}

const steps = (t: string) => (JSON.parse(t) as { steps: Array<{ kind: string; to: string; data: Hex; simulated: boolean }> }).steps;

afterEach(() => {
  process.exitCode = undefined;
});

describe("hedgehood account / one wallet, all markets", () => {
  it("account prints every market, the totals, where the session key can trade and the market it could not read", async () => {
    const world = fakeWorld({ chain: multiMarketChain() });
    const text = await run("session", ["account"], world);
    expect(text).toMatch(/wallet 500 USDG/);
    expect(text).toMatch(/NVDA\s+250\s+10\s+240\s+2\s+0\s+active, spend 40\s+yes/);
    expect(text).toMatch(/AMD\s+30\s+0\s+30\s+0\s+0\s+inactive\s+no/);
    expect(text).toMatch(/GOOGL\s+0\s+0\s+0\s+0\s+0\s+none\s+no/);
    expect(text).toMatch(/TSLA\s+ERROR/);
    expect(text).toMatch(/total collateral 280  locked 10  free 270  open positions 2/);
    expect(text).toMatch(/the session key can fill from the balance in: NVDA/);
    expect(text).toMatch(/not read: TSLA/);
    const j = JSON.parse(await run("session", ["account", "--json"], world));
    expect(j.tradable).toEqual(["NVDA"]);
    expect(j.markets).toHaveLength(20);
  });

  it("owner fill defaults to wallet mode: the dry run lists approve then fill, and --from-balance --auto-deposit deposits first", async () => {
    const world = fakeWorld({ chain: multiMarketChain() });
    const text = await run("owner", ["fill", "--instrument", GOOGL220C, "--side", "buy"], world);
    expect(text).toMatch(/funding: wallet mode: the GOOGL market pulls up to 1\.6884 USDG from the wallet; approve -> fill/);
    expect(text).toMatch(/2 transactions would be sent, in this order:/);
    expect(text).toMatch(/\[1\/2\] DRY RUN \(simulation passed\): approve\(0x8b51467DB7a822c10286059199bd2574Baa19De8, 1688400\)/);
    expect(text).toMatch(/\[2\/2\] DRY RUN \(not simulated: needs the approval above mined first\): fillOrderAs\(.*fromBalance=false\)/);
    const j = steps(await run("owner", ["fill", "--instrument", GOOGL220C, "--side", "buy", "--approve", "max", "--json"], world));
    expect(j[1]!.to).toBe(GOOGL_BOOK);
    expect(decodeFunctionData({ abi, data: j[0]!.data }).args![1]).toBe((1n << 256n) - 1n);
    const auto = steps(await run("owner", ["fill", "--instrument", GOOGL220C, "--side", "buy", "--from-balance", "--auto-deposit", "--json"], world));
    expect(auto.map((s) => s.kind)).toEqual(["approve", "deposit", "fill"]);
    expect(decodeFunctionData({ abi, data: auto[1]!.data }).args).toEqual([owner.address, 1_688_400n]);
    await expect(run("owner", ["fill", "--instrument", GOOGL220C, "--side", "buy", "--from-balance"], world)).rejects.toThrow(/GOOGL market balance is short by 1\.6884 USDG.*--auto-deposit/);
    // a close from the owner key is wallet mode too
    const close = steps(await run("owner", ["close", NAME220C, "--json"], world));
    expect(close.map((s) => s.kind)).toEqual(["fill"]);
    expect(decodeFunctionData({ abi, data: close[0]!.data }).args![4]).toBe(false);
  });

  it("a session fill in a market without balance is refused with the owner's command; where funded it fills from the balance", async () => {
    const world = fakeWorld({ chain: multiMarketChain() });
    await expect(run("session", ["fill", "--instrument", GOOGL220C, "--side", "buy"], world)).rejects.toThrow(
      /refused: the GOOGL market balance is short by 1\.6884 USDG .*NVDA 240, AMD 30.*hedgehood rebalance --from NVDA --to GOOGL --amount 1\.6884 --send.*hedgehood deposit 1\.6884 --market GOOGL --wallet --send/,
    );
    expect(world.chain.simulated).toHaveLength(0);
    await expect(run("session", ["fill", "--instrument", GOOGL220C, "--side", "buy", "--auto-deposit"], world)).rejects.toThrow(/--auto-deposit needs the account's own key/);
    const ok = await run("session", ["fill", "--instrument", NAME220C, "--side", "buy"], world);
    expect(ok).toMatch(/DRY RUN \(simulation passed\): fillOrderAs\(.*fromBalance=true\)/);
  });

  it("withdraw --all, rebalance and deposit --market plan owner transactions and stay dry runs", async () => {
    const world = fakeWorld({ chain: multiMarketChain() });
    const all = await run("owner", ["withdraw", "--all"], world);
    expect(all).toMatch(/withdraw 270 USDG free balance from 2 market\(s\) \(NVDA, AMD\).*skipped: TSLA/);
    expect(all).toMatch(/\[1\/2\] DRY RUN \(simulation passed\): withdraw\(240000000 USDG raw.*\[NVDA\]/);
    expect(all).toMatch(/\[2\/2\] DRY RUN \(simulation passed\): withdraw\(30000000 USDG raw.*\[AMD\]/);
    expect(all).toContain("add --send to broadcast");
    expect(steps(await run("owner", ["withdraw", "--all", "--json"], world)).map((s) => s.to)).toEqual([MARKET, AMD_MARKET]);
    const rb = steps(await run("owner", ["rebalance", "--from", "NVDA", "--to", "GOOGL", "--amount", "12.5", "--json"], world));
    expect(rb.map((s) => [s.kind, s.to, s.simulated])).toEqual([["withdraw", MARKET, true], ["approve", "0x850DE815d41F6983Aaf09247f9a465c0aefff04C", true], ["deposit", GOOGL_MARKET, false]]);
    await expect(run("owner", ["rebalance", "--from", "AMD", "--to", "GOOGL", "--amount", "31"], world)).rejects.toThrow(/AMD market has 30 USDG free/);
    const dep = steps(await run("owner", ["deposit", "5", "--market", "GOOGL", "--wallet", "--json"], world));
    expect(dep.map((s) => [s.kind, s.to])).toEqual([["approve", "0x850DE815d41F6983Aaf09247f9a465c0aefff04C"], ["deposit", GOOGL_MARKET]]);
    await expect(run("session", ["withdraw", "--all"], world)).rejects.toThrow(/owner key/);
    await expect(run("session", ["rebalance", "--from", "NVDA", "--to", "AMD", "--amount", "1"], world)).rejects.toThrow(/owner key/);
  });
});
