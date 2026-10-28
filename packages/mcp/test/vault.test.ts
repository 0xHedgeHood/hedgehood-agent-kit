import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createContext } from "../src/context.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { EPOCH3, EPOCH4, ONE, VAULT, VAULT_GATE, VAULT_USDG, fakeWorld, type FakeWorld } from "./fakes.js";

const SESSION_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0, throwaway
const owner = privateKeyToAccount(OWNER_KEY);
const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString();

async function connect(world: FakeWorld, env: Record<string, string> = {}) {
  const config = loadConfig({ HEDGEHOOD_CHAIN_ID: "46630", HEDGEHOOD_SESSION_KEY: SESSION_KEY, HEDGEHOOD_RFQ_URL: "https://rfq.test", HEDGEHOOD_INDEXER_URL: "https://index.test", HEDGEHOOD_VAULT_API_URL: "https://app.test/api/stockyield/funds", ...env });
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

describe("vault tools", () => {
  it("list_vaults reads the registry's funds with NAV, epoch state and times, the gate and the account's position; falls back to the chain when the API is down", async () => {
    const world = fakeWorld();
    const { client } = await connect(world, asOwner);
    const { body } = await call(client, "list_vaults");
    expect(body.registry).toBe("0xBeE38aF4Fc4f50A0C04bDdA45Bec6cBABFf476b9");
    expect(body.vaults).toHaveLength(1);
    const v = body.vaults[0];
    expect(v).toMatchObject({ vault: VAULT, symbol: "hhNVDA-CC", strategy: { code: "CC", name: "Covered Call" }, usdg: VAULT_USDG, gate: { address: VAULT_GATE, kind: "open" }, depositCap: "100000", capUsed: "20570.625", totalShares: "100", source: "chain" });
    expect(v.nav).toEqual({ usdgPerShare: "205.70625", navUsdg: "20570.625", stockPrice: "213.375", source: "mark" });
    expect(v.epoch).toMatchObject({ index: "3", state: "locked", phase: "Locked", nextFreezeAt: iso(EPOCH4.depositCutoff), nextSettleAt: iso(EPOCH3.expiry), nextCohort: "4" });
    expect(v.lastEpoch).toMatchObject({ index: "2", premiumIncome: "150", weeklyYield: "0.75%" });
    expect(v.my).toMatchObject({ account: owner.address, shares: "5", pendingDeposit: null, pendingRedeem: null, claimable: { stock: "0", usdg: "0" }, canDeposit: true, wallet: { usdg: "1000", stock: "2" } });
    expect(v.my.nextAction).toMatch(/vault_redeem/);
    expect(body.cycle).toMatch(/next epoch freeze/);
    // the API answered: snapshot from it, account still from chain
    const api = fakeWorld({ vaultApi: true });
    const { client: c2 } = await connect(api, asOwner);
    const b2 = (await call(c2, "list_vaults")).body;
    expect(b2.vaults[0]).toMatchObject({ source: "api", feeBps: 2000, nav: { usdgPerShare: "205.70625" }, my: { shares: "5" } });
  });

  it("vault_status shows queued requests, claimables and the next action", async () => {
    const world = fakeWorld();
    world.chain.vault.account = { depositEpoch: 4n, depositStock: 0n, depositUsdg: 25_000_000n, redeemEpoch: 0n, redeemShares: 0n };
    const { client } = await connect(world, asOwner);
    const { body } = await call(client, "vault_status", { vault: "NVDA-CC" });
    expect(body.vaults[0]).toMatchObject({ symbol: "hhNVDA-CC", shares: "5", pendingDeposit: { epoch: "4", usdg: "25", stock: "0", cancellable: true } });
    expect(body.vaults[0].nextAction).toMatch(/freeze of epoch 4/);
    world.chain.vault.preview = [0n, ONE / 10n, 3_000_000n];
    const all = (await call(client, "vault_status")).body;
    expect(all.vaults[0].claimable).toEqual({ stock: "0.1", usdg: "3" });
    expect(all.vaults[0].nextAction).toMatch(/vault_claim/);
  });

  it("vault writes need the owner key, explain without confirm, simulate with confirm (dry run), honour the dryRun default", async () => {
    const world = fakeWorld();
    const { client: session } = await connect(world); // session key only
    for (const [name, args] of [["vault_deposit", { vault: VAULT, usdg: "25" }], ["vault_redeem", { vault: VAULT, shares: "all" }], ["vault_claim", { vault: VAULT }], ["vault_cancel", { vault: VAULT, which: "redeem" }]] as const) {
      const { r, txt } = await call(session, name, { ...args, confirm: true });
      expect(r.isError, name).toBe(true);
      expect(txt, name).toMatch(/owner key/);
    }
    expect(world.chain.simulated).toEqual([]);

    const { client } = await connect(world, asOwner);
    const explain = (await call(client, "vault_deposit", { vault: "hhNVDA-CC", usdg: "25" })).body;
    expect(explain).toMatchObject({ ok: false, needsConfirm: true, dryRun: true, symbol: "hhNVDA-CC", account: owner.address });
    expect(explain.steps.map((s: { kind: string }) => s.kind)).toEqual(["approve", "requestDeposit"]);
    expect(explain.steps[1].data.startsWith(toFunctionSelector("requestDeposit(uint256,uint256,address)"))).toBe(true);
    expect(explain.steps[1].to).toBe(VAULT);
    expect(world.chain.simulated).toEqual([]);

    const dry = (await call(client, "vault_deposit", { vault: VAULT, usdg: "25", confirm: true })).body;
    expect(dry).toMatchObject({ ok: true, dryRun: true, from: owner.address });
    expect(dry.steps.map((s: { kind: string; simulated: boolean }) => [s.kind, s.simulated])).toEqual([["approve", true], ["requestDeposit", false]]);
    expect(dry.hint).toMatch(/dryRun: false/);
    expect(world.chain.simulated).toEqual([dry.steps[0].data]);

    // HEDGEHOOD_DRY_RUN=false: the explanation says a confirm would broadcast; dryRun: true still forces a dry run
    const { client: live } = await connect(fakeWorld(), { ...asOwner, HEDGEHOOD_DRY_RUN: "false" });
    expect((await call(live, "vault_redeem", { vault: VAULT, shares: "1" })).body.dryRun).toBe(false);
    expect((await call(live, "vault_redeem", { vault: VAULT, shares: "1", confirm: true, dryRun: true })).body).toMatchObject({ ok: true, dryRun: true });
  });

  it("vault_redeem all, vault_cancel and vault_claim build the account's calls; refusals are explained", async () => {
    const world = fakeWorld();
    world.chain.vault.account = { depositEpoch: 4n, depositStock: 0n, depositUsdg: 25_000_000n, redeemEpoch: 4n, redeemShares: ONE };
    const { client } = await connect(world, asOwner);
    const redeem = (await call(client, "vault_redeem", { vault: VAULT, shares: "all", confirm: true })).body;
    expect(redeem.steps[0].data.startsWith(toFunctionSelector("requestRedeem(uint256,address)"))).toBe(true);
    expect(redeem.summary).toMatch(/redeem 5 of 5 hhNVDA-CC/);
    const tooMany = await call(client, "vault_redeem", { vault: VAULT, shares: "50", confirm: true });
    expect(tooMany.r.isError).toBe(true);
    expect(tooMany.txt).toMatch(/holds 5/);
    const cancelDep = (await call(client, "vault_cancel", { vault: VAULT, which: "deposit", confirm: true })).body;
    expect(cancelDep.steps[0].data.startsWith(toFunctionSelector("cancelDeposit(address,address)"))).toBe(true);
    const cancelRed = (await call(client, "vault_cancel", { vault: VAULT, which: "redeem", confirm: true })).body;
    expect(cancelRed.steps[0].data.startsWith(toFunctionSelector("cancelRedeem(address)"))).toBe(true);
    const nothing = await call(client, "vault_claim", { vault: VAULT, confirm: true });
    expect(nothing.r.isError).toBe(true);
    expect(nothing.txt).toMatch(/nothing to claim/);
    world.chain.vault.preview = [0n, 0n, 9_000_000n];
    const claim = (await call(client, "vault_claim", { vault: VAULT, to: "0x4444444444444444444444444444444444444444", confirm: true })).body;
    expect(claim.steps[0].data.startsWith(toFunctionSelector("claim(address,address)"))).toBe(true);
    expect(claim.summary).toMatch(/claim 0 stock \+ 9 USDG from hhNVDA-CC to 0x4444/);
    const unknown = await call(client, "vault_claim", { vault: "hhTSLA-CC", confirm: true });
    expect(unknown.r.isError).toBe(true);
    expect(unknown.txt).toMatch(/unknown vault/);
  });

  it("the server starts on mainnet, where only the vault tools have a deployment", async () => {
    const config = loadConfig({ HEDGEHOOD_CHAIN_ID: "4663", HEDGEHOOD_OWNER_KEY: OWNER_KEY });
    const ctx = createContext(config, { fetch: fakeWorld().fetch });
    expect(ctx.marketDeployment).toBeUndefined();
    expect(ctx.vaults?.funds.length).toBe(8);
    expect(() => ctx.deployment).toThrow(/no V2 market/);
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    expect((await client.listTools()).tools.some((t) => t.name === "list_vaults")).toBe(true);
    const markets = await client.callTool({ name: "list_markets", arguments: {} });
    expect(markets.isError).toBe(true);
    expect(text(markets)).toMatch(/no V2 market/);
  });
});
