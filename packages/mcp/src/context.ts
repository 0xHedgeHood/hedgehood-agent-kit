import { getDeployment, getMarket, MarketClient, RfqClient, type MarketDeployment, type VerifiedQuote } from "@hedgehood-io/sdk";
import type { Address, Hex } from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import type { KitConfig } from "./config.js";

export interface KitContext {
  config: KitConfig;
  chainId: number;
  deployment: MarketDeployment;
  /** The trading account every tool reads and trades for. */
  account: Address;
  session?: LocalAccount;
  owner?: LocalAccount;
  rfq: RfqClient;
  /** A market client signing with the session key (trades, redeemFor) or the owner key (deposit, withdraw, sessions). */
  market: (signer?: "session" | "owner" | "none") => MarketClient;
  /** Quotes returned by get_quote, by digest, so fill_quote can take a digest instead of the whole order. */
  quotes: Map<Hex, { quote: VerifiedQuote; fetchedAt: number; side: "buy" | "sell"; requestedQuantityRaw: bigint }>;
  fetch?: typeof fetch;
}

export function createContext(config: KitConfig, extra: { fetch?: typeof fetch; deployment?: MarketDeployment } = {}): KitContext {
  const chainId = config.chainId;
  const dep = getDeployment(chainId);
  const deployment = extra.deployment ?? getMarket(chainId, config.underlying ?? dep.markets[0]?.underlying ?? "NVDA");
  const session = config.sessionKey ? privateKeyToAccount(config.sessionKey) : undefined;
  const owner = config.ownerKey ? privateKeyToAccount(config.ownerKey) : undefined;
  const account = config.account ?? owner?.address ?? session?.address;
  if (!account) throw new Error("no account: set HEDGEHOOD_ACCOUNT, or a session/owner key");
  const rfqOpts: ConstructorParameters<typeof RfqClient>[0] = { chainId, apiUrl: config.apiUrl ?? dep.apiUrl };
  if (extra.fetch) rfqOpts.fetch = extra.fetch;
  const rfq = new RfqClient(rfqOpts);
  const market = (signer: "session" | "owner" | "none" = "session") => {
    const s = signer === "session" ? session : signer === "owner" ? owner : undefined;
    return new MarketClient({ chainId, rpcUrl: config.rpcUrl, deployment, account, signer: s });
  };
  return { config, chainId, deployment, account, session, owner, rfq, market, quotes: new Map(), fetch: extra.fetch };
}

/** Owner-only operations refuse to run on the session key. */
export function requireOwner(ctx: KitContext): LocalAccount {
  if (!ctx.owner) throw new Error("this action needs the owner key (HEDGEHOOD_OWNER_KEY_FILE); a session key cannot do it");
  return ctx.owner;
}

export function requireSession(ctx: KitContext): LocalAccount {
  const s = ctx.session ?? ctx.owner;
  if (!s) throw new Error("no signing key: set HEDGEHOOD_SESSION_KEY_FILE");
  return s;
}
