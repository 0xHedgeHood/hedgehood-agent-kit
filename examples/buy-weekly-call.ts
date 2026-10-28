// An agent buys one NVDA weekly call on the Robinhood testnet, dry run by default (set SEND=1 to broadcast).
// Needs: HEDGEHOOD_SESSION_KEY_FILE (or HEDGEHOOD_SESSION_KEY) authorized by HEDGEHOOD_ACCOUNT, and a USDG balance.
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { MarketClient, RfqClient, encodeInstrumentId, formatUsdg, parseShares, parseUsdg } from "@hedgehood-io/sdk";

const key = (process.env.HEDGEHOOD_SESSION_KEY ?? readFileSync(process.env.HEDGEHOOD_SESSION_KEY_FILE!, "utf8")).trim() as Hex;
const session = privateKeyToAccount(key);
const account = (process.env.HEDGEHOOD_ACCOUNT ?? session.address) as Address;

const market = new MarketClient({ chainId: 46630, underlying: "NVDA", account, signer: session });
const rfq = new RfqClient({ chainId: 46630 }); // public hosts: agent-api / agent-index / agent-pay.hedgehood.io

// nearest expiry that is still trading
const infos = await Promise.all((await market.openedExpiries()).map((e) => market.expiryInfo(e)));
const open = infos.filter((i) => i.tradingOpen).sort((a, b) => Number(a.expiry - b.expiry))[0];
if (!open) throw new Error("no open expiry");
const strike = open.strikes.find((s) => s >= open.anchor) ?? open.strikes.at(-1)!; // first strike at or above the anchor
const instrumentId = encodeInstrumentId(open.expiry, strike, false);
const quantityRaw = parseShares("1");

const quote = await rfq.getQuote(
  { chainId: 46630, market: market.market, instrumentId, side: "buy", quantityRaw, taker: account, sessionKey: session.address, underlying: "NVDA" },
  { orderBook: market.orderBook, protocolFeeBps: await market.protocolFeeBps() },
);
console.log(`${quote.instrument}: pay ${formatUsdg(quote.netNowRaw)} USDG (fee ${formatUsdg(quote.feeNowRaw)}), ${quote.secondsLeft}s left, canFill=${quote.canFill}`);
if (!quote.fillable) throw new Error("the desk is in dry-run mode (placeholder signature): nothing to fill");
if (quote.netNowRaw > parseUsdg("10")) throw new Error("too expensive, skipping");

const tx = market.fillOrderAs(quote.order, quote.signature, quantityRaw, true);
const result = await market.send(tx, { dryRun: process.env.SEND !== "1" });
console.log(result.dryRun ? `dry run OK: ${tx.summary}` : `sent ${result.hash}`);
