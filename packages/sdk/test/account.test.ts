import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, fundingAdvice, getDeployment, MarketClient, marketV2Abi, orderBookV2Abi, planDeposit, planFillFunding, planRebalance, planWithdrawAll, readAccount, resolveMarket, Side, UNLIMITED, type Order } from "../src/index.js";
import { AMD_MARKET, CALL220, GOOGL_BOOK, GOOGL_MARKET, ONE, fakeWorld, maker, multiMarketChain, withGlobalFetch } from "../../mcp/test/fakes.js";

const owner = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
const session = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const SIG = ("0x" + "ab".repeat(65)) as Hex;
const now = () => Math.floor(Date.now() / 1000);

/** A GOOGL quote addressed to the owner: an ask (the account buys) or a bid (it sells), 1.68 per share. */
function googlOrder(side: "buy" | "sell", quantityRaw = ONE): Order {
  const t = now();
  return {
    maker: maker.address, signer: maker.address, taker: owner.address, chainId: 46630n, settlement: GOOGL_BOOK, market: GOOGL_MARKET, instrumentId: CALL220,
    side: side === "buy" ? Side.Ask : Side.Bid, quantityRaw, minFillRaw: 0n, premiumStartRaw: 1_680_000n, premiumEndRaw: 1_680_000n,
    startTime: BigInt(t - 1), validUntil: BigInt(t + 20), stockMultiplier: ONE, nonce: 1n, fromBalance: true,
  };
}

const call = (data: Hex) => decodeFunctionData({ abi: [...marketV2Abi, ...orderBookV2Abi, ...erc20Abi], data });

