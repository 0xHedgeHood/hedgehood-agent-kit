import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  LendingClient,
  accrueInterestView,
  aboveLtvWarnLine,
  annualize,
  borrowAssetsOf,
  collateralValueRaw,
  erc20Abi,
  formatUsdg,
  getLending,
  healthFactor,
  liquidationPriceRaw,
  loanToValue,
  marketIdOf,
  maxBorrowRaw,
  morphoBlueAbi,
  toAssetsUp,
  vaultV2Abi,
  wTaylorCompounded,
} from "../src/index.js";
import { LEND_BLUE, LEND_MARKET_ID, LEND_MARKET_ID_2, LEND_ORACLE, LEND_PARAMS, LEND_PARAMS_2, LEND_PRICE, LEND_RATE, LEND_VAULT, ONE, VAULT, VAULT_NOW, VAULT_USDG, fakeWorld } from "../../mcp/test/fakes.js";

const owner = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // anvil #0, throwaway
const OTHER: Address = "0x4444444444444444444444444444444444444444";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

function client(world = fakeWorld(), extra: Partial<ConstructorParameters<typeof LendingClient>[0]> = {}) {
  return new LendingClient({ chainId: 46630, account: owner.address, signer: owner, fetch: world.fetch, ...extra });
}
const dec = (data: `0x${string}`) => decodeFunctionData({ abi: morphoBlueAbi, data });

describe("Blue math", () => {
  it("computes market ids, collateral value, max borrow, health factor, LTV and liquidation price", () => {
    // mainnet collateral-01: keccak256(abi.encode(params)) is the id Blue uses
    expect(marketIdOf({ loanToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", collateralToken: "0x4a1c42b0E0D229B677D574d3dCdc2A5Dff848373", oracle: "0x6EcA44BBB41D3176A451910C4f735A51AdAb4237", irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1", lltv: 625000000000000000n })).toBe("0x789202f84d066bdad8115d39d5dea0af80ccd52dd6727461d98daa638ed9b7aa");
    const lltv = 625000000000000000n;
    // 100 shares at 0.95 USDG: value 95, max borrow 59.375
    expect(formatUsdg(collateralValueRaw(100n * ONE, LEND_PRICE))).toBe("95");
    expect(formatUsdg(maxBorrowRaw(100n * ONE, LEND_PRICE, lltv))).toBe("59.375");
    expect(healthFactor(59_375_000n, 0n)).toBeNull();
    expect(healthFactor(59_375_000n, 40_000_000n)).toBe(1.4843);
    expect(healthFactor(59_375_000n, 60_000_000n)).toBe(0.9895);
    expect(loanToValue(40_000_000n, 95_000_000n)).toBe(0.421);
    expect(loanToValue(1n, 0n)).toBeNull();
    // debt 40 against 100 shares liquidates when a share is worth 40 / (100 x 0.625) = 0.64 USDG
    const lp = liquidationPriceRaw(100n * ONE, 40_000_000n, lltv)!;
    expect(lp / 10n ** 18n).toBe(640_000n);
    expect(liquidationPriceRaw(0n, 40_000_000n, lltv)).toBeNull();
    expect(liquidationPriceRaw(100n * ONE, 0n, lltv)).toBeNull();
    // the comfort line: 70% of LLTV = 43.75% of the collateral value (41.5625 of 95)
    expect(aboveLtvWarnLine(41_562_500n, 95_000_000n, lltv)).toBe(false);
    expect(aboveLtvWarnLine(41_562_501n, 95_000_000n, lltv)).toBe(true);
    expect(annualize(LEND_RATE)).toBeCloseTo(0.0116, 4);
  });

  it("accrues interest like Blue (Taylor-compounded) and rounds debt up from shares", () => {
    const m = { totalSupplyAssets: 1_500_000_000n, totalSupplyShares: 1_500_000_000_000_000n, totalBorrowAssets: 670_000_000n, totalBorrowShares: 670_000_000_000_000n, lastUpdate: VAULT_NOW, fee: 0n };
    expect(accrueInterestView(m, LEND_RATE, VAULT_NOW)).toEqual(m);
    const year = accrueInterestView(m, LEND_RATE, VAULT_NOW + 365n * 86400n);
    // 670 x (e^0.0116 - 1) ≈ 7.8175; the three-term Taylor sum agrees to the cent
    expect(year.totalBorrowAssets - 670_000_000n).toBe(7_817_460n);
    expect(year.totalSupplyAssets - 1_500_000_000n).toBe(7_817_460n);
    expect(year.totalSupplyShares).toBe(m.totalSupplyShares);
    expect(wTaylorCompounded(10n ** 18n, 1n)).toBe(10n ** 18n + 5n * 10n ** 17n + (5n * 10n ** 17n) / 3n);
    // a Blue fee mints supply shares to the fee recipient
    const withFee = accrueInterestView({ ...m, fee: 10n ** 17n }, LEND_RATE, VAULT_NOW + 365n * 86400n);
    expect(withFee.totalSupplyShares).toBeGreaterThan(m.totalSupplyShares);
    expect(borrowAssetsOf(670_000_000_000_000n, year)).toBe(toAssetsUp(670_000_000_000_000n, year.totalBorrowAssets, year.totalBorrowShares));
    expect(borrowAssetsOf(670_000_000_000_000n, year)).toBe(677_817_460n);
  });

  it("knows the mainnet and testnet deployments", () => {
    expect(getLending(4663).blue).toBe("0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010");
    expect(getLending(4663).vault).toBe("0x54Bc097643BB9fd4ab004f11859893655529E954");
    expect(getLending(4663).markets[0]!.id).toBe(marketIdOf(getLending(4663).markets[0]!));
    expect(getLending(46630).markets[0]!.id).toBe(LEND_MARKET_ID);
    expect(getLending(46630).markets[0]!.id).toBe(marketIdOf(LEND_PARAMS));
  });
});

