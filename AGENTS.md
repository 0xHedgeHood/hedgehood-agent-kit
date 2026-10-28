# AGENTS.md

Guidance for coding agents working in this repository, and for trading agents that load this repo as a skill. The
trading skill itself is [skills/hedgehood-options/SKILL.md](skills/hedgehood-options/SKILL.md).

## What this is

A pnpm/TypeScript monorepo: `packages/sdk` (`@hedgehood-io/sdk`, viem), `packages/mcp` (`@hedgehood-io/mcp`, local MCP
server that signs with the agent's key), `packages/cli` (`hedgehood`), the Claude Code plugin (`.claude-plugin/`,
`skills/`), `examples/`. It targets Hedgehood's `CashOptionMarketV2` / `CashOptionOrderBookV2` on Robinhood Chain
(testnet 46630 live, mainnet 4663 after audit). The market is for non-US agents and operators.

## Rules for changes

- `pnpm -r typecheck && pnpm -r test && pnpm -r build` must stay green; CI runs them on Node 20 and 22.
- Never commit keys, `.env` files, key files or anything under `~/.hedgehood`. Tests use well-known throwaway keys only.
- The contract sources are **not** in this repo (private until the audit); only ABIs are vendored. Refresh them with
  `node scripts/vendor-abis.mjs <hedgehood-options/contracts/out> <commit>` (market) or
  `node scripts/vendor-abis.mjs --vaults <hedgehood-vaults/contracts/out> <tag|commit>` (Stock Yield vaults: EpochFund,
  VaultRegistry, the gates) or `node scripts/vendor-abis.mjs --lending <hedgehood-vaults checkout> <commit>` (share
  lending: Morpho Blue, AdaptiveCurveIrm, ShareRiskOracle, Vault V2 + MorphoMarketV1AdapterV2) and record the commit in the header and in `CHANGELOG.md`. Never edit the generated ABI
  files by hand.
- Vault writes (`VaultClient` plans, `hedgehood vault …`, `vault_*` tools) are owner-key only: the fund authorizes the
  account itself or an on-chain position manager, never a market session key. Keep the deployment registry
  (`chains.ts` `vaults`) in step with hedgehood-vaults `docs/OPTION_VAULT_V2.md`; the on-chain `VaultRegistry` stays the
  source of truth at runtime.
- Lending writes (`LendingClient` plans, `hedgehood lend|borrow …`, `lend_*` / `borrow_*` tools) are owner-key only and
  keep their guards: refuse a borrow / collateral withdrawal ending below health factor 1 or while the oracle has no
  price, warn above 70% of LLTV. Never hard-code a market id in a code path: the market comes from the lending vault
  (`discoverMarkets`), with `chains.ts` `lending.markets` only as the fallback; update that list after a migration.
- The EIP-712 struct string in `packages/sdk/src/order.ts` must match the contract's `ORDER_TYPEHASH`; the test pins
  the hash, so a contract change shows up as a failing test, not a silent mismatch.
- The backend API is documented in `docs/BACKEND_API.md` (hedgehood-options `feat/rfq-backend`); a route or shape change
  there means changing `RfqPaths`/types in `packages/sdk/src/rfq.ts`, the 402 handling in `x402.ts`, and the fixtures, in
  one PR. Re-run the live read path (`hedgehood markets|instruments|quote`) before merging such a change.
- Every send stays dry run by default (SDK `send()`, CLI `--send`, MCP `dryRun`/`confirm`). Do not add a tool that
  broadcasts without `confirm: true`. Do not log or return private keys, even partially.
- Do not publish to npm or any registry from a PR or CI; releases are manual (`RELEASING.md`, `REGISTRIES.md`).
- Keep PRs focused; put long design notes in Git history or `docs/`, not in package READMEs.

## Layout

```
packages/sdk/src/{chains,instrument,order,calldata,units,market,send,errors,vault,lending,rfq,close,pnl,x402,identity}.ts, abi/
packages/mcp/src/{config,context,server,http,bin}.ts, server.json
packages/cli/src/{cli,bin}.ts
skills/hedgehood-options/SKILL.md   .claude-plugin/{plugin,marketplace}.json
examples/   docs/   scripts/vendor-abis.mjs   .github/workflows/ci.yml
```
