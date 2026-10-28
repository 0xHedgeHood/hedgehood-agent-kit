import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, type Address } from "viem";
import { USDG_NETWORKS, depositViaGateway, dollarsToUnits, pickUsdgRequirement, registerUsdg, type GatewayInstructions } from "../src/index.js";
import type { PaymentRequirements } from "@x402/core/types";

const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const FLOAT: Address = "0x9999999999999999999999999999999999999999";
const TUSDG: Address = "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d";
const MARKET: Address = "0xC289617d613C9865a6595B365DaD88277282e0Ac";
const ACCOUNT: Address = "0x3333333333333333333333333333333333333333";

/** `gateway/x402.py requirement()` on the testnet registry (asset + network from the chain). */
function requirement(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return { scheme: "exact", network: "eip155:46630", asset: TUSDG, amount: "25000000", payTo: FLOAT, maxTimeoutSeconds: 600, extra: { name: "Global Dollar", version: "1" }, ...over };
}

/** `gateway/app.py instructions()`. */
function instructions(over: Partial<GatewayInstructions> = {}): GatewayInstructions {
  return {
    summary: "Fund your market balance with USDG over x402",
    endpoint: "https://pay.test/v1/deposit",
    method: "POST",
    asset: { symbol: "USDG", address: TUSDG, decimals: 6, network: "eip155:46630", chainId: 46630 },
    payTo: FLOAT,
    fee: { raw: "0" },
    limits: { minRaw: "1000000", maxRaw: "1000000000", dayCapRaw: "5000000000", ratePerS: 0.2, burst: 5, feeRaw: "0" },
    markets: [{ underlying: "NVDA", market: MARKET, book: "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5", version: 2 }],
    ...over,
  };
}

function paymentRequired(accepts: PaymentRequirements[]) {
  const doc = { x402Version: 2, error: "payment required", resource: { url: "https://pay.test/v1/deposit", description: "USDG deposit into the Hedgehood options market", mimeType: "application/json" }, accepts };
  return { doc, header: Buffer.from(JSON.stringify(doc)).toString("base64") };
}

describe("USDG preset", () => {
  it("knows mainnet USDG and testnet tUSDG by full address", () => {
    expect(USDG_NETWORKS["eip155:4663"]!.asset).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(USDG_NETWORKS["eip155:46630"]!.asset).toBe(TUSDG);
    expect(USDG_NETWORKS["eip155:4663"]!.eip712).toEqual({ name: "Global Dollar", version: "1" });
  });

  it("dollarsToUnits: 6 decimals, refuses finer or zero", () => {
    expect(dollarsToUnits("0.05")).toBe(50_000n);
    expect(dollarsToUnits("$25")).toBe(25_000_000n);
    expect(dollarsToUnits(1.5)).toBe(1_500_000n);
    expect(() => dollarsToUnits("0.0000001")).toThrow(/decimals/);
    expect(() => dollarsToUnits("0")).toThrow(/above zero/);
  });

  it("registerUsdg installs a money parser answering only for its network", async () => {
    const parsers: Array<(a: string | number, n: string) => Promise<unknown>> = [];
    const scheme = { registerMoneyParser: (p: (a: string | number, n: string) => Promise<unknown>) => parsers.push(p) };
    registerUsdg(scheme, { network: "eip155:46630" });
    expect(await parsers[0]!("0.05", "eip155:8453")).toBeNull();
    expect(await parsers[0]!("0.05", "eip155:46630")).toEqual({ amount: "50000", asset: TUSDG, extra: { name: "Global Dollar", version: "1" } });
  });

  it("pickUsdgRequirement refuses lookalike assets, other networks, non-exact schemes and foreign domains", () => {
    const good = requirement();
    expect(pickUsdgRequirement([requirement({ asset: "0x5fc591225f1f20C08C3c59Fe25826F6a36e1d168" }), good], "eip155:46630")).toBe(good);
    expect(pickUsdgRequirement([requirement({ network: "eip155:4663" })], "eip155:46630")).toBeNull();
    expect(pickUsdgRequirement([requirement({ scheme: "upto" })], "eip155:46630")).toBeNull();
    expect(pickUsdgRequirement([requirement({ extra: { name: "USD Coin", version: "2" } })], "eip155:46630")).toBeNull();
    expect(pickUsdgRequirement([requirement({ extra: { assetTransferMethod: "permit2" } })], "eip155:46630")).toBeNull();
    expect(pickUsdgRequirement([requirement({ extra: {} })], "eip155:46630")).toBeTruthy();
    expect(pickUsdgRequirement([requirement({ asset: TUSDG.toLowerCase() })], "eip155:46630")).toBeTruthy();
  });
});

