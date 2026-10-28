# Where to list the kit (checklist for Leo)

Nothing below has been done yet; this repo only contains the manifests. Do them in this order (npm first: most
registries verify the npm package).

## 1. npm (`@hedgehood-io/sdk`, `@hedgehood-io/mcp`, `@hedgehood-io/cli`)

See [RELEASING.md](RELEASING.md). Before the first `@hedgehood-io/mcp` publish, add to `packages/mcp/package.json`:
`"mcpName": "io.github.0xHedgeHood/hedgehood-options"` (the MCP Registry checks it to prove npm ownership).

## 2. Official MCP Registry (registry.modelcontextprotocol.io)

Manifest: `packages/mcp/server.json` (name `io.github.0xHedgeHood/hedgehood-options`; the `io.github.0xHedgeHood/*`
namespace is proven by GitHub login to an account with access to the `0xHedgeHood` org). The `remotes` entry points at
the hosted read-only server `https://mcp.hedgehood.io/mcp` (live, testnet dry-run as of 2026-10-28).

```sh
brew install mcp-publisher            # or: curl -L https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr A-Z a-z)_$(uname -m).tar.gz | tar xz
cd packages/mcp
mcp-publisher login github            # device-code flow; use an account in the 0xHedgeHood org
mcp-publisher publish                 # validates server.json against npm, then publishes
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=hedgehood" | jq .
```

## 3. Smithery (smithery.ai)

`smithery.yaml` at the repo root (stdio, local install). Sign in with GitHub at https://smithery.ai, "Add server", pick
the `0xHedgeHood/hedgehood-agent-kit` repo; Smithery reads the manifest. Mark it local-only (it signs with a local key).

## 4. Glama (glama.ai/mcp/servers)

`glama.json` at the root (`maintainers: ["keyuyuan"]`). Submit at https://glama.ai/mcp/servers/add with the repo URL;
Glama indexes the README and `glama.json` and runs the server in a sandbox for inspection (it will show "needs config"
because the session key file is required; that is expected).

## 5. PulseMCP, mcp.so, awesome lists

- PulseMCP: https://www.pulsemcp.com/submit (repo URL + one-line description from `server.json`).
- mcp.so: https://mcp.so/submit (same).
- `punkpeye/awesome-mcp-servers`: PR adding a line under "Finance & Fintech".
- `modelcontextprotocol/servers` README "Community servers": PR with one line.

## 6. Anthropic / Claude

- Claude Code plugin marketplace: already self-hosted by this repo (`.claude-plugin/marketplace.json`):
  `/plugin marketplace add 0xHedgeHood/hedgehood-agent-kit` then `/plugin install hedgehood-options@hedgehood`.
  Test both commands from a clean machine before announcing.
- Anthropic's curated plugin directory / connectors directory: submit through the form linked from
  https://docs.claude.com/en/docs/claude-code/plugins (directory submissions are reviewed; a hosted MCP with OAuth is
  needed for the claude.ai connectors directory, see `docs/CHATGPT_APP.md` for the same requirement on the OpenAI side).

## 7. OpenAI

- Codex CLI: no registry; README documents `codex mcp add hedgehood -- npx -y @hedgehood-io/mcp` and
  `examples/codex-config.toml`.
- ChatGPT Apps SDK connector: needs a hosted MCP server with OAuth (stub: `docs/CHATGPT_APP.md`). Later.

## 8. OpenClaw / ClawHub (agent skills)

OpenClaw agents read `SKILL.md` + `mcpServers` config. Publish the skill folder `skills/hedgehood-options` to ClawHub
(`clawhub publish skills/hedgehood-options` once the CLI is installed; the hub reads the frontmatter `name`/`description`).
Add the MCP block from `examples/mcp-config.json` to the OpenClaw agent config.

## 9. Later: agent economies

- Virtuals ACP: register the agent as a service provider ("options execution on Robinhood Chain") once mainnet is live;
  needs an agent wallet and the ACP SDK; out of scope for 0.1.
- Olas (Autonolas) registry: a service NFT wrapping the MCP server as an agent component; out of scope for 0.1.
- ERC-8004: `register_agent` tool / `hedgehood register` already produce the Identity Registry transaction on 4663.

## Badges

README carries the CI, npm (x3), MCP Registry and MIT badges; the npm badges turn green after step 1.
