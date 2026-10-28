# Releasing to npm

Packages publish under the `@hedgehood-io` npm org (https://www.npmjs.com/settings/hedgehood-io). Releases are manual,
from a clean checkout, by a maintainer logged in to npm; CI never publishes.

```sh
git clone git@github.com:0xHedgeHood/hedgehood-agent-kit.git && cd hedgehood-agent-kit
git status --porcelain            # must be empty
pnpm install --frozen-lockfile
pnpm -r typecheck && pnpm -r test
pnpm -r build

npm whoami                        # must be a member of @hedgehood-io
pnpm -r publish --access public   # publishes sdk, mcp, cli in dependency order (workspace:* is rewritten to the version)
```

Before publishing a new version:

1. Bump `version` in `packages/*/package.json` together (they are released in lockstep), in
   `packages/mcp/server.json` (`version` and `packages[0].version`), in `.claude-plugin/plugin.json` and
   `.claude-plugin/marketplace.json`, and in the `McpServer` name/version in `packages/mcp/src/server.ts`.
2. Move the `## x.y.z (unreleased)` section of `CHANGELOG.md` to the release date.
3. Commit, tag `vX.Y.Z`, push the tag.

First release only: `pnpm -r publish --access public` creates the three packages; `publishConfig.access: public` is set
in each `package.json`, so `--access public` is belt and braces. Dry run with `pnpm -r publish --dry-run --access public`.

After npm: the MCP Registry entry (`REGISTRIES.md`) validates that `@hedgehood-io/mcp` on npm lists
`mcpName: "io.github.0xHedgeHood/hedgehood-options"` in its `package.json` (add it before publishing the version you
register).
