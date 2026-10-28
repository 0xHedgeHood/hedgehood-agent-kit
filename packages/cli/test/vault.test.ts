import { afterEach, describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildProgram } from "../src/cli.js";
import { EPOCH4, ONE, VAULT, fakeWorld, withGlobalFetch } from "../../mcp/test/fakes.js";

const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0, throwaway
const owner = privateKeyToAccount(OWNER_KEY);
const API = "https://app.test/api/stockyield/funds";

/** Runs the CLI against the fake node / API; `asOwner` loads the owner key and makes the account the owner (what the fund requires). */
async function run(args: string[], opts: { world?: ReturnType<typeof fakeWorld>; asOwner?: boolean } = {}) {
  const world = opts.world ?? fakeWorld();
  let captured = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    captured += s;
    return true;
  }) as typeof process.stdout.write;
  const prev = { ...process.env };
  delete process.env.HEDGEHOOD_SESSION_KEY_FILE;
  if (opts.asOwner) process.env.HEDGEHOOD_OWNER_KEY = OWNER_KEY;
  else delete process.env.HEDGEHOOD_OWNER_KEY;
  const globals = ["--rfq-url", "https://rfq.test", "--indexer-url", "https://index.test", "--vault-api-url", API, ...(opts.asOwner ? ["--account", owner.address] : [])];
  try {
    await withGlobalFetch(world.fetch, () => buildProgram().exitOverride().parseAsync(["node", "hedgehood", ...globals, ...args]));
  } finally {
    process.stdout.write = orig;
    process.env = prev;
  }
  return { text: captured, world };
}

const json = (t: string) => JSON.parse(t) as Record<string, unknown>;
const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

afterEach(() => {
  process.exitCode = undefined;
});

