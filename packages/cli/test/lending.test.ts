import { afterEach, describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildProgram } from "../src/cli.js";
import { LEND_BLUE, LEND_MARKET_ID, LEND_MARKET_ID_2, LEND_PARAMS_2, LEND_VAULT, fakeWorld, withGlobalFetch } from "../../mcp/test/fakes.js";

const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0, throwaway
const owner = privateKeyToAccount(OWNER_KEY);

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
  const globals = ["--rfq-url", "https://rfq.test", "--indexer-url", "https://index.test", ...(opts.asOwner ? ["--account", owner.address] : [])];
  try {
    await withGlobalFetch(world.fetch, () => buildProgram().exitOverride().parseAsync(["node", "hedgehood", ...globals, ...args]));
  } finally {
    process.stdout.write = orig;
    process.env = prev;
  }
  return { text: captured, world };
}

const json = (t: string) => JSON.parse(t) as Record<string, unknown>;
const steps = (j: Record<string, unknown>) => j.steps as Array<Record<string, unknown>>;

afterEach(() => {
  process.exitCode = undefined;
});

describe("hedgehood lend / borrow", () => {
  it("lend status works without a key and shows the account's shares with one", async () => {
    const anon = (await run(["lend", "status"])).text;
    expect(anon).toMatch(/hhUSDG 0x6ab0.*total 1500 USDG\s+idle 0\s+supplied 1500\s+cap 100000 \(room 98500\)/);
    expect(anon).toMatch(/supply rate 0.47%\s+utilization 44.67%\s+withdrawable now 830\s+performance fee 10.00%/);
    expect(anon).toMatch(new RegExp(`market ${LEND_MARKET_ID}\\s+borrow rate 1.16%`));
    expect(anon).toMatch(/oracle 0x1291.* live 0.95 USDG\/share \(stock 217\)/);
    expect(anon).not.toMatch(/\bmy\b/);
    const mine = (await run(["lend", "status"], { asOwner: true })).text;
    expect(mine).toMatch(/my 100 hhUSDG = 100 USDG\s+wallet 1000 USDG\s+canDeposit true\s+canWithdraw true/);
    const j = json((await run(["lend", "status", "--json"], { asOwner: true })).text);
    expect(j.vault).toBe(LEND_VAULT);
    expect(j.totalAssetsRaw).toBe("1500000000");
    expect((j.my as Record<string, unknown>).sharesRaw).toBe("100000000000000000000");
    expect(j.supplyApy).toBeCloseTo(0.00466, 4);
  });

  it("borrow status shows the market, the oracle and the position; --market picks another", async () => {
    const world = fakeWorld();
    world.chain.lending.position.borrowShares = 40_000_000_000_000n;
    const { text } = await run(["borrow", "status"], { world, asOwner: true });
    expect(text).toMatch(new RegExp(`market ${LEND_MARKET_ID} \\(the vault's liquidity market\\)\\s+LLTV 62.50%`));
    expect(text).toMatch(/borrow rate 1.16% APR\s+utilization 44.67%\s+supplied 1500\s+borrowed 670\s+available 830/);
    expect(text).toMatch(/my collateral 100 shares = 95 USDG\s+debt 40 USDG\s+max borrow 59.375\s+borrowable 19.375 \(recommended 1.5625\)/);
    expect(text).toMatch(/health factor 1.4843\s+LTV 42.10%\s+liquidation at 0.64 USDG\/share\s+wallet 5 shares, 1000 USDG/);
    const j = json((await run(["borrow", "status", "--market", LEND_MARKET_ID_2, "--json"], { world, asOwner: true })).text);
    expect((j.market as Record<string, unknown>).id).toBe(LEND_MARKET_ID_2);
    expect((j.market as Record<string, unknown>).oracle).toBe(LEND_PARAMS_2.oracle);
    expect((j.my as Record<string, unknown>).collateralRaw).toBe("0");
  });

  it("lend deposit / withdraw need the owner key and are dry runs without --send", async () => {
    await expect(run(["lend", "deposit", "25"])).rejects.toThrow(/owner key/);
    const { text, world } = await run(["lend", "deposit", "25"], { asOwner: true });
    expect(text).toMatch(/lend 25 USDG into hhUSDG/);
    expect(text).toMatch(/DRY RUN \(simulation passed\): approve\(/);
    expect(text).toMatch(/DRY RUN \(not simulated: needs the approval above mined first\): deposit\(25 USDG/);
    expect(text).toContain("add --send to broadcast");
    expect(world.chain.simulated).toHaveLength(1);
    const j = json((await run(["lend", "withdraw", "all", "--json"], { asOwner: true })).text);
    expect(j.dryRun).toBe(true);
    expect(j.action).toBe("lendWithdraw");
    expect(steps(j).map((s) => s.kind)).toEqual(["redeem"]);
    expect(String(steps(j)[0]!.data).startsWith(toFunctionSelector("redeem(uint256,address,address)"))).toBe(true);
    const part = json((await run(["lend", "withdraw", "40", "--json"], { asOwner: true })).text);
    expect(String(steps(part)[0]!.data).startsWith(toFunctionSelector("withdraw(uint256,address,address)"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("borrow collateral / take / repay / withdraw-collateral build Blue calls, print HF and LTV, and refuse unsafe actions", async () => {
    const coll = json((await run(["borrow", "collateral", "all", "--json"], { asOwner: true })).text);
    expect(steps(coll).map((s) => [s.kind, s.to])).toEqual([["approve", "0x2a7CC7E34a1CFAda9e3aeA978e805dbaB05D83b4"], ["supplyCollateral", LEND_BLUE]]);
    expect(coll.market).toBe(LEND_MARKET_ID);
    const take = await run(["borrow", "take", "50"], { asOwner: true });
    expect(take.text).toMatch(/borrow 50 USDG against 100 fund shares/);
    expect(take.text).toMatch(/! WARNING: LTV after 52.63% is above 70% of the LLTV/);
    expect(take.text).toMatch(/after: collateral 100 shares, debt 50 USDG, health factor 1.1875, LTV 52.63%, liquidation at 0.8 USDG\/share/);
    expect(take.text).toMatch(/DRY RUN \(simulation passed\): borrow\(/);
    await expect(run(["borrow", "take", "60"], { asOwner: true })).rejects.toThrow(/health factor 0.9895 < 1/);
    const world = fakeWorld();
    world.chain.lending.position.borrowShares = 40_000_000_000_000n;
    const repay = json((await run(["borrow", "repay", "all", "--json"], { world, asOwner: true })).text);
    expect(steps(repay).map((s) => s.kind)).toEqual(["approve", "repay"]);
    expect(String(steps(repay)[1]!.data).startsWith(toFunctionSelector("repay((address,address,address,address,uint256),uint256,uint256,address,bytes)"))).toBe(true);
    const wc = (await run(["borrow", "withdraw-collateral", "30"], { world, asOwner: true })).text;
    expect(wc).toMatch(/withdraw 30 of 100 collateral shares/);
    expect(wc).toMatch(/health factor 1.039/);
    await expect(run(["borrow", "withdraw-collateral", "all"], { world, asOwner: true })).rejects.toThrow(/repay first/);
    world.chain.lending.oraclePrice = null;
    await expect(run(["borrow", "take", "1"], { world, asOwner: true })).rejects.toThrow(/no usable price/);
    await expect(run(["borrow", "repay", "1", "--json"], { world, asOwner: true })).resolves.toBeDefined();
  });
});
