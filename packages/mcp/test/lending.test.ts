import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createContext } from "../src/context.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { LEND_BLUE, LEND_MARKET_ID, LEND_MARKET_ID_2, LEND_ORACLE, LEND_PARAMS_2, LEND_VAULT, ONE, VAULT_NOW, VAULT_USDG, fakeWorld, type FakeWorld } from "./fakes.js";

const SESSION_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0, throwaway
const owner = privateKeyToAccount(OWNER_KEY);

async function connect(world: FakeWorld, env: Record<string, string> = {}) {
  const config = loadConfig({ HEDGEHOOD_CHAIN_ID: "46630", HEDGEHOOD_SESSION_KEY: SESSION_KEY, HEDGEHOOD_RFQ_URL: "https://rfq.test", HEDGEHOOD_INDEXER_URL: "https://index.test", ...env });
  const ctx = createContext(config, { fetch: world.fetch });
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { client, ctx };
}

const asOwner = { HEDGEHOOD_OWNER_KEY: OWNER_KEY, HEDGEHOOD_ACCOUNT: owner.address };

function text(r: Awaited<ReturnType<Client["callTool"]>>): string {
  const c = (r.content as Array<{ type: string; text?: string }>)[0];
  return c?.text ?? "";
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { r, body: r.isError ? undefined : JSON.parse(text(r)), txt: text(r) };
};
const WRITES = ["lend_deposit", "lend_withdraw", "borrow_supply_collateral", "borrow_take", "borrow_repay", "borrow_withdraw_collateral"] as const;

