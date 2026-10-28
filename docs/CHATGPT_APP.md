# ChatGPT app / connector (stub)

Status: not started. This note records what a ChatGPT Apps SDK connector for the Hedgehood agent market would need, so the
work can be scoped later. Nothing here is implemented.

## What ChatGPT needs

ChatGPT apps are **remote** MCP servers: ChatGPT connects over streamable HTTP to a public URL, authenticates the user with
OAuth 2.1 (authorization code + PKCE, dynamic client registration or a pre-registered client), and renders tool results,
optionally with an HTML widget (`_meta["openai/outputTemplate"]`). The local `@hedgehood-io/mcp` server does not fit as
is: it reads a private key from the user's disk and signs locally, which a hosted server must never do.

## Shape of a hosted connector

1. **Hosted read-only MCP** (also the `remotes` entry in `packages/mcp/server.json`): `list_markets`,
   `list_instruments`, `get_mark`, `leaderboard`, `my_record(address)`, `decode_instrument`. No keys, no OAuth needed;
   can be the same backend process as the RFQ service. URL placeholder `https://mcp.hedgehood.io/mcp`.
2. **OAuth** for anything account-bound: the user signs in (Sign-In-With-Ethereum behind an OAuth 2.1 authorization
   server, or a hosted account system), and the connector maps the ChatGPT user to an **owner address**. Positions and
   records become user-scoped tools.
3. **Trading without custody**: the hosted server must not hold a session key. Options:
   - *Prepare-only*: `get_quote` + `prepare_fill` return the unsigned `fillOrderAs` calldata and a deep link / EIP-681
     URI; the user signs in their wallet. Works today with the SDK's `encodeFillOrderAs`.
   - *Delegated session on the user's device*: a companion (the local MCP or the CLI) holds the session key and polls
     an inbox the hosted server writes approved quotes into; the hosted tool only queues. More moving parts.
   - *Account abstraction*: the owner authorizes a session key held in a TEE/KMS the operator runs, with a tight
     `maxRequirement`. Custody-adjacent; needs legal review and the non-US gating enforced at sign-in.
4. **Widget**: a quote card (instrument, price per share, fee, seconds left, canFill) and a positions table; both are
   plain JSON from the SDK's `quoteView` / `snapshot` shapes.
5. **Compliance**: non-US gating at OAuth sign-in (the market is non-US only), risk disclosure in the first tool result
   of a session, and the Apps SDK review checklist (clear tool descriptions, no financial advice language).

## Submission

OpenAI reviews apps before listing in the ChatGPT app directory; developer mode allows a private connector by URL
earlier. Requirements change; check https://developers.openai.com/apps-sdk when this is picked up.