describe("hedgehood vaults / vault", () => {
  it("vaults prints the table without any key and the account columns with one", async () => {
    const anon = (await run(["vaults"])).text;
    expect(anon).toMatch(/fund\s+epoch\s+next freeze \(UTC\)\s+NAV\/share\s+NAV USDG\s+cap used\s+last wk/);
    expect(anon).toMatch(new RegExp(`hhNVDA-CC\\s+locked\\s+${iso(EPOCH4.depositCutoff)}\\s+205\\.70625\\s+20570\\.625\\s+20570\\.625/100000\\s+0\\.75%`));
    expect(anon).not.toMatch(/my shares/);
    const mine = (await run(["vaults"], { asOwner: true })).text;
    expect(mine).toMatch(/my shares\s+pending\s+claimable/);
    expect(mine).toMatch(/hhNVDA-CC\s+locked.*\s+5\s+-\s+-/);
    const j = json((await run(["vaults", "--json"], { asOwner: true })).text);
    const v = (j.vaults as Array<Record<string, unknown>>)[0]!;
    expect(v.symbol).toBe("hhNVDA-CC");
    expect(v.vault).toBe(VAULT);
    expect((v.nav as Record<string, unknown>).usdgPerShare).toBe("205.70625");
    expect((v.epoch as Record<string, unknown>).state).toBe("locked");
    expect((v.my as Record<string, unknown>).sharesRaw).toBe((5n * ONE).toString());
    expect(j.api).toBe(API);
  });

  it("vault status shows queues and claimables", async () => {
    const world = fakeWorld();
    world.chain.vault.account = { depositEpoch: 4n, depositStock: 0n, depositUsdg: 25_000_000n, redeemEpoch: 0n, redeemShares: 0n };
    world.chain.vault.preview = [0n, 0n, 3_000_000n];
    const { text } = await run(["vault", "status", "--vault", "NVDA-CC"], { world, asOwner: true });
    expect(text).toContain(`account ${owner.address}`);
    expect(text).toMatch(/shares 5\s+pending dep 25 USDG \(e4\)\s+claimable 0 stk \+ 3 USDG/);
    expect(text).toMatch(/wallet 1000 USDG, 2 NVDA\s+canDeposit true/);
  });

  it("vault deposit needs the owner key, plans approve + requestDeposit and is a dry run without --send", async () => {
    await expect(run(["vault", "deposit", "25", "--vault", "hhNVDA-CC"])).rejects.toThrow(/owner key/);
    const { text, world } = await run(["vault", "deposit", "25", "--vault", "hhNVDA-CC"], { asOwner: true });
    expect(text).toMatch(/deposit 25 USDG into hhNVDA-CC/);
    expect(text).toMatch(/DRY RUN \(simulation passed\): approve\(/);
    expect(text).toMatch(/DRY RUN \(not simulated: needs the approval above mined first\): requestDeposit\(0 stock, 25 USDG/);
    expect(text).toContain("add --send to broadcast");
    expect(world.chain.simulated).toHaveLength(1);
    const j = json((await run(["vault", "deposit", "25", "--vault", VAULT, "--json"], { asOwner: true })).text);
    const steps = j.steps as Array<Record<string, unknown>>;
    expect(j.dryRun).toBe(true);
    expect(steps.map((s) => [s.kind, s.simulated])).toEqual([["approve", true], ["requestDeposit", false]]);
    expect(String(steps[1]!.data).startsWith(toFunctionSelector("requestDeposit(uint256,uint256,address)"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
    // stock-only deposit
    const s = json((await run(["vault", "deposit", "0", "--vault", "NVDA", "--stock", "0.5", "--json"], { asOwner: true })).text);
    expect((s.steps as Array<Record<string, unknown>>).map((x) => x.kind)).toEqual(["approve", "requestDeposit"]);
    expect(s.summary).toMatch(/deposit 0.5 stock/);
  });

  it("vault redeem all / claim / cancel build the account's calls and refuse what cannot be done", async () => {
    const j = json((await run(["vault", "redeem", "all", "--vault", "hhNVDA-CC", "--json"], { asOwner: true })).text);
    const step = (j.steps as Array<Record<string, unknown>>)[0]!;
    expect(String(step.data).startsWith(toFunctionSelector("requestRedeem(uint256,address)"))).toBe(true);
    expect(step.simulated).toBe(true);
    expect(j.summary).toMatch(/redeem 5 of 5 hhNVDA-CC/);
    await expect(run(["vault", "redeem", "9", "--vault", "hhNVDA-CC"], { asOwner: true })).rejects.toThrow(/holds 5/);
    await expect(run(["vault", "claim", "--vault", "hhNVDA-CC"], { asOwner: true })).rejects.toThrow(/nothing to claim/);
    const world = fakeWorld();
    world.chain.vault.preview = [0n, ONE / 4n, 1_000_000n];
    world.chain.vault.account = { depositEpoch: 4n, depositStock: 0n, depositUsdg: 5_000_000n, redeemEpoch: 4n, redeemShares: ONE };
    const claim = (await run(["vault", "claim", "--vault", "hhNVDA-CC", "--to", "0x4444444444444444444444444444444444444444"], { world, asOwner: true })).text;
    expect(claim).toMatch(/claim 0.25 stock \+ 1 USDG from hhNVDA-CC to 0x4444/);
    expect(claim).toMatch(/DRY RUN \(simulation passed\): claim\(/);
    const cd = json((await run(["vault", "cancel", "deposit", "--vault", "hhNVDA-CC", "--json"], { world, asOwner: true })).text);
    expect(String((cd.steps as Array<Record<string, unknown>>)[0]!.data).startsWith(toFunctionSelector("cancelDeposit(address,address)"))).toBe(true);
    const cr = json((await run(["vault", "cancel", "redeem", "--vault", "hhNVDA-CC", "--json"], { world, asOwner: true })).text);
    expect(String((cr.steps as Array<Record<string, unknown>>)[0]!.data).startsWith(toFunctionSelector("cancelRedeem(address)"))).toBe(true);
    await expect(run(["vault", "cancel", "both", "--vault", "hhNVDA-CC"], { world, asOwner: true })).rejects.toThrow(/deposit` or `redeem/);
  });
});
