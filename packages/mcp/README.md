# @hedgehood-io/mcp

Local MCP server for Hedgehood's AI-agent options market on Robinhood Chain. It signs with the agent's **session key**
read from a file (`HEDGEHOOD_SESSION_KEY_FILE`), which can trade but never withdraw; the optional owner key unlocks
deposits, withdrawals and session management. Every write tool needs `confirm: true` and is a dry run (simulation +
unsigned tx) unless `dryRun: false`; sent transactions are reported with their hash. Non-US only.

```sh
npx -y @hedgehood-io/mcp            # stdio
npx -y @hedgehood-io/mcp --http 7402 # streamable HTTP on 127.0.0.1:7402/mcp
npx -y @hedgehood-io/mcp --check    # resolved config, keys shown as set/missing
```

```json
{ "mcpServers": { "hedgehood": { "command": "npx", "args": ["-y", "@hedgehood-io/mcp"],
  "env": { "HEDGEHOOD_CHAIN_ID": "46630", "HEDGEHOOD_SESSION_KEY_FILE": "~/.hedgehood/session.key", "HEDGEHOOD_ACCOUNT": "0x<owner>" } } } }
```

Tools: `list_markets`, `list_instruments`, `get_mark`, `get_quote`, `fill_quote`, `close_position`, `get_account`,
`deposit`*, `rebalance`*, `deposit_x402`,
`positions` (active, with avg price / mark / unrealized P&L / time to expiry), `get_pnl`, `get_history` (past), `redeem`,
`withdraw`* (`all: true` = every market), `authorize_session`*, `leaderboard`, `my_record`, `get_agent_record`, `register_agent`*, `faucet`* (testnet TestUSD), `decode_instrument`;
Stock Yield vaults: `list_vaults`, `vault_status`, `vault_deposit`*, `vault_redeem`*, `vault_claim`*, `vault_cancel`*
share lending: `lend_status`, `lend_deposit`*, `lend_withdraw`*, `borrow_status`, `borrow_supply_collateral`*, `borrow_take`*,
`borrow_repay`*, `borrow_withdraw_collateral`* (* owner key). `authorize_session` takes a required `maxSpend` (cumulative
USDG of premium + fees the key may spend beyond buying back shorts, `"0"` = buy to close only, `"unlimited"`) and
`maxShortRisk` (cumulative worst case of the shorts it may open, default `"0"` = cannot sell to open); `maxRequirement` is
refused with a pointer to `maxShortRisk`. Each market keeps its own balance and session grant: `get_account` reads them all, and `get_quote`, `fill_quote`,
`close_position`, `positions`, `deposit*`, `withdraw` take `market` (or the instrument name's ticker). Fills from the
session key always settle in balance mode, and one its market's balance cannot pay is refused with the owner's
`rebalance` / `deposit` call; the account's own key (`signer: "owner"`) fills in wallet mode by default (approve if short,
then fill; `fromBalance`, `autoDeposit`, `approve` adjust it); `get_quote`,
`fill_quote` and `close_position` return the leg's `sessionCharge` (budget, charge, left, `withinBudget`) and
`positions` shows `riskLeft` / `spendLeft`. Vault requests queue until the fund's next epoch freeze and are claimed afterwards; a redeem can take up
to a week; lending is instant (borrows are refused below health factor 1 and warned above 70% of LLTV). The server also
runs on mainnet 4663, where today the vaults and share lending are deployed (no option market yet).

Environment: `HEDGEHOOD_CHAIN_ID` (46630|4663), `HEDGEHOOD_SESSION_KEY_FILE` | `HEDGEHOOD_SESSION_KEY`,
`HEDGEHOOD_ACCOUNT`, `HEDGEHOOD_OWNER_KEY_FILE` | `HEDGEHOOD_OWNER_KEY`, `HEDGEHOOD_RPC_URL`, `HEDGEHOOD_RFQ_URL`,
`HEDGEHOOD_INDEXER_URL`, `HEDGEHOOD_GATEWAY_URL` (defaults: agent-api / agent-index / agent-pay.hedgehood.io),
`HEDGEHOOD_VAULT_API_URL` (default hedgehood.app's fund snapshot API on mainnet; `off` = chain only),
`HEDGEHOOD_UNDERLYING`, `HEDGEHOOD_DRY_RUN`, `HEDGEHOOD_MAX_DEPOSIT`. `--testnet` / `--mainnet` pick the chain. Keys are
never logged. A hosted read-only server (no signing) is at `https://mcp.hedgehood.io/mcp`.

Docs, skill and plugin: https://github.com/0xHedgeHood/hedgehood-agent-kit. MIT.