describe("one account across markets", () => {
  it("resolves a market by ticker or address", () => {
    expect(resolveMarket(46630, "googl").market).toBe(GOOGL_MARKET);
    expect(resolveMarket(46630, GOOGL_BOOK.toLowerCase()).underlying).toBe("GOOGL");
    expect(() => resolveMarket(46630, "0x" + "12".repeat(20))).toThrow(/not a listed market/);
    expect(() => resolveMarket(46630, "XYZ")).toThrow(/no market for XYZ/);
  });

  it("reads every market in one view, marks a failing market and lists where a session key can trade", async () => {
    const world = fakeWorld({ chain: multiMarketChain() });
    const v = await withGlobalFetch(world.fetch, () => readAccount({ chainId: 46630, account: owner.address, key: session.address }));
    expect(v.markets).toHaveLength(getDeployment(46630).markets.length);
    expect(v.keyRole).toBe("session");
    expect(v.walletUsdgRaw).toBe(500_000_000n);
    const by = Object.fromEntries(v.markets.map((m) => [m.underlying, m]));
    expect(by.NVDA).toMatchObject({ collateralRaw: 250_000_000n, requirementRaw: 10_000_000n, freeCollateralRaw: 240_000_000n, openPositions: 2, canTradeFromBalance: true });
    expect(by.NVDA!.session).toMatchObject({ active: true, canTrade: true, spendLeft: 40_000_000n });
    expect(by.AMD).toMatchObject({ freeCollateralRaw: 30_000_000n, openPositions: 0, canTradeFromBalance: false });
    expect(by.AMD!.session!.active).toBe(false);
    expect(by.GOOGL).toMatchObject({ collateralRaw: 0n, canTradeFromBalance: false });
    expect(by.TSLA!.error).toMatch(/collateral.*reverted/);
    expect(v.failed).toEqual(["TSLA"]);
    expect(v.tradable).toEqual(["NVDA"]);
    expect(v.totals).toMatchObject({ collateralRaw: 280_000_000n, requirementRaw: 10_000_000n, freeCollateralRaw: 270_000_000n, openPositions: 2 });
    // the account's own key trades wherever there is free balance (and in wallet mode everywhere)
    const self = await withGlobalFetch(world.fetch, () => readAccount({ chainId: 46630, account: owner.address, key: owner.address }));
    expect(self.keyRole).toBe("owner");
    expect(self.tradable).toEqual(["NVDA", "AMD"]);
    expect(self.markets[0]!.session).toBeUndefined();
  });

  it("names the shortfall, the free balance elsewhere and the owner command that fixes it", async () => {
    const world = fakeWorld({ chain: multiMarketChain() });
    const v = await withGlobalFetch(world.fetch, () => readAccount({ chainId: 46630, account: owner.address, key: session.address }));
    const a = fundingAdvice(v, "googl", 12_500_000n);
    expect(a.rebalanceFrom).toBe("NVDA");
    expect(a.freeElsewhere.map((x) => x.underlying)).toEqual(["NVDA", "AMD"]);
    expect(a.cli).toEqual(["hedgehood rebalance --from NVDA --to GOOGL --amount 12.5 --send", "hedgehood deposit 12.5 --market GOOGL --wallet --send"]);
    expect(a.mcp[0]).toBe('rebalance { from: "NVDA", to: "GOOGL", amount: "12.5", confirm: true, dryRun: false }');
    expect(a.message).toMatch(/GOOGL market balance is short by 12.5 USDG/);
    expect(a.message).toMatch(/Free balance in other markets: NVDA 240, AMD 30/);
    const big = fundingAdvice(v, "GOOGL", 300_000_000n);
    expect(big.rebalanceFrom).toBeUndefined();
    expect(big.cli).toEqual(["hedgehood deposit 300 --market GOOGL --wallet --send"]);
  });

  it("plans withdraw --all, rebalance and deposit as unsigned owner steps", async () => {
    const world = fakeWorld({ chain: multiMarketChain() });
    const v = await withGlobalFetch(world.fetch, () => readAccount({ chainId: 46630, account: owner.address, key: owner.address }));
    const all = planWithdrawAll(v);
    expect(all.steps.map((s) => [s.underlying, s.amountRaw])).toEqual([["NVDA", 240_000_000n], ["AMD", 30_000_000n]]);
    expect(call(all.steps[1]!.data)).toMatchObject({ functionName: "withdraw", args: [30_000_000n, owner.address] });
    expect(all.steps[1]!.to).toBe(AMD_MARKET);
    expect(all.summary).toMatch(/270 USDG .* 2 market\(s\) .*skipped: TSLA/);

    const r = planRebalance(v, { from: "NVDA", to: "GOOGL", amountRaw: 12_500_000n });
    expect(r.steps.map((s) => [s.kind, s.underlying, s.simulate])).toEqual([["withdraw", "NVDA", true], ["approve", "GOOGL", true], ["deposit", "GOOGL", false]]);
    expect(call(r.steps[1]!.data)).toMatchObject({ functionName: "approve", args: [GOOGL_MARKET, 12_500_000n] });
    expect(call(r.steps[2]!.data)).toMatchObject({ functionName: "deposit", args: [owner.address, 12_500_000n] });
    expect(call(planRebalance(v, { from: "NVDA", to: "GOOGL", amountRaw: 1n, approve: "max" }).steps[1]!.data).args).toEqual([GOOGL_MARKET, UNLIMITED]);
    expect(() => planRebalance(v, { from: "AMD", to: "GOOGL", amountRaw: 31_000_000n })).toThrow(/AMD market has 30 USDG free/);
    expect(() => planRebalance(v, { from: "NVDA", to: "nvda", amountRaw: 1n })).toThrow(/same market/);
    expect(() => planRebalance(v, { from: "TSLA", to: "GOOGL", amountRaw: 1n })).toThrow(/cannot read the TSLA market/);

    // a dry run simulates what can run on its own and leaves the deposit for after the approve
    const m = new MarketClient({ chainId: 46630, underlying: "GOOGL", signer: owner });
    const res = await withGlobalFetch(world.fetch, () => m.sendPlan(r));
    expect(res.map((x) => [x.kind, x.dryRun, x.simulated])).toEqual([["withdraw", true, true], ["approve", true, true], ["deposit", true, false]]);

    const d = planDeposit({ market: resolveMarket(46630, "GOOGL"), account: owner.address, amountRaw: 5_000_000n, allowanceRaw: 5_000_000n });
    expect(d.steps.map((s) => [s.kind, s.simulate])).toEqual([["deposit", true]]);
    expect(planDeposit({ market: resolveMarket(46630, "GOOGL"), account: owner.address, amountRaw: 5_000_000n, allowanceRaw: 0n }).steps.map((s) => s.kind)).toEqual(["approve", "deposit"]);
    expect(() => planDeposit({ market: resolveMarket(46630, "GOOGL"), account: owner.address, amountRaw: 5_000_000n, allowanceRaw: 0n, walletRaw: 1n })).toThrow(/wallet holds 0.000001/);
  });
});

