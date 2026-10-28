import { afterEach, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainlinkExpirySourceAbi, decodeMarketError, encodeInstrumentId, formatSessionCap, MarketClient, MarketRevertError, marketV2Abi, orderBookV2Abi, sessionChargeOf, Side, UNLIMITED, type Order } from "../src/index.js";

const fixtureOrder: Order = {
  maker: "0x1111111111111111111111111111111111111111", signer: "0x1111111111111111111111111111111111111111", taker: "0x3333333333333333333333333333333333333333",
  chainId: 46630n, settlement: "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5", market: "0xC289617d613C9865a6595B365DaD88277282e0Ac",
  instrumentId: encodeInstrumentId(1793390400n, 220_000_000n, false), side: Side.Ask, quantityRaw: 10n ** 18n, minFillRaw: 0n,
  premiumStartRaw: 5_000_000n, premiumEndRaw: 5_000_000n, startTime: 1761600000n, validUntil: 1761600060n, stockMultiplier: 10n ** 18n, nonce: 7n, fromBalance: true,
};

const OWNER: Address = "0x3333333333333333333333333333333333333333";
const session = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const self = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const KEY: Address = "0x4444444444444444444444444444444444444444";
const RPC = "https://rpc.test";

/** Answers eth_call from `answer(functionName, args)`; a thrown { data } becomes a JSON-RPC revert with that data. */
function stubRpc(answer: (fn: string, args: readonly unknown[]) => Hex) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: Array<{ data: Hex }> };
    if (req.method !== "eth_call") return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0xb626" }));
    const { functionName, args } = decodeFunctionData({ abi: [...marketV2Abi, ...orderBookV2Abi], data: req.params[0]!.data });
    try {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: answer(functionName, args ?? []) }));
    } catch (e) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted", data: (e as { data: Hex }).data } }));
    }
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("sessions", () => {
  it("authorizeSession requires maxSpend, defaults maxShortRisk to 0 (cannot sell to open) and refuses maxRequirement", () => {
    const m = new MarketClient({ chainId: 46630, rpcUrl: RPC, account: OWNER });
    expect(() => m.authorizeSession(KEY, 1_800_000_000, {} as never)).toThrow(/maxSpend is required/);
    const tx = m.authorizeSession(KEY, 1_800_000_000, { cancel: true, maxSpend: 100_000_000n });
    expect(decodeFunctionData({ abi: marketV2Abi, data: tx.data }).args).toEqual([KEY, 1_800_000_000n, 3n, 0n, 100_000_000n]);
    const open = m.authorizeSession(KEY, 1_800_000_000, { maxShortRisk: UNLIMITED, maxSpend: UNLIMITED });
    expect(decodeFunctionData({ abi: marketV2Abi, data: open.data }).args).toEqual([KEY, 1_800_000_000n, 1n, UNLIMITED, UNLIMITED]);
    expect(() => m.authorizeSession(KEY, 1_800_000_000, { maxRequirement: 0n, maxSpend: 1n } as never)).toThrow(/replaced by maxShortRisk/);
  });

  it("reads authorizedAt, riskLeft and spendLeft from sessions(account, key)", async () => {
    restore = stubRpc((fn) => {
      expect(fn).toBe("sessions");
      return encodeFunctionResult({ abi: marketV2Abi, functionName: "sessions", result: [4_000_000_000n, 1_790_000_000n, 3n, 7_000_000n, 42_500_000n] });
    });
    const s = await new MarketClient({ chainId: 46630, rpcUrl: RPC, account: OWNER }).session(KEY);
    expect(s).toMatchObject({ key: KEY, expiresAt: 4_000_000_000n, authorizedAt: 1_790_000_000n, scope: 3n, riskLeft: 7_000_000n, spendLeft: 42_500_000n, canTrade: true, canCancel: true, active: true });
  });

  it("sessionCharge reads the position, the caps and the session's budgets", async () => {
    const id = encodeInstrumentId(1793390400n, 220_000_000n, false);
    restore = stubRpc((fn, args) => {
      if (fn === "position") return encodeFunctionResult({ abi: marketV2Abi, functionName: "position", result: 10n ** 18n / 2n });
      if (fn === "tradingOpen") return encodeFunctionResult({ abi: marketV2Abi, functionName: "tradingOpen", result: true });
      if (fn === "expiryInfo") return encodeFunctionResult({ abi: marketV2Abi, functionName: "expiryInfo", result: { openedAt: 1n, settled: false, settledByOwner: false, uiMultiplier: 10n ** 18n, anchor: 215_000_000n, capLow: 150_500_000n, capHigh: 279_500_000n, settlementPrice: 0n, rawSettlementPrice: 0n, strikes: [220_000_000n] } });
      if (fn === "sessions") {
        expect(args).toEqual([OWNER, session.address]);
        return encodeFunctionResult({ abi: marketV2Abi, functionName: "sessions", result: [4_000_000_000n, 1_790_000_000n, 3n, 20_000_000n, 0n] });
      }
      throw new Error(`unexpected ${fn}`);
    });
    const m = new MarketClient({ chainId: 46630, rpcUrl: RPC, account: OWNER, signer: session });
    // long 0.5, sell 1: opens 0.5 short at 59.5 worst case -> 29.75 > riskLeft 20
    const sell = await m.sessionCharge({ instrumentId: id, side: "sell", quantityRaw: 10n ** 18n });
    expect(sell).toMatchObject({ budget: "shortRisk", positionBeforeRaw: 10n ** 18n / 2n, maxPayoutRaw: 59_500_000n, chargeRaw: 29_750_000n, leftRaw: 20_000_000n, withinBudget: false });
    const buy = await m.sessionCharge({ instrumentId: id, side: "buy", quantityRaw: 10n ** 18n, paidRaw: 1n });
    expect(buy).toMatchObject({ budget: "spend", chargeRaw: 1n, leftRaw: 0n, withinBudget: false });
  });

  it("formats session caps", () => {
    expect(formatSessionCap(UNLIMITED)).toBe("unlimited");
    expect(formatSessionCap(0n)).toBe("none (0)");
    expect(formatSessionCap(12_500_000n)).toBe("12.5");
  });
});