describe("LendingClient reads", () => {
  it("discovers the market from the vault's liquidity adapter and falls back to the registry when the vault is unreadable", async () => {
    const world = fakeWorld();
    const d = await client(world).discoverMarkets();
    expect(d).toMatchObject({ source: "vault", adapter: "0x89ace3cb69f676d41aBa380563F267cD7b8A98f3", liquidityMarketId: LEND_MARKET_ID });
    expect(d.markets.map((m) => m.id)).toEqual([LEND_MARKET_ID]);
    // the vault switched to a new market (oracle migration): discovered without any config change, the old one is kept from the registry
    const migrated = fakeWorld();
    migrated.chain.lending.liquidityParams = LEND_PARAMS_2;
    migrated.chain.lending.adapterMarketIds = [LEND_MARKET_ID_2];
    const d2 = await client(migrated).discoverMarkets();
    expect(d2.liquidityMarketId).toBe(LEND_MARKET_ID_2);
    expect(d2.markets.map((m) => m.id)).toEqual([LEND_MARKET_ID_2, LEND_MARKET_ID]);
    expect(d2.markets[0]!.oracle).toBe(LEND_PARAMS_2.oracle);
    expect(d2.markets[1]!.note).toMatch(/not currently supplied/);
    const { market } = await client(migrated).resolveMarket();
    expect(market.id).toBe(LEND_MARKET_ID_2);
    // no liquidity adapter and no allocations: the registry
    const none = fakeWorld();
    none.chain.lending.liquidityAdapter = ZERO;
    none.chain.lending.adapterMarketIds = [];
    const d3 = await client(none).discoverMarkets();
    expect(d3.source).toBe("config");
    expect(d3.markets[0]!.id).toBe(LEND_MARKET_ID);
    await expect(client().resolveMarket("0x" + "ab".repeat(32))).rejects.toThrow(/does not exist on Blue/);
    await expect(client().resolveMarket("nvda")).rejects.toThrow(/32-byte id/);
  });

  it("lendStatus: vault size, caps, liquidity, supply rate after the fee, oracle and the account's shares", async () => {
    const world = fakeWorld();
    const s = await client(world).lendStatus();
    expect(s).toMatchObject({ vault: LEND_VAULT, symbol: "hhUSDG", asset: VAULT_USDG, discovery: "vault", totalAssetsRaw: 1_500_000_000n, idleRaw: 0n, allocatedRaw: 1_500_000_000n, capRaw: 100_000_000_000n, capLeftRaw: 98_500_000_000n, performanceFee: 0.1 });
    expect(s.utilization).toBeCloseTo(0.446667, 5);
    expect(s.liquidityRaw).toBe(830_000_000n); // idle 0 + unborrowed 830
    // 1.16% x 44.67% x 100% allocated x 0.9
    expect(s.supplyApy).toBeCloseTo(0.0116 * 0.446667 * 0.9, 4);
    expect(s.supplyApyNote).toMatch(/borrow rate 1.16% x utilization 44.67%/);
    expect(s.market?.id).toBe(LEND_MARKET_ID);
    expect(s.oracle).toMatchObject({ address: LEND_ORACLE, state: "live", priceRaw: LEND_PRICE, collateralPriceUsdgRaw: 950_000n });
    expect(s.my).toEqual({ account: owner.address, sharesRaw: 100n * ONE, assetsRaw: 100_000_000n, walletUsdgRaw: 1_000_000_000n, canDeposit: true, canWithdraw: true });
    // idle USDG adds to the liquidity; no borrowers means no yield
    const idle = fakeWorld();
    idle.chain.lending.vaultIdle = 50_000_000n;
    idle.chain.lending.market.totalBorrowAssets = 0n;
    idle.chain.lending.market.totalBorrowShares = 0n;
    const s2 = await client(idle).lendStatus(null);
    expect(s2.liquidityRaw).toBe(1_550_000_000n);
    expect(s2.supplyApy).toBe(0);
    expect(s2.my).toBeUndefined();
  });

  it("borrowStatus: accrued debt, HF, LTV, liquidation price and warnings", async () => {
    const world = fakeWorld();
    const s = await client(world).borrowStatus();
    expect(s.market).toMatchObject({ id: LEND_MARKET_ID, lltv: 625000000000000000n, oraclePriceRaw: LEND_PRICE, collateralPriceUsdgRaw: 950_000n, totalSupplyRaw: 1_500_000_000n, totalBorrowRaw: 670_000_000n, available: 830_000_000n, isLiquidityMarket: true, borrowRatePerSecondRaw: LEND_RATE });
    expect(s.market.borrowRate).toBeCloseTo(0.0116, 4);
    expect(s.market.oracleStatus.state).toBe("live");
    expect(s.my).toMatchObject({ collateralRaw: 100n * ONE, borrowAssetsRaw: 0n, borrowSharesRaw: 0n, collateralValueRaw: 95_000_000n, maxBorrowRaw: 59_375_000n, borrowableRaw: 59_375_000n, recommendedBorrowableRaw: 41_562_500n, healthFactor: null, ltv: 0, liquidationPriceRaw: null, walletSharesRaw: 5n * ONE, walletUsdgRaw: 1_000_000_000n });
    expect(s.warnings).toEqual([]);
    // 40 USDG of debt, accrued for a day
    world.chain.lending.position.borrowShares = 40_000_000_000_000n;
    world.chain.lending.market.lastUpdate = VAULT_NOW - 86400n;
    const d = await client(world).borrowStatus();
    expect(d.my.borrowAssetsRaw).toBe(40_001_272n); // 40 x 1.16% / 365 ≈ 0.00127 of interest, debt rounded up
    expect(d.my.healthFactor).toBe(1.4843);
    expect(d.my.ltv).toBe(0.421);
    expect(d.my.liquidationPriceUsdgRaw).toBe(640_020n);
    expect(d.my.borrowableRaw).toBe(59_375_000n - 40_001_272n);
    expect(d.warnings).toEqual([]);
    // above the comfort line, then liquidatable, then the oracle fails closed
    world.chain.lending.position.borrowShares = 45_000_000_000_000n;
    world.chain.lending.market.lastUpdate = VAULT_NOW;
    expect((await client(world).borrowStatus()).warnings[0]).toMatch(/LTV 47.36% is above 70% of the LLTV/);
    world.chain.lending.position.borrowShares = 60_000_000_000_000n;
    const liq = await client(world).borrowStatus();
    expect(liq.my.healthFactor).toBe(0.9895);
    expect(liq.warnings[0]).toMatch(/can be liquidated now/);
    world.chain.lending.oraclePrice = null;
    const dark = await client(world).borrowStatus();
    expect(dark.market.oracleStatus).toMatchObject({ state: "unavailable" });
    expect(dark.market.oracleStatus.error).toMatch(/Unavailable/);
    expect(dark.my).toMatchObject({ collateralValueRaw: null, maxBorrowRaw: null, healthFactor: null, ltv: null, borrowAssetsRaw: 60_000_000n });
    expect(dark.warnings[0]).toMatch(/no usable price/);
    // market closed: held print
    world.chain.lending.oraclePrice = LEND_PRICE;
    world.chain.lending.spotLive = false;
    expect((await client(world).borrowStatus()).market.oracleStatus.state).toBe("held");
    // another market by id
    const other = await client(fakeWorld()).borrowStatus(owner.address, LEND_MARKET_ID_2);
    expect(other.market).toMatchObject({ id: LEND_MARKET_ID_2, oracle: LEND_PARAMS_2.oracle, isLiquidityMarket: false });
    expect(other.my.collateralRaw).toBe(0n);
  });
});

