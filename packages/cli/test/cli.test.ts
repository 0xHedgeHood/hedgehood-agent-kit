import { afterEach, describe, expect, it } from "vitest";
import { decodeFunctionData, type Hex } from "viem";
import { marketV2Abi, UNLIMITED } from "@hedgehood-io/sdk";
import { buildProgram, parseCap, parseSince } from "../src/cli.js";
import { ACCOUNT, NAME210P, NAME220C, NVDA_M, TEST_USD, defaultChain, fakeWorld, withGlobalFetch } from "../../mcp/test/fakes.js";

const SESSION_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const GLOBALS = ["--account", ACCOUNT, "--rfq-url", "https://rfq.test", "--indexer-url", "https://index.test"];

const OWNER_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

/** Runs the CLI with the owner key in the environment as well. */
async function runAsOwner(args: string[], world = fakeWorld()) {
  const prev = process.env.HEDGEHOOD_OWNER_KEY;
  process.env.HEDGEHOOD_OWNER_KEY = OWNER_KEY;
  try {
    return await run(args, world);
  } finally {
    if (prev === undefined) delete process.env.HEDGEHOOD_OWNER_KEY;
    else process.env.HEDGEHOOD_OWNER_KEY = prev;
  }
}

/** Runs the CLI against the fake node / maker / indexer and returns what it printed. */
async function run(args: string[], world = fakeWorld()) {
  let captured = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    captured += s;
    return true;
  }) as typeof process.stdout.write;
  const prevKey = process.env.HEDGEHOOD_SESSION_KEY;
  process.env.HEDGEHOOD_SESSION_KEY = SESSION_KEY;
  try {
    await withGlobalFetch(world.fetch, () => buildProgram().exitOverride().parseAsync(["node", "hedgehood", ...GLOBALS, ...args]));
  } finally {
    process.stdout.write = orig;
    if (prevKey === undefined) delete process.env.HEDGEHOOD_SESSION_KEY;
    else process.env.HEDGEHOOD_SESSION_KEY = prevKey;
  }
  return { text: captured, world };
}

const json = (t: string) => JSON.parse(t) as Record<string, unknown>;

afterEach(() => {
  process.exitCode = undefined;
});

