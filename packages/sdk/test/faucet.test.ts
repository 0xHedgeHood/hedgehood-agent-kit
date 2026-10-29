import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { deployments, encodeFaucet, faucetRefusal, getFaucet, identityRegistryFor, testUsdAbi, type FaucetStatus } from "../src/index.js";

const TEST_USD = "0x850DE815d41F6983Aaf09247f9a465c0aefff04C";

describe("testnet faucet (TestUSD)", () => {
  it("names TestUSD on 46630 and refuses mainnet", () => {
    const f = getFaucet(46630);
    expect(f).toMatchObject({ token: TEST_USD, symbol: "hUSD-test", amountRaw: 1_000_000_000n, cooldownS: 86_400, eip712: { name: "Hedgehood Test USD", version: "1" } });
    expect(() => getFaucet(4663)).toThrow(/no faucet on Robinhood Chain mainnet/);
    expect(deployments[4663].faucet).toBeUndefined();
  });

  it("faucet() calldata goes to the token with the contract's selector", () => {
    const tx = encodeFaucet(46630);
    expect(tx.to).toBe(TEST_USD);
    expect(tx.data).toBe(toFunctionSelector("faucet()"));
    expect(tx.data).toBe("0xde5f72fd");
    expect(tx.summary).toMatch(/1000 hUSD-test/);
  });

  it("the vendored ABI carries the frontend's interface", () => {
    const names = (testUsdAbi as readonly { type: string; name?: string }[]).map((x) => `${x.type}:${x.name}`);
    for (const n of ["function:faucet", "function:nextFaucetAt", "function:FAUCET_AMOUNT", "function:FAUCET_COOLDOWN", "event:Faucet", "error:FaucetCooldown", "function:transferWithAuthorization", "function:permit", "function:version"]) expect(names).toContain(n);
  });

  it("refusal reasons", () => {
    const base: FaucetStatus = { token: TEST_USD, symbol: "hUSD-test", account: "0x3333333333333333333333333333333333333333", deployed: true, balanceRaw: 0n, nextFaucetAt: 0n, now: 100n, canDrawNow: true, amountRaw: 1n };
    expect(faucetRefusal(base)).toBeUndefined();
    expect(faucetRefusal({ ...base, deployed: false })).toMatch(/not deployed/);
    expect(faucetRefusal({ ...base, nextFaucetAt: 200n, canDrawNow: false })).toMatch(/cooldown.*unix 200/);
  });

  it("the testnet ERC-8004 registry is the reference deployment's testnet address", () => {
    expect(identityRegistryFor(46630)).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
    expect(identityRegistryFor(4663)).toBe("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
  });
});
