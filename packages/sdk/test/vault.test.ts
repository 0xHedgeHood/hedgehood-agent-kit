import { describe, expect, it } from "vitest";
import { decodeFunctionData, toFunctionSelector, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { VaultClient, epochFundAbi, epochState, erc20Abi, formatUsdg, getVaults, navPerShareRaw, parseVaultShares, strategyFromNames } from "../src/index.js";
import { EPOCH3, EPOCH4, ONE, VAULT, VAULT_GATE, VAULT_NOW, VAULT_STOCK, VAULT_USDG, defaultChain, fakeWorld } from "../../mcp/test/fakes.js";

// a well-known throwaway key (anvil #0); the owner wallet is the account itself, as the fund requires for its own calls
const owner = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OTHER: Address = "0x4444444444444444444444444444444444444444";
const SCHED = { ...EPOCH3, maxDeviationBps: 650 };

function client(world = fakeWorld(), extra: Partial<ConstructorParameters<typeof VaultClient>[0]> = {}) {
  return new VaultClient({ chainId: 46630, account: owner.address, signer: owner, fetch: world.fetch, apiUrl: "https://app.test/api/stockyield/funds", ...extra });
}

describe("vault math and states", () => {
  it("maps the contract phase and schedule to the depositor's epoch state", () => {
    expect(epochState("Collecting", SCHED, EPOCH3.depositCutoff - 1n)).toBe("open");
    expect(epochState("Collecting", SCHED, EPOCH3.depositCutoff)).toBe("frozen"); // cutoff passed, keeper has not frozen yet
    expect(epochState("Frozen", SCHED, EPOCH3.tradeStart)).toBe("frozen");
    expect(epochState("Locked", SCHED, EPOCH3.expiry - 1n)).toBe("locked");
    expect(epochState("Locked", SCHED, EPOCH3.expiry)).toBe("settling");
    expect(epochState("Collecting", { ...SCHED, depositCutoff: 0n }, VAULT_NOW)).toBe("open"); // unscheduled
  });

  it("derives NAV per share from held assets, a price and the supply", () => {
    // 95 NVDA at 213.375 + 300 USDG over 100 shares
    expect(formatUsdg(navPerShareRaw(95n * ONE, 300_000_000n, 213_375n * 10n ** 15n, 100n * ONE)!)).toBe("205.70625");
    expect(navPerShareRaw(95n * ONE, 300_000_000n, 213n * ONE, 0n)).toBeUndefined();
    expect(navPerShareRaw(95n * ONE, 300_000_000n, 0n, 100n * ONE)).toBeUndefined();
  });

  it("reads the strategy from the fund's names and parses share amounts", () => {
    expect(strategyFromNames("Hedgehood Covered Call NVDA", "hhNVDA-CC", "NVDA")).toEqual({ code: "CC", name: "Covered Call" });
    expect(strategyFromNames("Hedgehood Wheel NVDA", "hhNVDA-WHEEL")).toEqual({ code: "WHEEL", name: "Wheel" });
    expect(parseVaultShares("all", 7n * ONE)).toBe(7n * ONE);
    expect(parseVaultShares("2.5", 7n * ONE)).toBe(25n * 10n ** 17n);
    expect(() => parseVaultShares("1.1234567890123456789", 0n)).toThrow(/18 decimals/);
  });

  it("knows the mainnet and testnet deployments", () => {
    expect(getVaults(4663).funds.map((f) => f.symbol)).toEqual(["hhNVDA-CC", "hhNVDA-WHEEL", "hhGOOGL-CC", "hhTSLA-CC", "hhAMZN-CC", "hhMETA-CC", "hhAAPL-CC", "hhMSFT-CC"]);
    expect(getVaults(4663).api).toBe("https://hedgehood.app/api/stockyield/funds");
    expect(getVaults(46630).registry).toBe("0xBeE38aF4Fc4f50A0C04bDdA45Bec6cBABFf476b9");
  });
});

describe("VaultClient reads", () => {
  it("lists the registry's funds from the chain with NAV, epoch state, times, last week's yield and the account's position", async () => {
    const world = fakeWorld();
    const [v] = await client(world).listVaults();
    expect(v).toBeDefined();
    expect(v!.source).toBe("chain");
    expect(v!.symbol).toBe("hhNVDA-CC");
    expect(v!.strategy).toEqual({ code: "CC", name: "Covered Call" });
    expect(v!.stock).toEqual({ address: VAULT_STOCK, symbol: "NVDA", decimals: 18 });
    expect(v!.usdg).toBe(VAULT_USDG);
    expect(v!.gate).toEqual({ address: VAULT_GATE, kind: "open" });
    expect(formatUsdg(v!.nav.usdgPerShareRaw!)).toBe("205.70625");
    expect(v!.nav.source).toBe("mark"); // market closed: oracle.price() reverted, the fund's last mark is used
    expect(v!.epoch).toMatchObject({ index: 3n, phase: "Locked", state: "locked", nextCohort: 4n, nextFreezeAt: EPOCH4.depositCutoff, nextSettleAt: EPOCH3.expiry });
    expect(v!.lastEpoch).toMatchObject({ index: 2n, incomeUsdgRaw: 150_000_000n, weeklyYieldBps: 75 });
    expect(formatUsdg(v!.capUsedUsdgRaw)).toBe("20570.625");
    expect(v!.my).toMatchObject({ account: owner.address, sharesRaw: 5n * ONE, balanceRaw: 5n * ONE, canDeposit: true, walletUsdgRaw: 1_000_000_000n, claimableUsdgRaw: 0n });
    expect(v!.my!.pendingDeposit).toBeUndefined();
    expect(v!.my!.pendingRedeem).toBeUndefined();
    // the API was asked and answered 503: chain fallback, nothing else touched
    expect(world.backend.map((b) => b.url.pathname)).toEqual(["/api/stockyield/funds"]);
  });

  it("enriches from the public snapshot API when it answers for the chain, keeping the account reads on chain", async () => {
    const world = fakeWorld({ vaultApi: true });
    world.chain.vault.livePrice = 220n * ONE;
    const [v] = await client(world).listVaults();
    expect(v!.source).toBe("api");
    expect(v!.feeBps).toBe(2000);
    expect(v!.nav.source).toBe("live");
    expect(formatUsdg(v!.nav.usdgPerShareRaw!)).toBe("212"); // (95 * 220 + 300) / 100
    expect(v!.epoch.state).toBe("locked");
    expect(v!.my?.sharesRaw).toBe(5n * ONE);
    // apiUrl: false -> chain only
    const [c] = await client(world, { apiUrl: false }).listVaults();
    expect(c!.source).toBe("chain");
    expect(formatUsdg(c!.nav.usdgPerShareRaw!)).toBe("212");
  });

  it("reports open / frozen / settling epochs and the cohort a request would join", async () => {
    const open = fakeWorld();
    open.chain.vault.phase = 0;
    open.chain.vault.now = EPOCH3.depositCutoff - 3600n;
    const [o] = await client(open).listVaults();
    expect(o!.epoch).toMatchObject({ state: "open", nextCohort: 3n, nextFreezeAt: EPOCH3.depositCutoff, nextSettleAt: EPOCH3.expiry });
    const frozen = fakeWorld();
    frozen.chain.vault.phase = 0;
    frozen.chain.vault.now = EPOCH3.depositCutoff + 60n;
    expect((await client(frozen).listVaults())[0]!.epoch).toMatchObject({ state: "frozen", nextCohort: 4n, nextFreezeAt: EPOCH4.depositCutoff });
    const settling = fakeWorld();
    settling.chain.vault.now = EPOCH3.expiry + 60n;
    expect((await client(settling).listVaults())[0]!.epoch.state).toBe("settling");
  });

  it("shows queued requests with their cohort and whether they can still be cancelled, and claimables", async () => {
    const world = fakeWorld();
    world.chain.vault.account = { depositEpoch: 4n, depositStock: 0n, depositUsdg: 25_000_000n, redeemEpoch: 4n, redeemShares: 2n * ONE };
    world.chain.vault.preview = [0n, 0n, 7_500_000n];
    const [v] = await client(world).status();
    expect(v!.my!.pendingDeposit).toEqual({ epoch: 4n, stockRaw: 0n, usdgRaw: 25_000_000n, cancellable: true });
    expect(v!.my!.pendingRedeem).toEqual({ epoch: 4n, sharesRaw: 2n * ONE, cancellable: true });
    expect(v!.my!.claimableUsdgRaw).toBe(7_500_000n);
    // the cohort froze: the redemption is no longer cancellable (and is in claimable), the deposit became uncredited shares
    world.chain.vault.epochs["4"] = { frozenAt: EPOCH4.depositCutoff, settledAt: 0n, navPrice: 213n * ONE, navUsdg: 0n, depositStock: 0n, depositUsdg: 0n, income: 0n };
    world.chain.vault.now = EPOCH4.depositCutoff + 100n;
    world.chain.vault.currentEpoch = 4n;
    world.chain.vault.phase = 2;
    world.chain.vault.preview = [ONE / 8n, ONE / 50n, 7_500_000n];
    const [f] = await client(world).status();
    expect(f!.my!.pendingRedeem).toMatchObject({ cancellable: false });
    expect(f!.my!.pendingDeposit).toBeUndefined();
    expect(f!.my!.uncreditedSharesRaw).toBe(ONE / 8n);
    expect(f!.my!.sharesRaw).toBe(5n * ONE + ONE / 8n);
    expect(f!.epoch.state).toBe("frozen");
  });

  it("resolves a fund by address, symbol or unique ticker", async () => {
    const c = client();
    expect(await c.resolveVault(VAULT)).toBe(VAULT);
    expect(await c.resolveVault("hhNVDA-CC")).toBe(VAULT);
    expect(await c.resolveVault("nvda-cc")).toBe(VAULT);
    expect(await c.resolveVault("NVDA")).toBe(VAULT);
    await expect(c.resolveVault("hhTSLA-CC")).rejects.toThrow(/unknown vault/);
    const m = new VaultClient({ chainId: 4663, account: OTHER });
    await expect(m.resolveVault("NVDA")).rejects.toThrow(/several funds/);
  });
});

describe("VaultClient writes (dry run)", () => {
  const selector = (sig: string) => toFunctionSelector(sig);

  it("plans a USDG deposit as approve + requestDeposit, simulating what it can, and checks the gate and wallet first", async () => {
    const world = fakeWorld();
    const c = client(world);
    const { plan, results } = await c.requestDeposit({ vault: VAULT, usdgRaw: 25_000_000n });
    expect(plan.steps.map((s) => s.kind)).toEqual(["approve", "requestDeposit"]);
    expect(plan.steps[0]!.to).toBe(VAULT_USDG);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.steps[0]!.data })).toEqual({ functionName: "approve", args: [VAULT, 25_000_000n] });
    expect(plan.steps[1]!.to).toBe(VAULT);
    expect(decodeFunctionData({ abi: epochFundAbi, data: plan.steps[1]!.data })).toEqual({ functionName: "requestDeposit", args: [0n, 25_000_000n, owner.address] });
    expect(results.map((r) => [r.kind, r.dryRun, r.simulated])).toEqual([["approve", true, true], ["requestDeposit", true, false]]);
    expect(world.chain.simulated).toEqual([plan.steps[0]!.data]); // only the approve was simulated; the deposit needs it mined
    // enough allowance: one simulated step
    const ready = fakeWorld();
    ready.chain.vault.usdgAllowance = 100_000_000n;
    const r2 = await client(ready).requestDeposit({ vault: VAULT, usdgRaw: 25_000_000n, receiver: OTHER });
    expect(r2.plan.steps.map((s) => s.kind)).toEqual(["requestDeposit"]);
    expect(r2.results[0]!.simulated).toBe(true);
    expect(decodeFunctionData({ abi: epochFundAbi, data: r2.plan.steps[0]!.data }).args).toEqual([0n, 25_000_000n, OTHER]);
    // stock + USDG: two approvals
    const both = await client(fakeWorld()).planDeposit({ vault: VAULT, usdgRaw: 25_000_000n, stockRaw: ONE });
    expect(both.steps.map((s) => [s.kind, s.to])).toEqual([["approve", VAULT_USDG], ["approve", VAULT_STOCK], ["requestDeposit", VAULT]]);
    // refusals explained before anything is simulated
    const gated = fakeWorld();
    gated.chain.vault.canDeposit = false;
    await expect(client(gated).planDeposit({ vault: VAULT, usdgRaw: 25_000_000n })).rejects.toThrow(/deposit gate/);
    const poor = fakeWorld();
    poor.chain.vault.walletUsdg = 1_000_000n;
    await expect(client(poor).planDeposit({ vault: VAULT, usdgRaw: 25_000_000n })).rejects.toThrow(/holds 1 USDG/);
    const paused = fakeWorld();
    paused.chain.vault.paused = true;
    await expect(client(paused).planDeposit({ vault: VAULT, usdgRaw: 25_000_000n })).rejects.toThrow(/paused/);
    await expect(client().planDeposit({ vault: VAULT, usdgRaw: 10n })).rejects.toThrow(/MIN_USDG/);
    await expect(client().planDeposit({ vault: VAULT })).rejects.toThrow(/at least some/);
  });

  it("plans a redemption of an amount or all (balance + uncredited), refusing more than held", async () => {
    const world = fakeWorld();
    world.chain.vault.preview = [ONE / 2n, 0n, 0n];
    const c = client(world);
    const all = await c.planRedeem({ vault: VAULT, shares: "all" });
    expect(all.steps[0]!.data.startsWith(selector("requestRedeem(uint256,address)"))).toBe(true);
    expect(decodeFunctionData({ abi: epochFundAbi, data: all.steps[0]!.data }).args).toEqual([55n * 10n ** 17n, owner.address]);
    const some = await c.planRedeem({ vault: VAULT, shares: "2.5" });
    expect(decodeFunctionData({ abi: epochFundAbi, data: some.steps[0]!.data }).args).toEqual([25n * 10n ** 17n, owner.address]);
    expect(some.summary).toMatch(/redeem 2.5 of 5.5 hhNVDA-CC/);
    await expect(c.planRedeem({ vault: VAULT, shares: "9" })).rejects.toThrow(/holds 5.5/);
    const empty = fakeWorld();
    empty.chain.vault.balance = 0n;
    await expect(client(empty).planRedeem({ vault: VAULT, shares: "all" })).rejects.toThrow(/nothing to redeem/);
    const sent = await c.sendPlan(some);
    expect(sent[0]).toMatchObject({ kind: "requestRedeem", dryRun: true, simulated: true, from: owner.address });
    expect(world.chain.simulated).toEqual([some.steps[0]!.data]);
  });

  it("plans claim and the two cancels for the account, to the owner by default", async () => {
    const world = fakeWorld();
    await expect(client(world).planClaim({ vault: VAULT })).rejects.toThrow(/nothing to claim/);
    world.chain.vault.preview = [0n, ONE / 10n, 12_000_000n];
    const claim = await client(world).planClaim({ vault: VAULT });
    expect(decodeFunctionData({ abi: epochFundAbi, data: claim.steps[0]!.data })).toEqual({ functionName: "claim", args: [owner.address, owner.address] });
    expect(claim.summary).toBe(`claim 0.1 stock + 12 USDG from hhNVDA-CC to ${owner.address}`);
    const claimTo = await client(world).planClaim({ vault: VAULT, to: OTHER });
    expect(decodeFunctionData({ abi: epochFundAbi, data: claimTo.steps[0]!.data }).args).toEqual([owner.address, OTHER]);
    const cd = await client(world).planCancelDeposit({ vault: VAULT, to: OTHER });
    expect(decodeFunctionData({ abi: epochFundAbi, data: cd.steps[0]!.data })).toEqual({ functionName: "cancelDeposit", args: [owner.address, OTHER] });
    const cr = await client(world).planCancelRedeem({ vault: VAULT });
    expect(decodeFunctionData({ abi: epochFundAbi, data: cr.steps[0]!.data })).toEqual({ functionName: "cancelRedeem", args: [owner.address] });
  });

  it("refuses to act for an account the signer does not own or manage, and without a signer", async () => {
    const c = client(fakeWorld(), { account: OTHER });
    await expect(c.planRedeem({ vault: VAULT, shares: "1" })).rejects.toThrow(/neither the account/);
    await expect(c.planClaim({ vault: VAULT })).rejects.toThrow(/neither the account/);
    const none = new VaultClient({ chainId: 46630, account: OTHER, fetch: fakeWorld().fetch });
    await expect(none.planDeposit({ vault: VAULT, usdgRaw: 25_000_000n })).rejects.toThrow(/no signer/);
    expect(defaultChain().vault.currentEpoch).toBe(3n);
  });
});
