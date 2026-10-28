import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { encodeAuthorizeSession, encodeDeposit, encodeFillOrderAs, encodeWithdraw, nonceMask, orderBookV2Abi, SCOPE_CANCEL, SCOPE_TRADE } from "../src/index.js";
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
    expect(encodeAuthorizeSession(MARKET, ME, 1, SCOPE_TRADE | SCOPE_CANCEL, 0n).data.slice(0, 10)).toBe("0x1058d85a");
    expect(encodeWithdraw(MARKET, 1n, ME).to).toBe(MARKET);
  });

  it("nonceMask builds one slot mask and refuses spans", () => {
    expect(nonceMask([0n, 1n, 255n])).toEqual({ slot: 0n, mask: 1n | 2n | (1n << 255n) });
    expect(nonceMask([256n, 257n])).toEqual({ slot: 1n, mask: 3n });
    expect(() => nonceMask([1n, 300n])).toThrow(/slots/);
  });
});