describe("fill funding", () => {
  const googl = (signer = owner) => new MarketClient({ chainId: 46630, underlying: "GOOGL", account: owner.address, signer });

  it("wallet mode (owner): pays from the wallet, approving only what the fill can pull", async () => {
    const world = fakeWorld({ chain: multiMarketChain() });
    const order = googlOrder("buy");
    const p = await withGlobalFetch(world.fetch, () => planFillFunding({ market: googl(), order, signature: SIG, quantityRaw: ONE, mode: "wallet" }));
    // 1.68 premium + 50 bps fee (rounded up) = 1.6884
    expect(p).toMatchObject({ mode: "wallet", side: "buy", paysUpToRaw: 1_688_400n, walletPullUpToRaw: 1_688_400n, approveRaw: 1_688_400n, balanceShortfallRaw: 0n, problems: [] });
    expect(p.steps.map((s) => [s.kind, s.simulate])).toEqual([["approve", true], ["fill", false]]);
    expect(call(p.steps[1]!.data)).toMatchObject({ functionName: "fillOrderAs", args: [owner.address, expect.anything(), SIG, ONE, false] });
    expect(p.steps[1]!.to).toBe(GOOGL_BOOK);
    const max = await withGlobalFetch(world.fetch, () => planFillFunding({ market: googl(), order, signature: SIG, quantityRaw: ONE, mode: "wallet", approve: "max" }));
    expect(max.approveRaw).toBe(UNLIMITED);
    // enough allowance already: one fill, simulated on its own
    world.chain.markets![GOOGL_MARKET.toLowerCase()] = { allowanceRaw: 10_000_000n };
    const ready = await withGlobalFetch(world.fetch, () => planFillFunding({ market: googl(), order, signature: SIG, quantityRaw: ONE, mode: "wallet" }));
    expect(ready.steps.map((s) => [s.kind, s.simulate])).toEqual([["fill", true]]);
    // a sale that needs collateral pulls the shortfall; a wallet that cannot cover it is a problem
    world.chain.markets![GOOGL_MARKET.toLowerCase()] = { requirementAfterRaw: 600_000_000n };
    const sell = await withGlobalFetch(world.fetch, () => planFillFunding({ market: googl(), order: googlOrder("sell"), signature: SIG, quantityRaw: ONE, mode: "wallet" }));
    expect(sell).toMatchObject({ side: "sell", receivesAtLeastRaw: 1_671_600n, walletPullUpToRaw: 600_000_000n });
    expect(sell.problems[0]).toMatch(/wallet holds 500 USDG; this fill can pull up to 600/);
  });

  it("balance mode: a shortfall blocks a session key, the owner can deposit it first", async () => {
    const world = fakeWorld({ chain: multiMarketChain() });
    const order = googlOrder("buy");
    const s = await withGlobalFetch(world.fetch, () => planFillFunding({ market: googl(session), order, signature: SIG, quantityRaw: ONE, mode: "balance" }));
    expect(s.balanceShortfallRaw).toBe(1_688_400n);
    expect(s.problems[0]).toMatch(/GOOGL market balance is short by 1.6884 USDG/);
    expect(s.steps.map((x) => x.kind)).toEqual(["fill"]);
    await expect(withGlobalFetch(world.fetch, () => planFillFunding({ market: googl(session), order, signature: SIG, quantityRaw: ONE, mode: "wallet" }))).rejects.toThrow(/SessionWalletMode/);
    await expect(withGlobalFetch(world.fetch, () => planFillFunding({ market: googl(session), order, signature: SIG, quantityRaw: ONE, mode: "balance", autoDeposit: true }))).rejects.toThrow(/never deposits from the owner's wallet/);
    const o = await withGlobalFetch(world.fetch, () => planFillFunding({ market: googl(), order, signature: SIG, quantityRaw: ONE, mode: "balance", autoDeposit: true }));
    expect(o).toMatchObject({ depositRaw: 1_688_400n, problems: [] });
    expect(o.steps.map((x) => [x.kind, x.simulate])).toEqual([["approve", true], ["deposit", false], ["fill", false]]);
    expect(call(o.steps[1]!.data)).toMatchObject({ functionName: "deposit", args: [owner.address, 1_688_400n] });
    expect(call(o.steps[2]!.data).args![4]).toBe(true);
    // covered: NVDA holds 240 free, so a balance-mode buy there needs nothing
    const nvda = new MarketClient({ chainId: 46630, underlying: "NVDA", account: owner.address, signer: session });
    const ok = await withGlobalFetch(world.fetch, () => planFillFunding({ market: nvda, order: { ...order, market: nvda.market, settlement: nvda.orderBook }, signature: SIG, quantityRaw: ONE, mode: "balance" }));
    expect(ok).toMatchObject({ balanceShortfallRaw: 0n, problems: [] });
  });
});
