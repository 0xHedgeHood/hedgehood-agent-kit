import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { privateKeyToAccount } from "viem/accounts";
import { encodeInstrumentId, orderToJson, Side, signOrder, type Order } from "@hedgehood-io/sdk";
import { createContext } from "../src/context.js";
import { createServer } from "../src/server.js";
import { loadConfig, normalizeKey } from "../src/config.js";
import { CALL220, NAME210P, NAME220C, ONE, fakeWorld, withGlobalFetch } from "./fakes.js";

const SESSION_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ACCOUNT = "0x3333333333333333333333333333333333333333" as const;
const BOOK = "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5";
const MARKET = "0xC289617d613C9865a6595B365DaD88277282e0Ac";
const EXPIRY = 1793390400n;
const INSTRUMENT = encodeInstrumentId(EXPIRY, 220_000_000n, false);

async function connect(fetchImpl?: typeof fetch) {
  const config = loadConfig({ HEDGEHOOD_CHAIN_ID: "46630", HEDGEHOOD_SESSION_KEY: SESSION_KEY, HEDGEHOOD_ACCOUNT: ACCOUNT, HEDGEHOOD_RFQ_URL: "https://rfq.test", HEDGEHOOD_INDEXER_URL: "https://index.test", HEDGEHOOD_GATEWAY_URL: "https://pay.test" });
  const ctx = createContext(config, { fetch: fetchImpl });
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { client, ctx };
}

function text(r: Awaited<ReturnType<Client["callTool"]>>): string {
  const c = (r.content as Array<{ type: string; text?: string }>)[0];
  return c?.text ?? "";
}

describe("config", () => {
  it("reads keys from the environment without echoing them", () => {
    const cfg = loadConfig({ HEDGEHOOD_SESSION_KEY: SESSION_KEY.slice(2) });
    expect(cfg.sessionKey).toBe(SESSION_KEY);
    expect(cfg.chainId).toBe(46630);
    expect(cfg.dryRunDefault).toBe(true);
    expect(() => normalizeKey("0x1234", "x")).toThrow(/32-byte/);
    expect(() => loadConfig({ HEDGEHOOD_CHAIN_ID: "1" })).toThrow(/46630 or 4663/);
    // unexpanded plugin placeholders count as unset
    const placeholder = loadConfig({ HEDGEHOOD_ACCOUNT: "${HEDGEHOOD_ACCOUNT}", HEDGEHOOD_OWNER_KEY_FILE: "${HEDGEHOOD_OWNER_KEY_FILE}", HEDGEHOOD_SESSION_KEY: SESSION_KEY });
    expect(placeholder.account).toBeUndefined();
    expect(placeholder.ownerKey).toBeUndefined();
  });
});

