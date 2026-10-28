import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { encodeAuthorizeSession, encodeDeposit, encodeFillOrderAs, encodeWithdraw, marketV2Abi, nonceMask, orderBookV2Abi, SCOPE_CANCEL, SCOPE_TRADE, UNLIMITED } from "../src/index.js";
import { fixtureOrder } from "./order.test.js";

const BOOK = "0x7288a3D12e15379C3b64988b54Ab4Da759638cf5";
const MARKET = "0xC289617d613C9865a6595B365DaD88277282e0Ac";
const ME = "0x3333333333333333333333333333333333333333";

describe("calldata", () => {
  it("fillOrderAs selector matches `cast sig` and decodes back", () => {
    const tx = encodeFillOrderAs(BOOK, ME, fixtureOrder, "0x1234", 10n ** 18n, true);
    expect(tx.to).toBe(BOOK);
    expect(tx.data.slice(0, 10)).toBe("0x18943a04");
    const d = decodeFunctionData({ abi: orderBookV2Abi, data: tx.data });
    expect(d.functionName).toBe("fillOrderAs");
    const [account, order, sig, qty, fromBalance] = d.args as unknown as [string, { nonce: bigint; side: number }, string, bigint, boolean];
    expect(account).toBe(ME);
    expect(order.nonce).toBe(7n);
    expect(order.side).toBe(1);
    expect(sig).toBe("0x1234");
    expect(qty).toBe(10n ** 18n);
    expect(fromBalance).toBe(true);
  });

  it("deposit / authorizeSession / withdraw selectors", () => {
    expect(encodeDeposit(MARKET, ME, 1n).data.slice(0, 10)).toBe("0x47e7ef24");
    // authorizeSession(address,uint64,uint256,uint256,uint256): `cast sig` / forge methodIdentifiers @ aa47f7f
    expect(encodeAuthorizeSession(MARKET, ME, 1, SCOPE_TRADE | SCOPE_CANCEL, 0n, 0n).data.slice(0, 10)).toBe("0x30f1b27a");
    expect(encodeWithdraw(MARKET, 1n, ME).to).toBe(MARKET);
  });

  it("authorizeSession encodes maxRequirement and maxSpend, unlimited as type(uint256).max", () => {
    const tx = encodeAuthorizeSession(MARKET, ME, 1_800_000_000, SCOPE_TRADE, 0n, 250_000_000n);
    const d = decodeFunctionData({ abi: marketV2Abi, data: tx.data });
    expect(d.functionName).toBe("authorizeSession");
    expect(d.args).toEqual([ME, 1_800_000_000n, 1n, 0n, 250_000_000n]);
    expect(tx.summary).toBe(`authorizeSession(${ME}, until 1800000000, scope 1, maxRequirement 0, maxSpend 250000000)`);
    const open = encodeAuthorizeSession(MARKET, ME, 1_800_000_000, SCOPE_TRADE | SCOPE_CANCEL, UNLIMITED, UNLIMITED);
    expect(UNLIMITED).toBe(2n ** 256n - 1n);
    expect(decodeFunctionData({ abi: marketV2Abi, data: open.data }).args).toEqual([ME, 1_800_000_000n, 3n, UNLIMITED, UNLIMITED]);
    expect(open.summary).toMatch(/maxRequirement unlimited, maxSpend unlimited/);
  });

  it("nonceMask builds one slot mask and refuses spans", () => {
    expect(nonceMask([0n, 1n, 255n])).toEqual({ slot: 0n, mask: 1n | 2n | (1n << 255n) });
    expect(nonceMask([256n, 257n])).toEqual({ slot: 1n, mask: 3n });
    expect(() => nonceMask([1n, 300n])).toThrow(/slots/);
  });
});