describe("forced balance mode", () => {
  it("a session key may only fill in balance mode; the account key itself may use wallet mode", () => {
    const viaSession = new MarketClient({ chainId: 46630, rpcUrl: RPC, account: OWNER, signer: session });
    expect(viaSession.signsAsSession).toBe(true);
    const tx = viaSession.fillOrderAs(fixtureOrder, "0x1234", 10n ** 18n);
    expect((decodeFunctionData({ abi: orderBookV2Abi, data: tx.data }).args as readonly unknown[])[4]).toBe(true);
    expect(() => viaSession.fillOrderAs(fixtureOrder, "0x1234", 10n ** 18n, false)).toThrow(/SessionWalletMode/);
    const selfCustody = new MarketClient({ chainId: 46630, rpcUrl: RPC, signer: self });
    expect(selfCustody.signsAsSession).toBe(false);
    const wallet = selfCustody.fillOrderAs(fixtureOrder, "0x1234", 10n ** 18n, false);
    expect((decodeFunctionData({ abi: orderBookV2Abi, data: wallet.data }).args as readonly unknown[])[4]).toBe(false);
  });
});

describe("revert decoding", () => {
  it("decodes SessionWalletMode and SessionLimit with a hint, from data or from the message", () => {
    const data = encodeErrorResult({ abi: marketV2Abi, errorName: "SessionWalletMode" });
    expect(decodeMarketError({ message: "x", cause: { cause: { data } } })).toMatchObject({ errorName: "SessionWalletMode", hint: expect.stringMatching(/balance/) });
    expect(decodeMarketError(new Error("execution reverted: SessionLimit()"))).toMatchObject({ errorName: "SessionLimit", hint: expect.stringMatching(/SELL leg draws the short-risk budget \(riskLeft\).*BUY leg draws the spend budget \(spendLeft\)/) });
    expect(decodeMarketError(new Error("boom"))).toBeUndefined();
  });

  it("decodes StockControlsPaused and the settlement source's InvalidRoundHint with hints", () => {
    const paused = encodeErrorResult({ abi: marketV2Abi, errorName: "StockControlsPaused" });
    expect(decodeMarketError({ data: paused })).toMatchObject({ errorName: "StockControlsPaused", hint: expect.stringMatching(/cannot be read/) });
    const hint = encodeErrorResult({ abi: chainlinkExpirySourceAbi, errorName: "InvalidRoundHint" });
    expect(decodeMarketError({ cause: { data: hint } })).toMatchObject({ errorName: "InvalidRoundHint", hint: expect.stringMatching(/phase boundary.*abi\.encode\(stockRoundId, quoteRoundId\)/) });
    expect(decodeMarketError(new Error("execution reverted: InvalidRoundHint()"))?.errorName).toBe("InvalidRoundHint");
  });

  it("MarketClient.send surfaces a simulated SessionLimit as a MarketRevertError", async () => {
    restore = stubRpc(() => {
      throw { data: encodeErrorResult({ abi: marketV2Abi, errorName: "SessionLimit" }) };
    });
    const m = new MarketClient({ chainId: 46630, rpcUrl: RPC, account: OWNER, signer: session });
    const err = await m.send(m.fillOrderAs(fixtureOrder, "0x1234", 10n ** 18n)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketRevertError);
    expect((err as MarketRevertError).errorName).toBe("SessionLimit");
    expect((err as Error).message).toMatch(/fillOrderAs\(.*\) reverted SessionLimit: .*spend budget/);
    const charge = sessionChargeOf({ side: "sell", quantityRaw: 10n ** 18n, positionBeforeRaw: 0n, maxPayoutRaw: 59_500_000n }, { riskLeft: 10_000_000n, spendLeft: 0n });
    const named = await m.send(m.fillOrderAs(fixtureOrder, "0x1234", 10n ** 18n), { sessionCharge: charge }).catch((e: unknown) => e);
    expect((named as Error).message).toMatch(/reverted SessionLimit: this sell leg draws 59\.5 USDG from the short-risk budget \(riskLeft, authorized as maxShortRisk\), 10 left/);
  });
});