describe("mcp server", () => {
  it("lists the expected tools with confirm/dryRun on every write tool", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["authorize_session", "close_position", "decode_instrument", "deposit_x402", "fill_quote", "get_agent_record", "get_history", "get_mark", "get_pnl", "get_quote", "leaderboard", "list_instruments", "list_markets", "my_record", "positions", "redeem", "register_agent", "withdraw"]);
    for (const w of ["fill_quote", "close_position", "deposit_x402", "redeem", "withdraw", "authorize_session", "register_agent"]) {
      const t = tools.find((x) => x.name === w)!;
      const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(props.confirm, w).toBeDefined();
      expect(props.dryRun, w).toBeDefined();
    }
  });

  it("decode_instrument is pure and formats the label", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "decode_instrument", arguments: { instrumentId: INSTRUMENT.toString() } });
    expect(JSON.parse(text(r))).toMatchObject({ strike: "220", isPut: false, label: "NVDA 2026-10-30 220 C" });
  });

  it("fill_quote refuses an unknown digest, a missing confirm, and a quote for another taker", async () => {
    const { client, ctx } = await connect();
    const r1 = await client.callTool({ name: "fill_quote", arguments: { digest: "0x" + "11".repeat(32) } });
    expect(r1.isError).toBe(true);
    expect(text(r1)).toMatch(/unknown digest/);

    const order: Order = {
      maker: maker.address, signer: maker.address, taker: ACCOUNT, chainId: 46630n, settlement: BOOK, market: MARKET, instrumentId: INSTRUMENT,
      side: Side.Ask, quantityRaw: 10n ** 18n, minFillRaw: 0n, premiumStartRaw: 5_000_000n, premiumEndRaw: 5_000_000n, startTime: 0n,
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 60), stockMultiplier: 10n ** 18n, nonce: 1n, fromBalance: true,
    };
    const signature = await signOrder(maker, order);
    const r2 = await client.callTool({ name: "fill_quote", arguments: { order: orderToJson(order), signature } });
    expect(r2.isError).toBeFalsy();
    const body = JSON.parse(text(r2));
    expect(body.needsConfirm).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.data.startsWith("0x18943a04")).toBe(true); // fillOrderAs selector
    expect(ctx.session?.address).toBe(privateKeyToAccount(SESSION_KEY).address);

    const r3 = await client.callTool({ name: "fill_quote", arguments: { order: orderToJson({ ...order, taker: maker.address }), signature, confirm: true } });
    expect(r3.isError).toBe(true);
    expect(text(r3)).toMatch(/addressed to/);
  });

  it("withdraw and authorize_session need the owner key", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "withdraw", arguments: { amount: "1", confirm: true } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/owner key/);
    const r2 = await client.callTool({ name: "authorize_session", arguments: { confirm: true } });
    expect(r2.isError).toBe(true);
    expect(text(r2)).toMatch(/owner key/);
  });

  it("deposit_x402 dry run reads the instructions, stops at the 402 and never signs", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = (async (url: string | URL | Request) => {
      calls++;
      if (String(url).endsWith("/v1/instructions")) {
        return new Response(JSON.stringify({ endpoint: "https://pay.test/v1/deposit", method: "POST", asset: { symbol: "USDG", address: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d", decimals: 6, network: "eip155:46630", chainId: 46630 }, payTo: "0x9999999999999999999999999999999999999999", fee: { raw: "0" }, limits: { minRaw: "1000000", maxRaw: "1000000000", dayCapRaw: "5000000000", ratePerS: 0.2, burst: 5, feeRaw: "0" }, markets: [] }), { status: 200 });
      }
      const pr = { x402Version: 2, resource: { url: "https://pay.test/v1/deposit", description: "d", mimeType: "application/json" }, accepts: [{ scheme: "exact", network: "eip155:46630", asset: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d", amount: "25000000", payTo: "0x9999999999999999999999999999999999999999", maxTimeoutSeconds: 600, extra: { name: "Global Dollar", version: "1" } }] };
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
    }) as typeof fetch;
    const { client } = await connect(fetchImpl);
    const r0 = await client.callTool({ name: "deposit_x402", arguments: { amount: "25" } });
    expect(JSON.parse(text(r0)).needsConfirm).toBe(true);
    expect(calls).toBe(0);
    const r = await client.callTool({ name: "deposit_x402", arguments: { amount: "25", confirm: true } });
    const body = JSON.parse(text(r));
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.requirement.amount).toBe("25000000");
    expect(body.gateway.payTo).toBe("0x9999999999999999999999999999999999999999");
    expect(calls).toBe(2);
    const big = await client.callTool({ name: "deposit_x402", arguments: { amount: "5000", confirm: true } });
    expect(big.isError).toBe(true);
    expect(text(big)).toMatch(/HEDGEHOOD_MAX_DEPOSIT/);
  });

  it("leaderboard, my_record and get_agent_record proxy the indexer", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = (async (url: string | URL) => {
      const u = new URL(String(url));
      seen.push(u.toString());
      const body = u.pathname.includes("/agents/")
        ? { agentId: "7", record: { agentId: "7", owner: ACCOUNT }, accounts: [] }
        : u.pathname.endsWith("/positions")
          ? { account: ACCOUNT, positions: [], leaderboard: { account: ACCOUNT, fills: 2 }, agentId: null }
          : u.pathname.endsWith("/fills")
            ? { fills: [{ txHash: "0x01" }] }
            : { by: "account", order: "settledPnlRaw", rows: [{ account: ACCOUNT, fills: 2 }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const { client } = await connect(fetchImpl);
    expect(JSON.parse(text(await client.callTool({ name: "leaderboard", arguments: { by: "account", order: "fills", limit: 5 } }))).rows[0].fills).toBe(2);
    expect(seen[0]).toBe("https://index.test/v1/leaderboard?by=account&order=fills&limit=5");
    const mine = JSON.parse(text(await client.callTool({ name: "my_record", arguments: {} })));
    expect(mine.leaderboard.fills).toBe(2);
    expect(mine.recentFills).toEqual([{ txHash: "0x01" }]);
    expect(JSON.parse(text(await client.callTool({ name: "get_agent_record", arguments: { agentId: "7" } }))).agentId).toBe("7");
  });

  it("get_pnl and get_history proxy the indexer's new endpoints and format the totals", async () => {
    const world = fakeWorld();
    const { client } = await connect(world.fetch);
    const pnl = JSON.parse(text(await client.callTool({ name: "get_pnl", arguments: {} })));
    expect(pnl.positions.map((p: { instrument: string }) => p.instrument)).toEqual([NAME220C, NAME210P]);
    expect(pnl.summary).toEqual({ realized: "+1.2", unrealized: "-0.005", feesPaid: "0.0124", total: "+1.1826" });
    expect(world.backend[0]!.url.toString()).toBe(`https://index.test/v1/pnl?account=${ACCOUNT}`);
    const h = JSON.parse(text(await client.callTool({ name: "get_history", arguments: { limit: 2, since: "2026-01-01T00:00:00Z" } })));
    expect(h.events.length).toBe(2);
    expect(h.events[0].type).toBe("fill");
    expect(world.backend[1]!.url.toString()).toBe(`https://index.test/v1/history?account=${ACCOUNT}&limit=2&since=1767225600`);
    const bad = await client.callTool({ name: "get_history", arguments: { since: "yesterday-ish" } });
    expect(bad.isError).toBe(true);
  });

  it("positions is enriched with average price, mark, unrealized P&L and time to expiry; degrades without the indexer", async () => {
    const world = fakeWorld();
    const { client } = await connect(world.fetch);
    const body = await withGlobalFetch(world.fetch, async () => JSON.parse(text(await client.callTool({ name: "positions", arguments: {} }))));
    expect(body.collateral).toBe("100");
    expect(body.freeCollateral).toBe("90");
    const rows = body.positions as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.instrument, r.quantity, r.side])).toEqual([[NAME210P, "-0.5", "short"], [NAME220C, "1", "long"]]);
    const long = rows.find((r) => r.instrument === NAME220C)!;
    expect(long).toMatchObject({ avgPrice: "1.68", mark: 1.625, markBid: 1.57, markAsk: 1.68, unrealized: "-0.055", closeWith: `close_position { instrument: "${NAME220C}" }` });
    expect(typeof long.expiresIn).toBe("string");
    expect(body.pnl).toEqual({ asOf: expect.any(Number), realized: "+1.2", unrealized: "-0.005", feesPaid: "0.0124", total: "+1.1826", note: "marks at desk mid" });
    const down = fakeWorld({ indexerDown: true });
    const { client: c2 } = await connect(down.fetch);
    const b2 = await withGlobalFetch(down.fetch, async () => JSON.parse(text(await c2.callTool({ name: "positions", arguments: {} }))));
    expect(b2.pnl).toMatch(/indexer unavailable/);
    expect(b2.positions[1]).toMatchObject({ instrument: NAME220C, quantity: "1" });
    expect(b2.positions[1].avgPrice).toBeUndefined();
    expect(b2.positions[1].expiresIn).toBeDefined();
  });

  it("close_position quotes the opposite side, prices without confirm, simulates with confirm (dry run), and refuses what it cannot fill", async () => {
    const world = fakeWorld();
    const { client } = await connect(world.fetch);
    const run = (args: Record<string, unknown>) => withGlobalFetch(world.fetch, () => client.callTool({ name: "close_position", arguments: args }));
    // long 1 call -> sell 1 to the bid; no confirm: priced, nothing simulated
    const priced = JSON.parse(text(await run({ instrument: NAME220C })));
    expect(priced).toMatchObject({ ok: false, needsConfirm: true, side: "sell", position: "1", closes: "1", remainingAfter: "0", instrument: NAME220C });
    expect(priced.quote.pricePerShare).toBe("1.57");
    expect(priced.quote.youReceive).toBe("1.56215"); // 1.57 minus the 50 bps taker fee (rounded up)
    expect(priced.data.startsWith("0x18943a04")).toBe(true);
    expect(world.backend.find((b) => b.url.pathname === "/v1/rfq")!.body).toMatchObject({ instrument: NAME220C, side: "sell", quantity: "1", taker: ACCOUNT });
    expect(world.chain.simulated.length).toBe(0);
    // short 0.5 put -> buy back 0.25 of it with confirm: simulated through the session key, dry run by default
    const partial = JSON.parse(text(await run({ instrument: NAME210P, quantity: "0.25", confirm: true })));
    expect(partial).toMatchObject({ ok: true, dryRun: true, simulated: true, side: "buy", position: "-0.5", closes: "0.25", remainingAfter: "-0.25", from: privateKeyToAccount(SESSION_KEY).address });
    expect(partial.quote.youPay).toBe("0.4221"); // 0.25 * 1.68 + 50 bps fee
    expect(world.chain.simulated.length).toBe(1);
    expect(world.chain.simulated[0]).toBe(partial.data);
    // more than the position: capped
    const capped = JSON.parse(text(await run({ instrumentId: CALL220.toString(), quantity: "5" })));
    expect(capped.closes).toBe("1");
    // nothing to close
    const none = await run({ expiry: EXPIRY.toString(), strike: "210", kind: "call" });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/no open position/);
    // the desk in dry-run mode: priced but marked unfillable, never sent
    const dry = fakeWorld({ quoteDryRun: true });
    const { client: c2 } = await connect(dry.fetch);
    const r = JSON.parse(text(await withGlobalFetch(dry.fetch, () => c2.callTool({ name: "close_position", arguments: { instrument: NAME220C, confirm: true } }))));
    expect(r.ok).toBe(false);
    expect(r.fillable).toBe(false);
    expect(dry.chain.simulated.length).toBe(0);
  });

  it("close_position survives one feed_not_healthy 503 from the desk", async () => {
    const world = fakeWorld({ quoteFails: [{ status: 503, body: { error: "not_executable", reason: "not_executable:feed_not_healthy" } }] });
    const config = loadConfig({ HEDGEHOOD_CHAIN_ID: "46630", HEDGEHOOD_SESSION_KEY: SESSION_KEY, HEDGEHOOD_ACCOUNT: ACCOUNT, HEDGEHOOD_RFQ_URL: "https://rfq.test", HEDGEHOOD_INDEXER_URL: "https://index.test" });
    const ctx = createContext(config, { fetch: world.fetch });
    // shorten the retry for the test; the production default is 1.5 s
    (ctx as unknown as { rfq: { feedRetryMs: number } }).rfq.feedRetryMs = 20;
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    const r = JSON.parse(text(await withGlobalFetch(world.fetch, () => client.callTool({ name: "close_position", arguments: { instrument: NAME220C } }))));
    expect(r.needsConfirm).toBe(true);
    expect(world.backend.filter((x) => x.url.pathname === "/v1/rfq").length).toBe(2);
    void ONE;
  });
});
