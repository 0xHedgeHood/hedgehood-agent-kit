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

Environment: HEDGEHOOD_CHAIN_ID, HEDGEHOOD_RPC_URL, HEDGEHOOD_RFQ_URL, HEDGEHOOD_INDEXER_URL, HEDGEHOOD_GATEWAY_URL,
HEDGEHOOD_VAULT_API_URL, HEDGEHOOD_UNDERLYING, HEDGEHOOD_ACCOUNT, HEDGEHOOD_SESSION_KEY_FILE (or HEDGEHOOD_SESSION_KEY),
HEDGEHOOD_OWNER_KEY_FILE (optional; needed by withdraw, sessions and every vault_* / lend_* / borrow_* write),
HEDGEHOOD_DRY_RUN, HEDGEHOOD_MAX_DEPOSIT. Tools: the option market (quotes, fills, positions, P&L), the Stock Yield
vaults (list_vaults, vault_status, vault_deposit, vault_redeem, vault_claim, vault_cancel) and share lending
(lend_status, lend_deposit, lend_withdraw, borrow_status, borrow_supply_collateral, borrow_take, borrow_repay,
borrow_withdraw_collateral). See https://github.com/0xHedgeHood/hedgehood-agent-kit.
`);
  process.exit(0);
}

async function main() {
  if (args.includes("--testnet")) process.env.HEDGEHOOD_CHAIN_ID = "46630";
  if (args.includes("--mainnet")) process.env.HEDGEHOOD_CHAIN_ID = "4663";
  const config = loadConfig();
  const ctx = createContext(config);
  if (args.includes("--check")) {
    process.stdout.write(JSON.stringify({ ...describeConfig(config), account: ctx.account, sessionAddress: ctx.session?.address, ownerAddress: ctx.owner?.address, market: ctx.marketDeployment?.market ?? "(no option market on this chain)", orderBook: ctx.marketDeployment?.orderBook, vaultRegistry: ctx.vaults?.registry ?? "(no vaults on this chain)", vaultFunds: ctx.vaults?.funds.map((f) => f.symbol), lendingVault: ctx.lendingDeployment?.vault ?? "(no share lending on this chain)", morphoBlue: ctx.lendingDeployment?.blue }, null, 2) + "\n");
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
