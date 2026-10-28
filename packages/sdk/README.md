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
const { strikes } = await market.expiryInfo(expiry!);
const id = encodeInstrumentId(expiry!, strikes[4]!, false); // a call
const quote = await rfq.getQuote(
  { chainId: 46630, market: market.market, instrumentId: id, side: "buy", quantityRaw: parseShares("1"), taker: OWNER },
  { orderBook: market.orderBook, protocolFeeBps: await market.protocolFeeBps() },
);
console.log(`pay ${formatUsdg(quote.netNowRaw)} USDG, ${quote.secondsLeft}s left`);
const tx = market.fillOrderAs(quote.order, quote.signature, parseShares("1"), true);
await market.send(tx, { dryRun: true }); // simulate; { dryRun: false } broadcasts
```

Modules: `chains` (deployments 46630/4663), `instrument` (id packing, `gridFor`), `order` (EIP-712 V2 orders, decay
math, `signOrder`, `verifyOrderSignature`), `calldata` (every write as an unsigned `TxRequest`), `market`
(`MarketClient` reads and dry-run-first sends), `rfq` (`RfqClient`, assumed backend API), `x402` (`depositViaGateway`,
USDG preset adapted from `@priors/x402`), `identity` (ERC-8004), `units`. ABIs: `marketV2Abi`, `orderBookV2Abi`,
`erc20Abi`, `identityRegistryAbi`.

MIT.
