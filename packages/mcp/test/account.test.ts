import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, type Hex } from "viem";
import { erc20Abi, instrumentName, marketV2Abi, orderBookV2Abi, UNLIMITED } from "@hedgehood-io/sdk";
import { createContext } from "../src/context.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { AMD_MARKET, EXPIRY, GOOGL_BOOK, GOOGL_MARKET, MARKET, NAME220C, fakeWorld, multiMarketChain, withGlobalFetch, type FakeWorld } from "./fakes.js";

const SESSION_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const OWNER_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const owner = privateKeyToAccount(OWNER_KEY);
const GOOGL220C = instrumentName("GOOGL", EXPIRY, 220_000_000n, false);
const abi = [...marketV2Abi, ...orderBookV2Abi, ...erc20Abi];

/** session: the session key trades for the owner's account; owner: the owner key is the account (no session key). */
async function connect(world: FakeWorld, as: "session" | "owner") {
  const env: Record<string, string> = { HEDGEHOOD_CHAIN_ID: "46630", HEDGEHOOD_ACCOUNT: owner.address, HEDGEHOOD_RFQ_URL: "https://rfq.test", HEDGEHOOD_INDEXER_URL: "https://index.test", HEDGEHOOD_GATEWAY_URL: "https://pay.test" };
  if (as === "session") env.HEDGEHOOD_SESSION_KEY = SESSION_KEY;
  else env.HEDGEHOOD_OWNER_KEY = OWNER_KEY;
  const server = createServer(createContext(loadConfig(env), { fetch: world.fetch }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await withGlobalFetch(world.fetch, () => client.callTool({ name, arguments: args }));
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? "";
    return { isError: !!r.isError, text, body: r.isError ? undefined : (JSON.parse(text) as Record<string, any>) };
  };
}

describe("one account across markets (MCP)", () => {
  it("get_account shows every market, marks the unreadable one and lists where the session key can trade", async () => {
    const call = await connect(fakeWorld({ chain: multiMarketChain() }), "session");
    const { body } = await call("get_account");
    expect(body!.keyRole).toBe("session");
    expect(body!.tradable).toEqual(["NVDA"]);
    expect(body!.failed).toEqual(["TSLA"]);
    expect(body!.totals).toMatchObject({ collateral: "280", locked: "10", free: "270", openPositions: 2 });
    expect(body!.wallet[0]).toMatchObject({ balance: "500" });
    const by = Object.fromEntries((body!.markets as Array<Record<string, any>>).map((m) => [m.underlying, m]));
    expect(by.NVDA).toMatchObject({ free: "240", openPositions: 2, canTradeFromBalance: true, session: { active: true, spendLeft: "40" } });
    expect(by.AMD).toMatchObject({ free: "30", canTradeFromBalance: false, session: { active: false } });
    expect(by.TSLA.error).toMatch(/reverted/);
    expect(body!.hint).toMatch(/can fill from the balance in: NVDA/);
  });

  it("a session key short in the quote's market is refused with the shortfall, the free balance elsewhere and the owner's fix", async () => {
    const world = fakeWorld({ chain: multiMarketChain() });
    const call = await connect(world, "session");
    const q = (await call("get_quote", { instrument: GOOGL220C, side: "buy", quantity: "1" })).body!;
    expect(q.market).toBe("GOOGL");
    expect(q.order.market).toBe(GOOGL_MARKET);
    const r = await call("fill_quote", { digest: q.digest, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/refused: the GOOGL market balance is short by 1\.6884 USDG/);
    expect(r.text).toMatch(/Free balance in other markets: NVDA 240, AMD 30/);
    expect(r.text).toContain("hedgehood rebalance --from NVDA --to GOOGL --amount 1.6884 --send");
    expect(r.text).toContain('rebalance { from: "NVDA", to: "GOOGL", amount: "1.6884", confirm: true, dryRun: false }');
    expect(world.chain.simulated).toHaveLength(0);
    // the same key never pays from the wallet or deposits
    expect((await call("fill_quote", { digest: q.digest, autoDeposit: true, confirm: true })).text).toMatch(/autoDeposit needs the account's own key/);
    // where the balance covers it, the session fill goes through in balance mode
    const n = (await call("get_quote", { instrument: NAME220C, side: "buy", quantity: "1" })).body!;
    const ok = (await call("fill_quote", { digest: n.digest, fromBalance: false, confirm: true })).body!;
    expect(ok).toMatchObject({ ok: true, dryRun: true, market: "NVDA", mode: "balance" });
    expect(ok.note).toMatch(/fromBalance: false ignored/);
    expect(decodeFunctionData({ abi, data: ok.data as Hex }).args![4]).toBe(true);
  });

  it("the owner key fills in wallet mode by default: approve then fill, no deposit; balance mode can deposit first", async () => {
    const world = fakeWorld({ chain: multiMarketChain() });
    const call = await connect(world, "owner");
    const q = (await call("get_quote", { instrument: GOOGL220C, side: "buy", quantity: "1" })).body!;
    const preview = (await call("fill_quote", { digest: q.digest })).body!;
    expect(preview).toMatchObject({ needsConfirm: true, market: "GOOGL", funding: { mode: "wallet", paysUpTo: "1.6884", walletPullUpTo: "1.6884", approve: "1.6884" } });
    expect(preview.steps.map((s: { kind: string }) => s.kind)).toEqual(["approve", "fill"]);
    const dry = (await call("fill_quote", { digest: q.digest, confirm: true })).body!;
    expect(dry.steps.map((s: { kind: string; simulated: boolean }) => [s.kind, s.simulated])).toEqual([["approve", true], ["fill", false]]);
    expect(decodeFunctionData({ abi, data: dry.steps[0].data }).args).toEqual([GOOGL_MARKET, 1_688_400n]);
    expect(dry.steps[1].to).toBe(GOOGL_BOOK);
    expect(decodeFunctionData({ abi, data: dry.steps[1].data }).args![4]).toBe(false);
    expect(decodeFunctionData({ abi, data: (await call("fill_quote", { digest: q.digest, approve: "max" })).body!.steps[0].data }).args![1]).toBe(UNLIMITED);
    // balance mode: refused without autoDeposit, approve + deposit + fill with it
    const refused = await call("fill_quote", { digest: q.digest, fromBalance: true, confirm: true });
    expect(refused.text).toMatch(/GOOGL market balance is short by 1\.6884 USDG.*autoDeposit: true/);
    const auto = (await call("fill_quote", { digest: q.digest, autoDeposit: true, confirm: true })).body!;
    expect(auto.steps.map((s: { kind: string }) => s.kind)).toEqual(["approve", "deposit", "fill"]);
    expect(auto.funding).toMatchObject({ mode: "balance", deposit: "1.6884" });
  });

  it("deposit, withdraw all and rebalance are owner plans behind confirm + dryRun", async () => {
    const world = fakeWorld({ chain: multiMarketChain() });
    const call = await connect(world, "owner");
    const dep = (await call("deposit", { market: "GOOGL", amount: "5", confirm: true })).body!;
    expect(dep.steps.map((s: { kind: string; simulated: boolean }) => [s.kind, s.simulated])).toEqual([["approve", true], ["deposit", false]]);
    expect(dep.steps[1].to).toBe(GOOGL_MARKET);
    const all = (await call("withdraw", { all: true, confirm: true })).body!;
    expect(all.markets).toEqual([{ market: "NVDA", amount: "240" }, { market: "AMD", amount: "30" }]);
    expect(all.steps.map((s: { to: string; simulated: boolean }) => [s.to, s.simulated])).toEqual([[MARKET, true], [AMD_MARKET, true]]);
    expect(all.failed).toEqual(["TSLA"]);
    const one = (await call("withdraw", { amount: "10", market: "AMD" })).body!;
    expect(one).toMatchObject({ needsConfirm: true, market: "AMD", to: AMD_MARKET });
    const rb = (await call("rebalance", { from: "NVDA", to: "GOOGL", amount: "12.5", confirm: true })).body!;
    expect(rb.steps.map((s: { kind: string }) => s.kind)).toEqual(["withdraw", "approve", "deposit"]);
    expect((await call("rebalance", { from: "AMD", to: "GOOGL", amount: "31", confirm: true })).text).toMatch(/AMD market has 30 USDG free/);
    // a session key cannot do any of it
    const s = await connect(world, "session");
    for (const [name, args] of [["deposit", { amount: "1" }], ["withdraw", { all: true }], ["rebalance", { from: "NVDA", to: "AMD", amount: "1" }]] as const) {
      const r = await s(name, { ...args, confirm: true });
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/owner key/);
    }
  });
});