describe("share lending tools", () => {
  it("registers the eight tools; the writes carry confirm + dryRun and the non-US / weekly-mark / HF notes", async () => {
    const { client } = await connect(fakeWorld());
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const n of ["lend_status", "lend_deposit", "lend_withdraw", "borrow_status", "borrow_supply_collateral", "borrow_take", "borrow_repay", "borrow_withdraw_collateral"]) expect(names).toContain(n);
    expect(tools).toHaveLength(33);
    for (const w of WRITES) {
      const t = tools.find((x) => x.name === w)!;
      expect(Object.keys(t.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["confirm", "dryRun"]));
      expect(t.description).toMatch(/owner key/i);
    }
    const take = tools.find((x) => x.name === "borrow_take")!.description!;
    expect(take).toMatch(/health factor/);
    expect(take).toMatch(/70% of the LLTV/);
    expect(take).toMatch(/Non-US only/);
    expect(take).toMatch(/marked every week after the Monday lock/);
    expect(tools.find((x) => x.name === "borrow_supply_collateral")!.description).toMatch(/vault_claim/);
    expect(tools.find((x) => x.name === "lend_deposit")!.description).toMatch(/Instant/);
  });

  it("lend_status and borrow_status read the vault-discovered market, format amounts and raw fields, and warn", async () => {
    const world = fakeWorld();
    const { client } = await connect(world, asOwner);
    const lend = (await call(client, "lend_status")).body;
    expect(lend).toMatchObject({ chainId: 46630, vault: LEND_VAULT, symbol: "hhUSDG", asset: VAULT_USDG, totalAssets: "1500", totalAssetsRaw: "1500000000", idle: "0", allocated: "1500", cap: "100000", capLeft: "98500", withdrawableNow: "830", utilization: "44.67%", supplyApy: "0.47%", performanceFee: "10.00%" });
    expect(lend.market).toMatchObject({ id: LEND_MARKET_ID, borrowRate: "1.16%", available: "830" });
    expect(lend.oracle).toMatchObject({ address: LEND_ORACLE, state: "live", collateralPriceUsdgPerShare: "0.95", stockSpot: "217" });
    expect(lend.my).toMatchObject({ account: owner.address, shares: "100", sharesRaw: (100n * ONE).toString(), assets: "100", assetsRaw: "100000000", walletUsdg: "1000", canDeposit: true });
    expect(lend.my.nextAction).toMatch(/lend_withdraw/);
    expect(lend.discovery).toMatch(/read from the vault/);
    expect(lend.note).toMatch(/Non-US only/);

    const borrow = (await call(client, "borrow_status")).body;
    expect(borrow.market).toMatchObject({ id: LEND_MARKET_ID, lltv: "62.50%", lltvRaw: "625000000000000000", collateralPriceUsdgPerShare: "0.95", borrowRate: "1.16%", utilization: "44.67%", totalSupply: "1500", totalBorrow: "670", available: "830", availableRaw: "830000000", isLiquidityMarket: true });
    expect(borrow.market.oracleStatus).toMatchObject({ state: "live", meaning: expect.stringMatching(/own price/) });
    expect(borrow.my).toMatchObject({ collateralShares: "100", collateralValue: "95", debt: "0", maxBorrow: "59.375", borrowable: "59.375", recommendedBorrowable: "41.5625", healthFactor: null, ltv: "0.00%", liquidationPriceUsdgPerShare: null, wallet: { fundShares: "5", usdg: "1000" } });
    expect(borrow.my.nextAction).toMatch(/borrow_take up to 41.5625 USDG/);
    expect(borrow.warnings).toEqual([]);

    world.chain.lending.position.borrowShares = 50_000_000_000_000n;
    const risky = (await call(client, "borrow_status")).body;
    expect(risky.my).toMatchObject({ debt: "50", healthFactor: 1.1875, ltv: "52.63%", liquidationPriceUsdgPerShare: "0.8" });
    expect(risky.warnings[0]).toMatch(/above 70% of the LLTV/);
    world.chain.lending.oraclePrice = null;
    const dark = (await call(client, "borrow_status")).body;
    expect(dark.market.oracleStatus.state).toBe("unavailable");
    expect(dark.my).toMatchObject({ collateralValue: null, healthFactor: null });
    expect(dark.warnings[0]).toMatch(/frozen/);
    // another market by id (a migration target before the switch)
    const other = (await call(client, "borrow_status", { marketId: LEND_MARKET_ID_2 })).body;
    expect(other.market).toMatchObject({ id: LEND_MARKET_ID_2, oracle: LEND_PARAMS_2.oracle, isLiquidityMarket: false });
    // without an account key the reads still work (session only)
    const { client: anon } = await connect(fakeWorld());
    expect((await call(anon, "lend_status")).body.my.account).toBeDefined();
  });

  it("the market follows the vault: after a migration the default market is the new id, no config change", async () => {
    const world = fakeWorld();
    world.chain.lending.liquidityParams = LEND_PARAMS_2;
    world.chain.lending.adapterMarketIds = [LEND_MARKET_ID_2];
    const { client } = await connect(world, asOwner);
    expect((await call(client, "borrow_status")).body.market.id).toBe(LEND_MARKET_ID_2);
    expect((await call(client, "lend_status")).body.market.id).toBe(LEND_MARKET_ID_2);
    const plan = (await call(client, "borrow_supply_collateral", { shares: "1" })).body;
    expect(plan.market.id).toBe(LEND_MARKET_ID_2);
  });

  it("writes need the owner key, explain without confirm, simulate with confirm (dry run), honour HEDGEHOOD_DRY_RUN", async () => {
    const world = fakeWorld();
    world.chain.lending.position.borrowShares = 10_000_000_000_000n;
    const { client: session } = await connect(world);
    for (const [name, args] of [["lend_deposit", { usdg: "25" }], ["lend_withdraw", { usdg: "all" }], ["borrow_supply_collateral", { shares: "1" }], ["borrow_take", { usdg: "1" }], ["borrow_repay", { usdg: "all" }], ["borrow_withdraw_collateral", { shares: "1" }]] as const) {
      const { r, txt } = await call(session, name, { ...args, confirm: true });
      expect(r.isError, name).toBe(true);
      expect(txt, name).toMatch(/owner key/);
    }
    expect(world.chain.simulated).toEqual([]);

    const { client } = await connect(world, asOwner);
    const explain = (await call(client, "lend_deposit", { usdg: "25" })).body;
    expect(explain).toMatchObject({ ok: false, needsConfirm: true, dryRun: true, action: "lendDeposit", account: owner.address });
    expect(explain.steps.map((s: { kind: string }) => s.kind)).toEqual(["approve", "deposit"]);
    expect(explain.steps[1].data.startsWith(toFunctionSelector("deposit(uint256,address)"))).toBe(true);
    expect(explain.steps[1].to).toBe(LEND_VAULT);
    expect(explain.note).toMatch(/instant/);
    expect(world.chain.simulated).toEqual([]);

    const dry = (await call(client, "lend_deposit", { usdg: "25", confirm: true })).body;
    expect(dry).toMatchObject({ ok: true, dryRun: true, from: owner.address });
    expect(dry.steps.map((s: { kind: string; simulated: boolean }) => [s.kind, s.simulated])).toEqual([["approve", true], ["deposit", false]]);
    expect(dry.hint).toMatch(/dryRun: false/);
    expect(world.chain.simulated).toEqual([dry.steps[0].data]);

    const { client: live } = await connect(fakeWorld(), { ...asOwner, HEDGEHOOD_DRY_RUN: "false" });
    expect((await call(live, "lend_withdraw", { usdg: "1" })).body.dryRun).toBe(false);
    expect((await call(live, "lend_withdraw", { usdg: "1", confirm: true, dryRun: true })).body).toMatchObject({ ok: true, dryRun: true });
  });

  it("borrow-side writes build Blue calls with HF / LTV guards and the oracle refusal", async () => {
    const world = fakeWorld();
    const { client } = await connect(world, asOwner);
    const coll = (await call(client, "borrow_supply_collateral", { shares: "all", confirm: true })).body;
    expect(coll.steps.map((s: { kind: string; to: string }) => [s.kind, s.to])).toEqual([["approve", "0x2a7CC7E34a1CFAda9e3aeA978e805dbaB05D83b4"], ["supplyCollateral", LEND_BLUE]]);
    expect(coll.steps[1].data.startsWith(toFunctionSelector("supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)"))).toBe(true);
    expect(coll.after).toMatchObject({ collateralShares: "105", debt: "0" });

    const take = (await call(client, "borrow_take", { usdg: "50", confirm: true })).body;
    expect(take.steps[0].data.startsWith(toFunctionSelector("borrow((address,address,address,address,uint256),uint256,uint256,address,address)"))).toBe(true);
    expect(take.after).toMatchObject({ collateralShares: "100", debt: "50", healthFactor: 1.1875, ltv: "52.63%", liquidationPriceUsdgPerShare: "0.8" });
    expect(take.warnings[0]).toMatch(/WARNING: LTV after 52.63%/);
    const tooMuch = await call(client, "borrow_take", { usdg: "60", confirm: true });
    expect(tooMuch.r.isError).toBe(true);
    expect(tooMuch.txt).toMatch(/health factor 0.9895 < 1/);
    expect(tooMuch.txt).toMatch(/insufficient collateral/);

    world.chain.lending.position.borrowShares = 40_000_000_000_000n;
    const repay = (await call(client, "borrow_repay", { usdg: "all", confirm: true })).body;
    expect(repay.steps.map((s: { kind: string }) => s.kind)).toEqual(["approve", "repay"]);
    expect(repay.steps[1].data.startsWith(toFunctionSelector("repay((address,address,address,address,uint256),uint256,uint256,address,bytes)"))).toBe(true);
    expect(repay.summary).toMatch(/repay the whole debt \(40 USDG/);
    const part = (await call(client, "borrow_repay", { usdg: "10", confirm: true })).body;
    expect(part.after).toMatchObject({ debt: "30", healthFactor: 1.9791 });

    const wc = (await call(client, "borrow_withdraw_collateral", { shares: "30", confirm: true })).body;
    expect(wc.steps[0].data.startsWith(toFunctionSelector("withdrawCollateral((address,address,address,address,uint256),uint256,address,address)"))).toBe(true);
    expect(wc.after).toMatchObject({ collateralShares: "70", debt: "40", healthFactor: 1.0390 });
    const all = await call(client, "borrow_withdraw_collateral", { shares: "all", confirm: true });
    expect(all.r.isError).toBe(true);
    expect(all.txt).toMatch(/still owed; repay first/);

    // the oracle fails closed: borrow and withdrawCollateral refused, repay and supply still planned
    world.chain.lending.oraclePrice = null;
    const b = await call(client, "borrow_take", { usdg: "1", confirm: true });
    expect(b.r.isError).toBe(true);
    expect(b.txt).toMatch(/no usable price/);
    const w = await call(client, "borrow_withdraw_collateral", { shares: "1", confirm: true });
    expect(w.r.isError).toBe(true);
    expect(w.txt).toMatch(/no usable price/);
    expect((await call(client, "borrow_repay", { usdg: "5", confirm: true })).body.ok).toBe(true);
    expect((await call(client, "borrow_supply_collateral", { shares: "1", confirm: true })).body.ok).toBe(true);
    expect(VAULT_NOW).toBeGreaterThan(0n);
  });

  it("the server starts on mainnet with the lending tools pointed at the canonical Blue and the hhUSDG vault", async () => {
    const config = loadConfig({ HEDGEHOOD_CHAIN_ID: "4663", HEDGEHOOD_OWNER_KEY: OWNER_KEY });
    const ctx = createContext(config, { fetch: fakeWorld().fetch });
    expect(ctx.lendingDeployment).toMatchObject({ blue: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010", vault: "0x54Bc097643BB9fd4ab004f11859893655529E954" });
    expect(ctx.lending("none").blue).toBe("0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010");
  });
});
