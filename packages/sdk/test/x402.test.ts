import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, type Address } from "viem";
import { USDG_NETWORKS, depositViaGateway, dollarsToUnits, pickUsdgRequirement, registerUsdg } from "../src/index.js";
import type { PaymentRequirements } from "@x402/core/types";

const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const GATEWAY: Address = "0x9999999999999999999999999999999999999999";
const TUSDG: Address = "0x539574139BB4Ac74Fd2183ba0E38ed777E30B58d";
const MARKET: Address = "0xC289617d613C9865a6595B365DaD88277282e0Ac";
const ACCOUNT: Address = "0x3333333333333333333333333333333333333333";

function requirement(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return { scheme: "exact", network: "eip155:46630", asset: TUSDG, amount: "25000000", payTo: GATEWAY, maxTimeoutSeconds: 3600, extra: { name: "Global Dollar", version: "1" }, ...over };
}

function paymentRequiredHeader(accepts: PaymentRequirements[]) {
  const pr = { x402Version: 2, resource: { url: "https://api.test/v1/deposit", description: "deposit", mimeType: "application/json" }, accepts };
  return Buffer.from(JSON.stringify(pr)).toString("base64");
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
  function gateway(accepts: PaymentRequirements[], onPaid?: (headers: Headers) => Response) {
    const calls: Array<{ headers: Headers; body: unknown }> = [];
    const fetchImpl: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      calls.push({ headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (!headers.get("PAYMENT-SIGNATURE")) {
        return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader(accepts), "content-type": "application/json" } });
      }
      return onPaid ? onPaid(headers) : new Response(JSON.stringify({ depositTxHash: "0xabc" }), { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it("dry run stops at the 402 and reports the requirement", async () => {
    const { fetchImpl, calls } = gateway([requirement()]);
    const r = await depositViaGateway({ account: ACCOUNT, market: MARKET, amountRaw: 25_000_000n }, { signer: payer, chainId: 46630, fetch: fetchImpl, apiUrl: "https://api.test" });
    expect(r.dryRun).toBe(true);
    expect(r.requirement?.amount).toBe("25000000");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ chainId: 46630, market: MARKET, account: ACCOUNT, amountRaw: "25000000" });
  });

  it("refuses a 402 that asks more than the deposit, above the cap, or in a lookalike token", async () => {
    const base = { signer: payer, chainId: 46630, apiUrl: "https://api.test" };
    await expect(depositViaGateway({ account: ACCOUNT, market: MARKET, amountRaw: 1_000_000n }, { ...base, fetch: gateway([requirement()]).fetchImpl })).rejects.toThrow(/more than the requested deposit/);
    await expect(depositViaGateway({ account: ACCOUNT, market: MARKET, amountRaw: 25_000_000n }, { ...base, maxAmountRaw: 1n, fetch: gateway([requirement()]).fetchImpl })).rejects.toThrow(/cap/);
    await expect(depositViaGateway({ account: ACCOUNT, market: MARKET, amountRaw: 25_000_000n }, { ...base, fetch: gateway([requirement({ asset: "0x5fc54b6CbC5ccD9B112ddfF3326Caeeaba33d168" })]).fetchImpl })).rejects.toThrow(/no USDG/);
  });

  it("signs an EIP-3009 authorization on USDG's domain with a capped window and resends it", async () => {
    const { fetchImpl, calls } = gateway([requirement()], () => new Response(JSON.stringify({ depositTxHash: "0xdeadbeef" }), { status: 200 }));
    const r = await depositViaGateway({ account: ACCOUNT, market: MARKET, amountRaw: 25_000_000n }, { signer: payer, chainId: 46630, fetch: fetchImpl, apiUrl: "https://api.test", dryRun: false });
    expect(r.dryRun).toBe(false);
    expect(r.depositTxHash).toBe("0xdeadbeef");
    expect(calls).toHaveLength(2);
    const header = calls[1]!.headers.get("PAYMENT-SIGNATURE");
    expect(header).toBeTruthy();
    const payload = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
    expect(payload.accepted.asset).toBe(TUSDG);
    const auth = payload.payload.authorization;
    expect(auth.from).toBe(payer.address);
    expect(auth.to).toBe(GATEWAY);
    expect(auth.value).toBe("25000000");
    const now = Math.floor(Date.now() / 1000);
    expect(Number(auth.validBefore)).toBeLessThanOrEqual(now + 600 + 5); // capped at MAX_VALIDITY_SECONDS, not the 402's 3600
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