describe("depositViaGateway", () => {
  function gateway(opts: { accepts?: PaymentRequirements[]; instructions?: GatewayInstructions; onPaid?: (headers: Headers) => Response } = {}) {
    const calls: Array<{ method: string; path: string; headers: Headers; body: unknown }> = [];
    const accepts = opts.accepts ?? [requirement()];
    const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const headers = new Headers(init?.headers as HeadersInit);
      calls.push({ method: init?.method ?? "GET", path: u.pathname, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.pathname === "/v1/instructions") return new Response(JSON.stringify(opts.instructions ?? instructions()), { status: 200 });
      if (!headers.get("PAYMENT-SIGNATURE")) {
        const { doc, header } = paymentRequired(accepts);
        return new Response(JSON.stringify(doc), { status: 402, headers: { "PAYMENT-REQUIRED": header, "content-type": "application/json" } });
      }
      return opts.onPaid
        ? opts.onPaid(headers)
        : new Response(JSON.stringify({ id: 1, status: "prepared", account: ACCOUNT, market: MARKET, underlying: "NVDA", amountRaw: "25000000", feeRaw: "0", txHash: null, payment: { payer: payer.address, transaction: "0x" + "01".repeat(32), network: "eip155:46630" }, send: false }), {
            status: 200,
            headers: { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: "0x" + "01".repeat(32), network: "eip155:46630", payer: payer.address })).toString("base64") },
          });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }
  const base = { signer: payer, chainId: 46630, gatewayUrl: "https://pay.test" };

  it("dry run reads the instructions, posts { account, amountRaw, market }, stops at the 402 and reports the requirement", async () => {
    const { fetchImpl, calls } = gateway();
    const r = await depositViaGateway({ account: ACCOUNT, market: MARKET, amountRaw: 25_000_000n }, { ...base, fetch: fetchImpl });
    expect(r.dryRun).toBe(true);
    expect(r.requirement?.amount).toBe("25000000");
    expect(r.instructions?.payTo).toBe(FLOAT);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/instructions", "POST /v1/deposit"]);
    expect(calls[1]!.body).toEqual({ account: ACCOUNT, amountRaw: "25000000", market: MARKET });
  });

  it("includes the gateway's fee in the expected total and names the market by underlying when asked", async () => {
    const { fetchImpl, calls } = gateway({ instructions: instructions({ fee: { raw: "100000" } }), accepts: [requirement({ amount: "25100000" })] });
    const r = await depositViaGateway({ account: ACCOUNT, market: MARKET, amountRaw: 25_000_000n }, { ...base, fetch: fetchImpl, underlying: "NVDA" });
    expect(r.requirement?.amount).toBe("25100000");
    expect(calls[1]!.body).toEqual({ account: ACCOUNT, amountRaw: "25000000", underlying: "NVDA" });
  });

  it("refuses before signing: wrong total, cap, lookalike asset, foreign payTo, mainnet USDG on testnet, outside limits", async () => {
    const run = (g: ReturnType<typeof gateway>, amountRaw = 25_000_000n, extra: Record<string, unknown> = {}) => depositViaGateway({ account: ACCOUNT, market: MARKET, amountRaw }, { ...base, fetch: g.fetchImpl, ...extra });
    await expect(run(gateway(), 20_000_000n)).rejects.toThrow(/expected 20000000 \+ fee 0/);
    await expect(run(gateway(), 25_000_000n, { maxAmountRaw: 1n })).rejects.toThrow(/cap/);
    await expect(run(gateway({ accepts: [requirement({ asset: "0x5fc54b6CbC5ccD9B112ddfF3326Caeeaba33d168" })] }))).rejects.toThrow(/no USDG/);
    await expect(run(gateway({ accepts: [requirement({ payTo: "0x8888888888888888888888888888888888888888" })] }))).rejects.toThrow(/payTo/);
    // gateway/x402.py defaults to mainnet USDG + eip155:4663 unless the registry's asset/network is passed through
    const mainnetOnTestnet = instructions({ asset: { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, network: "eip155:4663", chainId: 4663 } });
    await expect(run(gateway({ instructions: mainnetOnTestnet }))).rejects.toThrow(/not this chain's USDG/);
    await expect(run(gateway(), 500_000n)).rejects.toThrow(/between/);
  });

  it("signs an EIP-3009 authorization on USDG's domain with a capped window, resends it and returns the deposit record", async () => {
    const { fetchImpl, calls } = gateway();
    const r = await depositViaGateway({ account: ACCOUNT, market: MARKET, amountRaw: 25_000_000n }, { ...base, fetch: fetchImpl, dryRun: false });
    expect(r.dryRun).toBe(false);
    expect(r.deposit?.status).toBe("prepared");
    expect(r.depositTxHash).toBeUndefined();
    expect(r.settlement?.success).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/instructions", "POST /v1/deposit", "POST /v1/deposit"]);
    const header = calls[2]!.headers.get("PAYMENT-SIGNATURE");
    expect(header).toBeTruthy();
    const payload = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
    expect(payload.accepted.asset).toBe(TUSDG);
    expect(payload.accepted.payTo).toBe(FLOAT);
    const auth = payload.payload.authorization;
    expect(auth.from).toBe(payer.address);
    expect(auth.to).toBe(FLOAT);
    expect(auth.value).toBe("25000000");
    const now = Math.floor(Date.now() / 1000);
    expect(Number(auth.validBefore)).toBeLessThanOrEqual(now + 600 + 5);
    expect(Number(auth.validBefore)).toBeGreaterThan(now);
    const who = await recoverTypedDataAddress({
      domain: { name: "Global Dollar", version: "1", chainId: 46630, verifyingContract: TUSDG },
      types: { TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ] },
      primaryType: "TransferWithAuthorization",
      message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
      signature: payload.payload.signature,
    });
    expect(who).toBe(payer.address);
  });
});
