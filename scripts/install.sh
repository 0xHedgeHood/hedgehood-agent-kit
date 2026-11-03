#!/bin/sh
# Hedgehood agent setup: checks Node >= 20, then runs `hedgehood init` from npm (no global install, no sudo).
# Idempotent: existing keys in ~/.hedgehood are kept, never overwritten or printed.
#   curl -fsSL https://raw.githubusercontent.com/0xHedgeHood/hedgehood-agent-kit/main/scripts/install.sh | sh -s -- --mainnet --account 0xYourWallet
# Arguments after `--` go to `hedgehood init` (--with-payer, --markets NVDA,TSLA, --max-spend 100, --days 30, --wait, ...).
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "hedgehood: Node.js 20 or newer is required (https://nodejs.org); node was not found" >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 20 ]; then
  echo "hedgehood: Node.js 20 or newer is required; found $(node --version)" >&2
  exit 1
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "hedgehood: npx was not found (it ships with npm)" >&2
  exit 1
fi

exec npx -y @hedgehood-io/cli@latest init "$@"