describe("hedgehood cli", () => {
  it("registers the documented commands", () => {
    const p = buildProgram();
    const names = p.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["borrow", "close", "decode", "deposit", "faucet", "fill", "history", "instruments", "join", "lend", "markets", "pnl", "positions", "quote", "redeem", "register", "session", "vault", "vaults", "withdraw"]);
    const lend = p.commands.find((c) => c.name() === "lend")!;
    expect(lend.commands.map((c) => c.name()).sort()).toEqual(["deposit", "status", "withdraw"]);
    const borrow = p.commands.find((c) => c.name() === "borrow")!;
    expect(borrow.commands.map((c) => c.name()).sort()).toEqual(["collateral", "repay", "status", "take", "withdraw-collateral"]);
    for (const name of ["collateral", "repay", "take", "withdraw-collateral"]) expect(borrow.commands.find((c) => c.name() === name)!.options.some((o) => o.long === "--send"), name).toBe(true);
    const session = p.commands.find((c) => c.name() === "session")!;
    expect(session.commands.map((c) => c.name()).sort()).toEqual(["authorize", "revoke", "status"]);
    const vault = p.commands.find((c) => c.name() === "vault")!;
    expect(vault.commands.map((c) => c.name()).sort()).toEqual(["cancel", "claim", "deposit", "redeem", "status"]);
    for (const name of ["cancel", "claim", "deposit", "redeem"]) expect(vault.commands.find((c) => c.name() === name)!.options.some((o) => o.long === "--send"), name).toBe(true);
  });

  it("every sending command is dry run unless --send", () => {
    const p = buildProgram();
    for (const name of ["join", "fill", "close", "deposit", "redeem", "withdraw", "register"]) {
      const c = p.commands.find((x) => x.name() === name)!;
      expect(c.options.some((o) => o.long === "--send"), name).toBe(true);
    }
  });

  it("decode prints the instrument", async () => {
    const { text } = await run(["decode", "142087026062721526102620822511099174400"]);
    expect(text).toContain("2026-10-30 220 C");
    expect(text).toContain("expiry 1793390400");
  });

  it("parses --since as ISO or unix", () => {
    expect(parseSince("2026-01-01T00:00:00Z")).toBe(1767225600);
    expect(parseSince("1767225600")).toBe(1767225600);
    expect(parseSince("1767225600000")).toBe(1767225600);
    expect(() => parseSince("last tuesday")).toThrow(/--since/);
  });

  it("pnl prints the table and the totals; --json is the indexer's view", async () => {
    const human = (await run(["pnl"])).text;
    expect(human).toMatch(/instrument\s+qty\s+avg\s+mark\s+unrealized/);
    expect(human).toMatch(new RegExp(`${NAME220C}\\s+1\\s+1\\.68\\s+1\\.625\\s+-0\\.055`));
    expect(human).toMatch(new RegExp(`${NAME210P}\\s+-0\\.5\\s+0\\.8\\s+0\\.7\\s+\\+0\\.05`));
    expect(human).toContain("realized +1.2  unrealized -0.005  fees 0.0124  total +1.1826");
    const { text, world } = await run(["pnl", "--json"]);
    const j = json(text);
    expect(j.totalRaw).toBe("1182600");
    expect((j.positions as unknown[]).length).toBe(2);
    expect(world.backend[0]!.url.toString()).toBe(`https://index.test/v1/pnl?account=${ACCOUNT}`);
  });

  it("history lists events newest first and passes --limit / --since to the indexer", async () => {
    const { text, world } = await run(["history", "--limit", "3", "--since", "2026-01-01"]);
    expect(world.backend[0]!.url.searchParams.get("limit")).toBe("3");
    expect(world.backend[0]!.url.searchParams.get("since")).toBe(String(parseSince("2026-01-01")));
    const lines = text.trim().split("\n");
    expect(lines[0]).toContain("3 event(s)");
    expect(lines[1]).toMatch(new RegExp(`fill\\s+buy\\s+1 ${NAME220C} @ 1\\.68\\s+premium 1\\.68\\s+fee 0\\.0084`));
    expect(lines[2]).toMatch(/fill\s+sell\s+0\.5/);
    expect(lines[3]).toMatch(/settlement\s+NVDA-20261023-200-C @ 212\.5\s+payout \+1\.25/);
    const j = json((await run(["history", "--json", "--limit", "1"])).text);
    expect((j.events as Array<{ type: string }>).map((e) => e.type)).toEqual(["fill"]);
  });

  it("positions shows avg, mark, unrealized and time to expiry per row and keeps the raw fields in --json", async () => {
    const { text } = await run(["positions"]);
    expect(text).toMatch(/instrument\s+qty\s+avg\s+mark\s+unrealized\s+expires in\s+id/);
    expect(text).toMatch(new RegExp(`${NAME220C}\\s+\\+1\\s+1\\.68\\s+1\\.625\\s+-0\\.055\\s+(expired|\\d+d \\d+h|\\d+h \\d+m|\\d+m)`));
    expect(text).toContain("pnl: realized +1.2  unrealized -0.005  fees 0.0124  total +1.1826");
    expect(text).toMatch(/session 0x[0-9a-fA-F]{40} ACTIVE/);
    const j = json((await run(["positions", "--json"])).text);
    expect(j.collateralRaw).toBe("100000000");
    const rows = j.positions as Array<Record<string, unknown>>;
    expect(rows[1]).toMatchObject({ quantityRaw: "1000000000000000000", strike: "220000000", isPut: false, instrument: NAME220C, avgPrice: "1.68", mark: 1.625, unrealized: "-0.055", unrealizedRaw: "-55000" });
    expect(typeof rows[1]!.expiresIn).toBe("string");
    expect(typeof rows[1]!.secondsToExpiry).toBe("number");
    expect((j.pnl as Record<string, unknown>).totalRaw).toBe("1182600");
    // indexer down: the on-chain rows still print, the P&L columns are blank
    const down = await run(["positions"], fakeWorld({ indexerDown: true }));
    expect(down.text).toContain("pnl: indexer unavailable");
    expect(down.text).toMatch(new RegExp(`${NAME220C}\\s+\\+1\\s+-\\s+-\\s+-\\s+`));
  });

  it("close quotes the opposite side of the on-chain position and is a dry run without --send", async () => {
    const { text, world } = await run(["close", NAME220C]);
    expect(text).toMatch(/close NVDA-20261030-220-C: position \+1 -> sell 1 \(remaining 0\)/);
    expect(text).toMatch(/price\/share 1\.57 .*you receive 1\.56215/);
    expect(text).toMatch(/session charge: 0 USDG from the short-risk budget \(sells a long the account holds: free\); left none \(0\)\n/);
    expect(text).toMatch(/DRY RUN \(simulation passed\): fillOrderAs/);
    expect(text).toContain("add --send to broadcast");
    expect(world.backend.find((b) => b.url.pathname === "/v1/rfq")!.body).toMatchObject({ instrument: NAME220C, side: "sell", quantity: "1", taker: ACCOUNT });
    expect(world.chain.simulated.length).toBe(1);
    // partial close of the short put: buy back 0.2, capped by --qty; --json is one object
    const r = await run(["close", NAME210P, "--qty", "0.2", "--json"]);
    const j = json(r.text);
    expect(j).toMatchObject({ instrument: NAME210P, side: "buy", positionRaw: "-500000000000000000", quantityRaw: "200000000000000000", remainingRaw: "-300000000000000000", dryRun: true, fillable: true });
    expect(j.sessionCharge).toMatchObject({ budget: "spend", closedShortRaw: "200000000000000000", chargeRaw: "0", leftRaw: "40000000", withinBudget: true });
    expect(String(j.data).startsWith("0x18943a04")).toBe(true);
    expect(r.world.backend.find((b) => b.url.pathname === "/v1/rfq")!.body).toMatchObject({ side: "buy", quantity: "0.2" });
    // oversize --qty is capped at the position
    expect(json((await run(["close", NAME220C, "--qty", "9", "--json"])).text).quantityRaw).toBe("1000000000000000000");
  });

  it("close --all closes every open position and reports per instrument; a desk dry-run quote is refused, nothing simulated", async () => {
    const { text, world } = await run(["close", "--all", "--json"]);
    const j = json(text);
    expect(j.dryRun).toBe(true);
    const closed = j.closed as Array<Record<string, unknown>>;
    expect(closed.map((c) => [c.instrument, c.side, c.quantityRaw])).toEqual([[NAME210P, "buy", "500000000000000000"], [NAME220C, "sell", "1000000000000000000"]]);
    expect(world.chain.simulated.length).toBe(2);
    expect(process.exitCode).toBeUndefined();
    await expect(run(["close", NAME220C], fakeWorld({ quoteDryRun: true }))).rejects.toThrow(/dry-run quote/);
    const dry = await run(["close", "--all"], fakeWorld({ quoteDryRun: true }));
    expect(dry.text).toMatch(/FAILED .*dry-run quote/);
    expect(dry.world.chain.simulated.length).toBe(0);
    expect(process.exitCode).toBe(1);
    await expect(run(["close"])).rejects.toThrow(/give an instrument, or --all/);
    await expect(run(["close", NAME220C, "--all"])).rejects.toThrow(/--all takes no instrument/);
  });

  it("session authorize requires --max-spend, maps unlimited to max uint and defaults --max-short-risk to 0", async () => {
    await expect(run(["session", "authorize"])).rejects.toThrow(/--max-spend is required.*Suggested: --max-spend 100/);
    expect(parseCap("unlimited", "--x")).toBe(UNLIMITED);
    expect(parseCap("12.5", "--x")).toBe(12_500_000n);
    expect(() => parseCap("lots", "--max-spend")).toThrow(/--max-spend must be a USDG amount or "unlimited"/);
    const args = (data: string) => decodeFunctionData({ abi: marketV2Abi, data: data as Hex }).args as readonly unknown[];
    const budget = json((await runAsOwner(["session", "authorize", "--max-spend", "100", "--json"])).text);
    expect(budget.dryRun).toBe(true);
    expect(args(String(budget.data)).slice(2)).toEqual([3n, 0n, 100_000_000n]);
    const open = await runAsOwner(["session", "authorize", "--max-spend", "unlimited", "--max-short-risk", "unlimited", "--no-cancel"]);
    expect(open.text).toMatch(/DRY RUN .*maxShortRisk unlimited, maxSpend unlimited/);
    expect(args(open.world.chain.simulated[0]!).slice(2)).toEqual([1n, UNLIMITED, UNLIMITED]);
    const risk = json((await runAsOwner(["session", "authorize", "--max-spend", "0", "--max-short-risk", "59.5", "--json"])).text);
    expect(args(String(risk.data)).slice(3)).toEqual([59_500_000n, 0n]);
    expect(() => parseCap("-1", "--max-short-risk")).toThrow(/--max-short-risk must be a USDG amount/);
    // join with the owner key needs it too; without the owner key it prints the 5-argument cast command
    await expect(runAsOwner(["join"])).rejects.toThrow(/--max-spend is required/);
    const joined = await run(["join"]);
    expect(joined.text).toMatch(/authorizeSession\(address,uint64,uint256,uint256,uint256\)' 0x[0-9a-fA-F]{40} \d+ 3 0 <maxSpendRaw>/);
    expect(joined.text).toMatch(/maxShortRisk: summed worst-case payout/);
    expect((await run(["join", "--max-short-risk", "100", "--max-spend", "5"])).text).toMatch(/' 0x[0-9a-fA-F]{40} \d+ 3 100000000 5000000 --rpc-url/);
  });

  it("--max-requirement is gone: session authorize and join refuse it with a pointer to --max-short-risk", async () => {
    await expect(runAsOwner(["session", "authorize", "--max-spend", "100", "--max-requirement", "0"])).rejects.toThrow(/--max-requirement was removed .*--max-short-risk/);
    await expect(run(["join", "--max-requirement", "unlimited"])).rejects.toThrow(/--max-requirement was removed/);
    const authorize = buildProgram().commands.find((c) => c.name() === "session")!.commands.find((c) => c.name() === "authorize")!;
    expect(authorize.helpInformation()).toMatch(/--max-short-risk <usdg\|unlimited>/);
    expect(authorize.helpInformation()).not.toMatch(/--max-requirement/);
  });

  it("quote and fill show the session charge of the leg; a sell to open beyond riskLeft is flagged", async () => {
    // the fixture session: riskLeft 0, spendLeft 40; long 1 call 220 (caps 150.5 / 279.5: worst case 59.5)
    const sell = await run(["quote", NAME220C, "--side", "sell", "--qty", "2"]);
    expect(sell.text).toMatch(/session charge: 59\.5 USDG from the short-risk budget \(opens a short of 1 sh \(worst case 59\.5\/token\)\); left none \(0\) -> the fill will revert SessionLimit/);
    const j = json((await run(["quote", NAME220C, "--side", "buy", "--json"])).text);
    expect(j.sessionCharge).toMatchObject({ side: "buy", budget: "spend", chargeRaw: "1688400", leftRaw: "40000000", withinBudget: true });
    const fill = await run(["fill", "--instrument", NAME220C, "--side", "buy"]);
    expect(fill.text).toMatch(/session charge: 1\.6884 USDG from the spend budget \(buys to open: charged premium \+ fee in full\); left 40\n/);
    // the market's SessionLimit names the budget the leg draws
    const w = fakeWorld();
    w.chain.fillRevert = "SessionLimit";
    await expect(run(["fill", "--instrument", NAME220C, "--side", "sell", "--qty", "2"], w)).rejects.toThrow(/reverted SessionLimit: this sell leg draws 59\.5 USDG from the short-risk budget \(riskLeft, authorized as maxShortRisk\), none \(0\) left/);
  });

  it("session status and positions show riskLeft, spendLeft and authorizedAt", async () => {
    const chain = defaultChain();
    chain.session = [4_000_000_000n, 1_790_000_000n, 3n, UNLIMITED, 42_500_000n];
    const { text } = await run(["session", "status"], fakeWorld({ chain }));
    expect(text).toMatch(/ACTIVE trade=true cancel=true authorized 2026-09-21T14:13:20Z until 2096-10-02T07:06:40Z riskLeft unlimited spendLeft 42\.5/);
    expect(text).toMatch(/balance mode only; shorts it opens come out of riskLeft/);
    const j = json((await run(["session", "status", "--json"], fakeWorld({ chain }))).text);
    expect(j).toMatchObject({ authorizedAt: "1790000000", riskLeft: UNLIMITED.toString(), spendLeft: "42500000" });
    expect(j).not.toHaveProperty("maxRequirement");
    const spent = defaultChain();
    spent.session = [4_000_000_000n, 1_790_000_000n, 1n, 7_250_000n, 0n];
    expect((await run(["positions"], fakeWorld({ chain: spent }))).text).toMatch(/riskLeft 7\.25 spendLeft none \(0\)/);
  });

  it("names, quotes and decodes by the listed per-share strike under NVDA's mainnet uiMultiplier", async () => {
    const world = () => fakeWorld({ chain: { ...defaultChain(), uiMultiplier: NVDA_M } });
    const inst = await run(["instruments", "1793390400"], world());
    expect(inst.text.split("\n").filter(Boolean).map((l) => l.split(" ")[0])).toEqual(["NVDA-20261030-210-C", "NVDA-20261030-210-P", "NVDA-20261030-220-C", "NVDA-20261030-220-P"]);
    const q = await run(["quote", "NVDA-20261030-220-C", "--side", "buy", "--json"], world());
    const quote = json(q.text);
    const id = (BigInt(1793390400) << 96n) | (220_170_535n << 1n);
    expect((quote.order as Record<string, unknown>).instrumentId).toBe(id.toString());
    expect(q.world.backend.find((b) => b.url.pathname === "/v1/rfq")!.body).toMatchObject({ instrument: "NVDA-20261030-220-C" });
    const byStrike = json((await run(["quote", "1793390400:220:call", "--side", "buy", "--json"], world())).text);
    expect((byStrike.order as Record<string, unknown>).instrumentId).toBe(id.toString());
    const d = await run(["decode", id.toString()], world());
    expect(d.text).toMatch(/2026-10-30 220 C .*strike 220 \(per token 220\.170535, uiMultiplier 1\.000775159164630595\)/);
    const offline = await run(["decode", id.toString(), "--multiplier", NVDA_M.toString()]);
    expect(offline.text).toMatch(/strike 220 /);
  });
});

describe("hedgehood faucet (testnet)", () => {
  it("dry runs faucet() from the owner wallet and refuses during the cooldown", async () => {
    const { text, world } = await runAsOwner(["--json", "faucet"]);
    expect(json(text)).toMatchObject({ dryRun: true, to: TEST_USD, data: "0xde5f72fd" });
    expect(world.chain.faucet.calls).toEqual(["0xde5f72fd"]);
    const cool = fakeWorld();
    cool.chain.faucet.nextFaucetAt = cool.chain.vault.now + 60n;
    const r = await runAsOwner(["--json", "faucet", "--send"], cool);
    expect(String(json(r.text).refused)).toMatch(/cooldown/);
    expect(cool.chain.faucet.calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it("is refused on mainnet", async () => {
    await expect(runAsOwner(["--mainnet", "faucet"])).rejects.toThrow(/no faucet on Robinhood Chain mainnet/);
  });
});
