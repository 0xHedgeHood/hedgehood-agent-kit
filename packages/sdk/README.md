# @hedgehood-io/sdk

TypeScript SDK (viem) for Hedgehood's cash-settled options market V2 on Robinhood Chain. Part of
[hedgehood-agent-kit](https://github.com/0xHedgeHood/hedgehood-agent-kit); see the root README for the market model and
security notes. Non-US only.

```sh
pnpm add @hedgehood-io/sdk viem
```

```ts
import { MarketClient, RfqClient, encodeInstrumentId, parseShares, formatUsdg } from "@hedgehood-io/sdk";
import { privateKeyToAccount } from "viem/accounts";

const session = privateKeyToAccount(process.env.SESSION_KEY as `0x${string}`);
const market = new MarketClient({ chainId: 46630, underlying: "NVDA", account: OWNER, signer: session });
const rfq = new RfqClient({ chainId: 46630 });

const [expiry] = await market.openedExpiries();
const { strikes, uiMultiplier } = await market.expiryInfo(expiry!); // per-token strikes + the expiry's multiplier
const id = encodeInstrumentId(expiry!, strikes[4]!, false); // a call (or: await market.resolveInstrumentName("NVDA-20261030-220-C"))
const quote = await rfq.getQuote(
  { chainId: 46630, market: market.market, instrumentId: id, side: "buy", quantityRaw: parseShares("1"), taker: OWNER, uiMultiplier },
  { orderBook: market.orderBook, protocolFeeBps: await market.protocolFeeBps() },
);
console.log(`pay ${formatUsdg(quote.netNowRaw)} USDG, ${quote.secondsLeft}s left`);
const tx = market.fillOrderAs(quote.order, quote.signature, parseShares("1"), true); // a session key: balance mode only
await market.send(tx, { dryRun: true }); // simulate; { dryRun: false } broadcasts
```

Modules: `chains` (deployments 46630/4663), `instrument` (id packing, `gridFor`), `order` (EIP-712 V2 orders, decay
math, `signOrder`, `verifyOrderSignature`), `calldata` (every write as an unsigned `TxRequest`), `market`
(`MarketClient` reads and dry-run-first sends), `rfq` (`RfqClient`: quotes with one retry on `feed_not_healthy`,
`getPnl`, `getHistory`), `close` (`planClose` / `closePosition`: the opposite-side fill that exits a position), `pnl`
(`positionPnl`, `formatTimeToExpiry`), `x402` (`depositViaGateway`,
USDG preset adapted from `@priors/x402`), `identity` (ERC-8004), `vault` (`VaultClient` for the Stock Yield vaults:
`listVaults`, `status`, owner-wallet plans `requestDeposit` / `requestRedeem` / `cancelDeposit` / `cancelRedeem` /
`claim`, dry run by default), `send` (`sendTxRequest`), `errors` (`decodeMarketError`, `MarketRevertError`: market /
book custom errors such as `SessionLimit` and `SessionWalletMode` with what to do), `units`. ABIs: `marketV2Abi`, `orderBookV2Abi`, `erc20Abi`,
`identityRegistryAbi`, `epochFundAbi`, `vaultRegistryAbi`, `openDepositGateAbi`, `stakeThresholdGateAbi`.

```ts
import { VaultClient, parseUsdg } from "@hedgehood-io/sdk";
const vaults = new VaultClient({ chainId: 4663, account: OWNER, signer: ownerAccount });
for (const v of await vaults.listVaults()) console.log(v.symbol, v.epoch.state, v.nav.usdgPerShareRaw, v.my?.sharesRaw);
const { plan, results } = await vaults.requestDeposit({ vault: await vaults.resolveVault("hhNVDA-CC"), usdgRaw: parseUsdg("100") });
// plan.steps = approve + requestDeposit; results are dry-run simulations until { dryRun: false }
```

MIT.
