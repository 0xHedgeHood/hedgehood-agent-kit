import { describe, expect, it } from "vitest";
import { DEFAULT_CHAIN_ID, HEDGEHOOD_API, HEDGEHOOD_TESTNET_API, RfqClient, deployments, getMarket, resolveMarket } from "../src/index.js";

describe("chain registry", () => {
  it("lists the first mainnet V2 batch, settled in mainnet USDG at a 5 bps taker fee", () => {
    const main = deployments[4663];
    expect(main.markets.map((m) => m.underlying)).toEqual(["NVDA", "TSLA", "MU", "GOOGL", "CRCL", "MSTR", "AMD"]);
    for (const m of main.markets) {
      expect(m.settlementToken).toBe(main.usdg);
      expect(m.protocolFeeBps).toBe(5);
      expect(m.source).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(m.deployBlock).toBeGreaterThan(101_000_000n);
    }
    const addresses = main.markets.flatMap((m) => [m.market.toLowerCase(), m.orderBook.toLowerCase()]);
    expect(new Set(addresses).size).toBe(addresses.length);
    const testnet = new Set(deployments[46630].markets.flatMap((m) => [m.market.toLowerCase(), m.orderBook.toLowerCase()]));
    expect(addresses.filter((a) => testnet.has(a))).toEqual([]);
    expect(getMarket(4663, "nvda").uiMultiplierRaw).toBe(1000775159164630595n);
    expect(resolveMarket(4663, "0xEfD43EE18c60907b040c76e61c7FD86a52f5940A").underlying).toBe("CRCL");
  });

  it("gives each chain its own backend hosts and keeps the testnet as the default chain", () => {
    expect(DEFAULT_CHAIN_ID).toBe(46630);
    expect(deployments[4663].api).toBe(HEDGEHOOD_API);
    expect(deployments[46630].api).toBe(HEDGEHOOD_TESTNET_API);
    expect(new RfqClient({ chainId: 4663 }).hosts).toEqual({
      rfq: "https://agent-api.hedgehood.io",
      indexer: "https://agent-index.hedgehood.io",
      gateway: "https://agent-pay.hedgehood.io",
      mcp: "https://mcp.hedgehood.io/mcp",
    });
    expect(new RfqClient({ chainId: 46630 }).hosts).toEqual({
      rfq: "https://testnet-agent-api.hedgehood.io",
      indexer: "https://testnet-agent-index.hedgehood.io",
      gateway: "https://testnet-agent-pay.hedgehood.io",
      mcp: "https://testnet-mcp.hedgehood.io/mcp",
    });
    expect(new RfqClient({ chainId: 46630, hosts: { rfq: "https://rfq.test/" } }).hosts.rfq).toBe("https://rfq.test");
  });
});
