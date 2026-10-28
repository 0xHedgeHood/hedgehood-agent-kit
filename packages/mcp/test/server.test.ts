import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { privateKeyToAccount } from "viem/accounts";
import { encodeInstrumentId, orderToJson, Side, signOrder, type Order } from "@hedgehood-io/sdk";
import { createContext } from "../src/context.js";
import { createServer } from "../src/server.js";
import { loadConfig, normalizeKey } from "../src/config.js";

const SESSION_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ACCOUNT = "0x3333333333333333333333333333333333333333" as const;
const BOOK = "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5";
const MARKET = "0xC289617d613C9865a6595B365DaD88277282e0Ac";
const EXPIRY = 1793390400n;
const INSTRUMENT = encodeInstrumentId(EXPIRY, 220_000_000n, false);

async function connect(fetchImpl?: typeof fetch) {
  const config = loadConfig({ HEDGEHOOD_CHAIN_ID: "46630", HEDGEHOOD_SESSION_KEY: SESSION_KEY, HEDGEHOOD_ACCOUNT: ACCOUNT, HEDGEHOOD_API_URL: "https://api.test" });
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
    expect(names).toEqual(["authorize_session", "decode_instrument", "deposit_x402", "fill_quote", "get_mark", "get_quote", "leaderboard", "list_instruments", "list_markets", "my_record", "positions", "redeem", "register_agent", "withdraw"]);
    for (const w of ["fill_quote", "deposit_x402", "redeem", "withdraw", "authorize_session", "register_agent"]) {
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

  it("deposit_x402 dry run stops at the 402 and never signs", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = (async () => {
      calls++;
      const pr = { x402Version: 2, resource: { url: "https://api.test/v1/deposit", description: "d", mimeType: "application/json" }, accepts: [{ scheme: "exact", network: "eip155:46630", asset: "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d", amount: "25000000", payTo: "0x9999999999999999999999999999999999999999", maxTimeoutSeconds: 600, extra: { name: "Global Dollar", version: "1" } }] };
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
    expect(calls).toBe(1);
    const big = await client.callTool({ name: "deposit_x402", arguments: { amount: "5000", confirm: true } });
    expect(big.isError).toBe(true);
    expect(text(big)).toMatch(/HEDGEHOOD_MAX_DEPOSIT/);
  });

  it("leaderboard and my_record proxy the backend", async () => {
    const fetchImpl: typeof fetch = (async (url: string | URL) => {
      const u = new URL(String(url));
      return new Response(JSON.stringify(u.pathname.includes("/agents/") ? { account: ACCOUNT, fills: 2 } : { entries: [{ rank: 1, account: ACCOUNT }] }), { status: 200 });
    }) as typeof fetch;
    const { client } = await connect(fetchImpl);
    expect(JSON.parse(text(await client.callTool({ name: "leaderboard", arguments: {} })))).toEqual([{ rank: 1, account: ACCOUNT }]);
    expect(JSON.parse(text(await client.callTool({ name: "my_record", arguments: {} }))).fills).toBe(2);
  });
});
