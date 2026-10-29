/** Synthetic portfolio; no keys, network, signing or trades. Run: pnpm exec tsx examples/portfolio-dashboard.ts */
import { renderPnlDashboard, type PnlPosition, type PnlView } from "@hedgehood-io/sdk";

const account = "0x3333333333333333333333333333333333333333";
const base: PnlPosition = {
  instrument: "NVDA-20261030-220-C", market: account, expiry: 1793390400, strike: "220000000", isPut: false,
  quantityRaw: "2000000000000000000", costRaw: "10000000", avgPriceRaw: "5000000", markMid: 11.2,
  markAt: 1793300000, markSource: "synthetic", unrealizedRaw: "12400000", settledAt: null, settlementRaw: null,
};
const portfolio: PnlView = {
  account, asOf: 1793300000, realizedRaw: "12500000", unrealizedRaw: "8200000", feesPaidRaw: "300000", totalRaw: "20700000",
  positions: [base, { ...base, instrument: "TSLA-20261030-400-P", strike: "400000000", isPut: true,
    quantityRaw: "1000000000000000000", costRaw: "10000000", avgPriceRaw: "10000000", markMid: 5.8, unrealizedRaw: "-4200000" }],
  note: "SYNTHETIC DEMO - not a real account or investment performance.",
};
console.log(renderPnlDashboard(portfolio, 46630));
