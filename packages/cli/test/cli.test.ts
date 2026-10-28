import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, parseSince } from "../src/cli.js";
import { ACCOUNT, NAME210P, NAME220C, fakeWorld, withGlobalFetch } from "../../mcp/test/fakes.js";

const SESSION_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const GLOBALS = ["--account", ACCOUNT, "--rfq-url", "https://rfq.test", "--indexer-url", "https://index.test"];

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
    expect(names).toEqual(["close", "decode", "deposit", "fill", "history", "instruments", "join", "markets", "pnl", "positions", "quote", "redeem", "register", "session", "vault", "vaults", "withdraw"]);
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
    expect(text).toMatch(/DRY RUN \(simulation passed\): fillOrderAs/);
    expect(text).toContain("add --send to broadcast");
    expect(world.backend.find((b) => b.url.pathname === "/v1/rfq")!.body).toMatchObject({ instrument: NAME220C, side: "sell", quantity: "1", taker: ACCOUNT });
    expect(world.chain.simulated.length).toBe(1);
    // partial close of the short put: buy back 0.2, capped by --qty; --json is one object
    const r = await run(["close", NAME210P, "--qty", "0.2", "--json"]);
    const j = json(r.text);
    expect(j).toMatchObject({ instrument: NAME210P, side: "buy", positionRaw: "-500000000000000000", quantityRaw: "200000000000000000", remainingRaw: "-300000000000000000", dryRun: true, fillable: true });
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
});