describe("LendingClient plans (dry run)", () => {
  it("lend deposit: approve when short + deposit(onBehalf); refuses over the cap, without balance or when gated", async () => {
    const world = fakeWorld();
    const { plan, results } = await client(world).lendDeposit({ usdgRaw: 25_000_000n });
    expect(plan.steps.map((s) => [s.kind, s.to])).toEqual([["approve", VAULT_USDG], ["deposit", LEND_VAULT]]);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.steps[0]!.data })).toEqual({ functionName: "approve", args: [LEND_VAULT, 25_000_000n] });
    expect(decodeFunctionData({ abi: vaultV2Abi, data: plan.steps[1]!.data })).toEqual({ functionName: "deposit", args: [25_000_000n, owner.address] });
    expect(results.map((r) => [r.kind, r.dryRun, r.simulated])).toEqual([["approve", true, true], ["deposit", true, false]]);
    expect(world.chain.simulated).toEqual([plan.steps[0]!.data]);
    expect(plan.summary).toMatch(/lend 25 USDG into hhUSDG/);
    world.chain.lending.usdgAllowanceVault = 10n ** 9n;
    const ready = await client(world).planLendDeposit({ usdgRaw: 25_000_000n, receiver: OTHER });
    expect(ready.steps.map((s) => s.kind)).toEqual(["deposit"]);
    expect(decodeFunctionData({ abi: vaultV2Abi, data: ready.steps[0]!.data }).args).toEqual([25_000_000n, OTHER]);
    await expect(client(world).planLendDeposit({ usdgRaw: 999_000_000_000n })).rejects.toThrow(/holds 1000 USDG/);
    world.chain.lending.absoluteCap = 1_510_000_000n;
    await expect(client(world).planLendDeposit({ usdgRaw: 25_000_000n })).rejects.toThrow(/room for 10 USDG/);
    world.chain.lending.absoluteCap = 100_000_000_000n;
    world.chain.lending.canReceiveShares = false;
    await expect(client(world).planLendDeposit({ usdgRaw: 25_000_000n })).rejects.toThrow(/receive-shares gate/);
    await expect(client(world).planLendDeposit({ usdgRaw: 0n })).rejects.toThrow(/positive/);
  });

  it("lend withdraw: withdraw(assets) for an amount, redeem(all shares) for all; bounded by holdings and liquidity", async () => {
    const world = fakeWorld();
    const some = await client(world).planLendWithdraw({ usdg: "40" });
    expect(decodeFunctionData({ abi: vaultV2Abi, data: some.steps[0]!.data })).toEqual({ functionName: "withdraw", args: [40_000_000n, owner.address, owner.address] });
    expect(some.steps[0]!.kind).toBe("withdraw");
    const all = await client(world).planLendWithdraw({ usdg: "all", receiver: OTHER });
    expect(decodeFunctionData({ abi: vaultV2Abi, data: all.steps[0]!.data })).toEqual({ functionName: "redeem", args: [100n * ONE, OTHER, owner.address] });
    expect(all.summary).toMatch(/withdraw 100 of 100 USDG/);
    await expect(client(world).planLendWithdraw({ usdg: "100.5" })).rejects.toThrow(/worth 100 USDG/);
    world.chain.lending.market.totalBorrowAssets = 1_480_000_000n; // 20 USDG left unborrowed
    await expect(client(world).planLendWithdraw({ usdg: "40" })).rejects.toThrow(/only 20 USDG can be withdrawn/);
    const tight = await client(world).planLendWithdraw({ usdg: "19" });
    expect(tight.warnings[0]).toMatch(/nearly all/);
    world.chain.lending.vaultShares = 0n;
    await expect(client(world).planLendWithdraw({ usdg: "all" })).rejects.toThrow(/nothing to withdraw/);
    await expect(client(fakeWorld(), { account: OTHER }).planLendWithdraw({ usdg: "1" })).rejects.toThrow(/not the account/);
  });

  it("supplyCollateral: approve the fund shares to Blue + supplyCollateral(params, shares, account, 0x); all = wallet balance", async () => {
    const world = fakeWorld();
    const { plan, results } = await client(world).supplyCollateral({ shares: "2" });
    expect(plan.steps.map((s) => [s.kind, s.to])).toEqual([["approve", VAULT], ["supplyCollateral", LEND_BLUE]]);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.steps[0]!.data })).toEqual({ functionName: "approve", args: [LEND_BLUE, 2n * ONE] });
    expect(dec(plan.steps[1]!.data)).toEqual({ functionName: "supplyCollateral", args: [{ ...LEND_PARAMS }, 2n * ONE, owner.address, "0x"] });
    expect(results.map((r) => r.simulated)).toEqual([true, false]);
    expect(plan.after).toMatchObject({ collateralRaw: 102n * ONE, borrowAssetsRaw: 0n, healthFactor: null });
    world.chain.lending.shareAllowanceBlue = 10n * ONE;
    const all = await client(world).planSupplyCollateral({ shares: "all" });
    expect(all.steps.map((s) => s.kind)).toEqual(["supplyCollateral"]);
    expect((dec(all.steps[0]!.data).args as unknown as unknown[])[1]).toBe(5n * ONE);
    await expect(client(world).planSupplyCollateral({ shares: "9" })).rejects.toThrow(/holds 5 fund shares/);
    world.chain.vault.balance = 0n;
    await expect(client(world).planSupplyCollateral({ shares: "all" })).rejects.toThrow(/claim them from the fund first/);
    // works while the oracle is dark (nothing is borrowed), but the status warning is carried
    const dark = fakeWorld();
    dark.chain.lending.oraclePrice = null;
    const p = await client(dark).planSupplyCollateral({ shares: "1" });
    expect(p.warnings[0]).toMatch(/no usable price/);
  });

  it("borrow: HF >= 1 after, warns above 70% of LLTV, refuses without oracle, liquidity or authorization", async () => {
    const world = fakeWorld();
    const ok = await client(world).planBorrow({ usdgRaw: 30_000_000n });
    expect(dec(ok.steps[0]!.data)).toEqual({ functionName: "borrow", args: [{ ...LEND_PARAMS }, 30_000_000n, 0n, owner.address, owner.address] });
    expect(ok.after).toMatchObject({ collateralRaw: 100n * ONE, borrowAssetsRaw: 30_000_000n, healthFactor: 1.9791, ltv: 0.3157 });
    expect(ok.after!.liquidationPriceUsdgRaw).toBe(480_000n);
    expect(ok.warnings).toEqual([]);
    expect(ok.summary).toMatch(/borrow 30 USDG against 100 fund shares/);
    const warned = await client(world).planBorrow({ usdgRaw: 50_000_000n, receiver: OTHER });
    expect(warned.warnings[0]).toMatch(/WARNING: LTV after 52.63% is above 70% of the LLTV 62.50%/);
    expect((dec(warned.steps[0]!.data).args as unknown as unknown[])[4]).toBe(OTHER);
    await expect(client(world).planBorrow({ usdgRaw: 59_375_001n })).rejects.toThrow(/health factor 0.9999 < 1/);
    await expect(client(world).planBorrow({ usdgRaw: 59_375_000n })).resolves.toMatchObject({ after: { healthFactor: 1 } });
    await expect(client(world).planBorrow({ usdgRaw: 900_000_000n })).rejects.toThrow(/830 USDG unborrowed/);
    // existing debt counts
    world.chain.lending.position.borrowShares = 40_000_000_000_000n;
    await expect(client(world).planBorrow({ usdgRaw: 20_000_000n })).rejects.toThrow(/debt 60 USDG would exceed the LLTV bound 59.375/);
    // oracle fail-closed
    world.chain.lending.oraclePrice = null;
    await expect(client(world).planBorrow({ usdgRaw: 1_000_000n })).rejects.toThrow(/no usable price/);
    // no collateral, foreign account
    const none = fakeWorld();
    none.chain.lending.position.collateral = 0n;
    await expect(client(none).planBorrow({ usdgRaw: 1_000_000n })).rejects.toThrow(/no collateral/);
    await expect(client(fakeWorld(), { account: OTHER }).planBorrow({ usdgRaw: 1_000_000n })).rejects.toThrow(/nor authorized on Blue/);
    const authorized = fakeWorld();
    authorized.chain.lending.isAuthorized = true;
    await expect(client(authorized, { account: OTHER }).planBorrow({ usdgRaw: 1_000_000n })).resolves.toMatchObject({ account: OTHER });
    // held print: allowed, noted
    const held = fakeWorld();
    held.chain.lending.spotLive = false;
    expect((await client(held).planBorrow({ usdgRaw: 1_000_000n })).warnings[0]).toMatch(/holding the last print/);
  });

  it("repay: by assets for an amount, by shares for all (with an approval margin); bounded by debt and wallet", async () => {
    const world = fakeWorld();
    world.chain.lending.position.borrowShares = 40_000_000_000_000n;
    const some = await client(world).planRepay({ usdg: "10" });
    expect(some.steps.map((s) => [s.kind, s.to])).toEqual([["approve", VAULT_USDG], ["repay", LEND_BLUE]]);
    expect(decodeFunctionData({ abi: erc20Abi, data: some.steps[0]!.data }).args).toEqual([LEND_BLUE, 10_000_000n]);
    expect(dec(some.steps[1]!.data)).toEqual({ functionName: "repay", args: [{ ...LEND_PARAMS }, 10_000_000n, 0n, owner.address, "0x"] });
    expect(some.after).toMatchObject({ borrowAssetsRaw: 30_000_000n, healthFactor: 1.9791 });
    const all = await client(world).planRepay({ usdg: "all" });
    expect(dec(all.steps[1]!.data)).toEqual({ functionName: "repay", args: [{ ...LEND_PARAMS }, 0n, 40_000_000_000_000n, owner.address, "0x"] });
    const approved = decodeFunctionData({ abi: erc20Abi, data: all.steps[0]!.data }).args![1] as bigint;
    expect(approved).toBeGreaterThan(40_000_000n); // an hour of interest as margin
    expect(approved).toBeLessThan(40_000_100n);
    expect(all.after).toMatchObject({ borrowAssetsRaw: 0n, healthFactor: null });
    await expect(client(world).planRepay({ usdg: "41" })).rejects.toThrow(/debt is 40 USDG, less than 41; use "all"/);
    world.chain.vault.walletUsdg = 40_000_000n;
    expect((await client(world).planRepay({ usdg: "all" })).warnings[0]).toMatch(/barely the debt/);
    world.chain.vault.walletUsdg = 1_000_000n;
    await expect(client(world).planRepay({ usdg: "all" })).rejects.toThrow(/holds 1 USDG/);
    world.chain.lending.position.borrowShares = 0n;
    await expect(client(world).planRepay({ usdg: "all" })).rejects.toThrow(/nothing to repay/);
    // repay works while the oracle is dark
    const dark = fakeWorld();
    dark.chain.lending.position.borrowShares = 40_000_000_000_000n;
    dark.chain.lending.oraclePrice = null;
    await expect(client(dark).planRepay({ usdg: "all" })).resolves.toMatchObject({ action: "repay" });
  });

  it("withdrawCollateral: HF >= 1 after with debt, all only once repaid, oracle needed only with debt", async () => {
    const world = fakeWorld();
    const free = await client(world).planWithdrawCollateral({ shares: "all" });
    expect(dec(free.steps[0]!.data)).toEqual({ functionName: "withdrawCollateral", args: [{ ...LEND_PARAMS }, 100n * ONE, owner.address, owner.address] });
    // no debt: the oracle is not consulted by Blue, so a dark oracle is fine
    world.chain.lending.oraclePrice = null;
    await expect(client(world).planWithdrawCollateral({ shares: "10", receiver: OTHER })).resolves.toMatchObject({ after: { collateralRaw: 90n * ONE } });
    world.chain.lending.oraclePrice = LEND_PRICE;
    world.chain.lending.position.borrowShares = 40_000_000_000_000n;
    await expect(client(world).planWithdrawCollateral({ shares: "all" })).rejects.toThrow(/40 USDG is still owed; repay first/);
    // 40 debt needs 40 / 0.625 / 0.95 = 67.37 shares; 32 can go, 33 cannot
    const ok = await client(world).planWithdrawCollateral({ shares: "32" });
    expect(ok.after).toMatchObject({ collateralRaw: 68n * ONE, healthFactor: 1.0093 });
    expect(ok.warnings[0]).toMatch(/WARNING: LTV after 61.91%/);
    await expect(client(world).planWithdrawCollateral({ shares: "33" })).rejects.toThrow(/health factor 0.9945 < 1/);
    await expect(client(world).planWithdrawCollateral({ shares: "101" })).rejects.toThrow(/less than 101/);
    world.chain.lending.oraclePrice = null;
    await expect(client(world).planWithdrawCollateral({ shares: "1" })).rejects.toThrow(/no usable price/);
    const sent = await client(fakeWorld()).sendPlan(free);
    expect(sent[0]).toMatchObject({ kind: "withdrawCollateral", dryRun: true, simulated: true, from: owner.address });
    const none = new LendingClient({ chainId: 46630, account: OTHER, fetch: fakeWorld().fetch });
    await expect(none.planLendDeposit({ usdgRaw: 1_000_000n })).rejects.toThrow(/no signer/);
  });
});
