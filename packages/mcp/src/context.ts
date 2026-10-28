import { getDeployment, getMarket, MarketClient, RfqClient, VaultClient, type MarketDeployment, type VaultDeployment, type VerifiedQuote } from "@hedgehood-io/sdk";
import type { Address, Hex } from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import type { KitConfig } from "./config.js";

export interface KitContext {
  config: KitConfig;
  chainId: number;
  /** The option market this server trades. Throws when the chain has none (mainnet before the V2 listing); see `marketDeployment`. */
  deployment: MarketDeployment;
  /** The option market, or undefined when the chain has none yet (the vault tools still work). */
  marketDeployment?: MarketDeployment;
  /** The Stock Yield vault stack of the chain, when deployed. */
  vaults?: VaultDeployment;
  /** The trading account every tool reads and trades for. */
  account: Address;
  session?: LocalAccount;
  owner?: LocalAccount;
  rfq: RfqClient;
  /** A market client signing with the session key (trades, redeemFor) or the owner key (deposit, withdraw, sessions). */
  market: (signer?: "session" | "owner" | "none") => MarketClient;
  /** A vault client: reads, or writes signed with the owner key (a session key cannot act on a vault). */
  vault: (signer?: "owner" | "none") => VaultClient;
  /** Quotes returned by get_quote, by digest, so fill_quote can take a digest instead of the whole order. */
  quotes: Map<Hex, { quote: VerifiedQuote; fetchedAt: number; side: "buy" | "sell"; requestedQuantityRaw: bigint }>;
  fetch?: typeof fetch;
}

export function createContext(config: KitConfig, extra: { fetch?: typeof fetch; deployment?: MarketDeployment; vaults?: VaultDeployment } = {}): KitContext {
  const chainId = config.chainId;
  const dep = getDeployment(chainId);
  let marketDeployment = extra.deployment;
  let marketError: Error | undefined;
  if (!marketDeployment) {
    try {
      marketDeployment = getMarket(chainId, config.underlying ?? dep.markets[0]?.underlying ?? "NVDA");
    } catch (e) {
      marketError = e instanceof Error ? e : new Error(String(e));
    }
  }
  const vaults = extra.vaults ?? dep.vaults;
  const session = config.sessionKey ? privateKeyToAccount(config.sessionKey) : undefined;
  const owner = config.ownerKey ? privateKeyToAccount(config.ownerKey) : undefined;
  const account = config.account ?? owner?.address ?? session?.address;
  if (!account) throw new Error("no account: set HEDGEHOOD_ACCOUNT, or a session/owner key");
  const rfqOpts: ConstructorParameters<typeof RfqClient>[0] = { chainId, hosts: { ...(config.rfqUrl ? { rfq: config.rfqUrl } : {}), ...(config.indexerUrl ? { indexer: config.indexerUrl } : {}), ...(config.gatewayUrl ? { gateway: config.gatewayUrl } : {}) } };
  if (extra.fetch) rfqOpts.fetch = extra.fetch;
  const rfq = new RfqClient(rfqOpts);
  const requireMarket = (): MarketDeployment => {
    if (!marketDeployment) throw marketError ?? new Error(`no option market on chain ${chainId}`);
    return marketDeployment;
  };
  const market = (signer: "session" | "owner" | "none" = "session") => {
    const s = signer === "session" ? session : signer === "owner" ? owner : undefined;
    return new MarketClient({ chainId, rpcUrl: config.rpcUrl, deployment: requireMarket(), account, signer: s });
  };
  const vault = (signer: "owner" | "none" = "none") => {
    if (!vaults) throw new Error(`no Stock Yield vaults on chain ${chainId}`);
    const opts: ConstructorParameters<typeof VaultClient>[0] = { chainId, rpcUrl: config.rpcUrl, deployment: vaults, account, signer: signer === "owner" ? owner : undefined, apiUrl: config.vaultApiUrl };
    if (extra.fetch) opts.fetch = extra.fetch;
    return new VaultClient(opts);
  };
  return {
    config,
    chainId,
    get deployment() {
      return requireMarket();
    },
    marketDeployment,
    vaults,
    account,
    session,
    owner,
    rfq,
    market,
    vault,
    quotes: new Map(),
    fetch: extra.fetch,
  };
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
