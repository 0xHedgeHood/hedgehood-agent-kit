#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, describeConfig } from "./config.js";
import { createContext } from "./context.js";
import { serveHttp } from "./http.js";
import { createServer } from "./server.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`hedgehood-mcp: local MCP server for Hedgehood's agent options market

  hedgehood-mcp                 stdio transport (for Claude Code, Codex, Claude Desktop)
  hedgehood-mcp --http [port]   streamable HTTP on 127.0.0.1 (default port 7402, path /mcp)
  hedgehood-mcp --check         print the resolved configuration (keys shown as set/missing) and exit
  --testnet | --mainnet         select the 46630 / 4663 deployment (same public backend hosts); default testnet

Environment: HEDGEHOOD_CHAIN_ID, HEDGEHOOD_RPC_URL, HEDGEHOOD_API_URL, HEDGEHOOD_UNDERLYING, HEDGEHOOD_ACCOUNT,
HEDGEHOOD_SESSION_KEY_FILE (or HEDGEHOOD_SESSION_KEY), HEDGEHOOD_OWNER_KEY_FILE (optional), HEDGEHOOD_DRY_RUN,
HEDGEHOOD_MAX_DEPOSIT. See https://github.com/0xHedgeHood/hedgehood-agent-kit.
`);
  process.exit(0);
}

async function main() {
  if (args.includes("--testnet")) process.env.HEDGEHOOD_CHAIN_ID = "46630";
  if (args.includes("--mainnet")) process.env.HEDGEHOOD_CHAIN_ID = "4663";
  const config = loadConfig();
  const ctx = createContext(config);
  if (args.includes("--check")) {
    process.stdout.write(JSON.stringify({ ...describeConfig(config), account: ctx.account, sessionAddress: ctx.session?.address, ownerAddress: ctx.owner?.address, market: ctx.deployment.market, orderBook: ctx.deployment.orderBook }, null, 2) + "\n");
    return;
  }
  const httpIdx = args.indexOf("--http");
  if (httpIdx !== -1) {
    const port = Number(args[httpIdx + 1]) || 7402;
    serveHttp(ctx, { port, host: process.env.HEDGEHOOD_MCP_HOST ?? "127.0.0.1" });
    return;
  }
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`hedgehood-mcp: stdio, chain ${ctx.chainId}, account ${ctx.account}, session ${ctx.session?.address ?? "none"}, owner ${ctx.owner ? "set" : "none"}, dryRun=${config.dryRunDefault}\n`);
}

main().catch((e) => {
  process.stderr.write(`hedgehood-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
