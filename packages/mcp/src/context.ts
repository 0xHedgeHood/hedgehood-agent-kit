import { getDeployment, getMarket, LendingClient, MarketClient, readAccount, resolveMarket, RfqClient, VaultClient, type AccountView, type LendingDeployment, type MarketDeployment, type VaultDeployment, type VerifiedQuote } from "@hedgehood-io/sdk";
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
  /** Share lending (USDG lending vault + Blue market on fund shares) of the chain, when deployed. */
  lendingDeployment?: LendingDeployment;
  /** The trading account every tool reads and trades for. */
  account: Address;
  session?: LocalAccount;
  owner?: LocalAccount;
  rfq: RfqClient;
  /** A market client signing with the session key (trades, redeemFor) or the owner key (deposit, withdraw, sessions). */
  market: (signer?: "session" | "owner" | "none") => MarketClient;
  /** Every option market of the chain (one CashOptionMarketV2 per underlying; each keeps its own balance and sessions). */
  markets: MarketDeployment[];
  /** A market client for another market of the chain, by ticker or market / book address; undefined = the default market. */
  marketFor: (ref: string | undefined, signer?: "session" | "owner" | "none") => MarketClient;
  /** The account across every market (`readAccount`), with the configured trading key's session status. */
  accountView: (key?: Address) => Promise<AccountView>;
  /** A vault client: reads, or writes signed with the owner key (a session key cannot act on a vault). */
  vault: (signer?: "owner" | "none") => VaultClient;
  /** A lending client: reads, or writes signed with the owner key (it holds the USDG and the fund shares). */
  lending: (signer?: "owner" | "none") => LendingClient;
  /** Quotes returned by get_quote, by digest, so fill_quote can take a digest instead of the whole order. */
  quotes: Map<Hex, { quote: VerifiedQuote; fetchedAt: number; side: "buy" | "sell"; requestedQuantityRaw: bigint; underlying?: string }>;
  fetch?: typeof fetch;
}

export function createContext(config: KitConfig, extra: { fetch?: typeof fetch; deployment?: MarketDeployment; vaults?: VaultDeployment; lending?: LendingDeployment } = {}): KitContext {
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
  const lendingDeployment = extra.lending ?? dep.lending;
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
  const signerOf = (signer: "session" | "owner" | "none") => (signer === "session" ? session : signer === "owner" ? owner : undefined);
  const market = (signer: "session" | "owner" | "none" = "session") => new MarketClient({ chainId, rpcUrl: config.rpcUrl, deployment: requireMarket(), account, signer: signerOf(signer) });
  const markets = extra.deployment && !dep.markets.some((m) => m.market.toLowerCase() === extra.deployment!.market.toLowerCase()) ? [extra.deployment, ...dep.markets] : dep.markets;
  const marketFor = (ref: string | undefined, signer: "session" | "owner" | "none" = "session") => {
    if (ref === undefined || ref.trim() === "") return market(signer);
    const r = ref.trim().toLowerCase();
    const deployment = markets.find((m) => m.underlying.toLowerCase() === r || m.market.toLowerCase() === r || m.orderBook.toLowerCase() === r) ?? resolveMarket(chainId, ref);
    return new MarketClient({ chainId, rpcUrl: config.rpcUrl, deployment, account, signer: signerOf(signer) });
  };
  const accountView = (key?: Address) => readAccount({ chainId, rpcUrl: config.rpcUrl, account, key: key ?? (session ?? owner)?.address, markets });
  const vault = (signer: "owner" | "none" = "none") => {
    if (!vaults) throw new Error(`no Stock Yield vaults on chain ${chainId}`);
    const opts: ConstructorParameters<typeof VaultClient>[0] = { chainId, rpcUrl: config.rpcUrl, deployment: vaults, account, signer: signer === "owner" ? owner : undefined, apiUrl: config.vaultApiUrl };
    if (extra.fetch) opts.fetch = extra.fetch;
    return new VaultClient(opts);
  };
  const lending = (signer: "owner" | "none" = "none") => {
    if (!lendingDeployment) throw new Error(`share lending is not deployed on chain ${chainId}`);
    const opts: ConstructorParameters<typeof LendingClient>[0] = { chainId, rpcUrl: config.rpcUrl, deployment: lendingDeployment, account, signer: signer === "owner" ? owner : undefined };
    if (extra.fetch) opts.fetch = extra.fetch;
    return new LendingClient(opts);
  };
  return {
    config,
    chainId,
    get deployment() {
      return requireMarket();
    },
    marketDeployment,
    vaults,
    lendingDeployment,
    account,
    session,
    owner,
    rfq,
    market,
    markets,
    marketFor,
    accountView,
    vault,
    lending,
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

/**
 * Who signs a fill or close. `role` "owner" means the signing key IS the account: it may fill in wallet mode (pay from
 * its wallet, no deposit) or in balance mode with an automatic deposit. `role` "session" is a session key: balance mode
 * only, and it never moves funds. Default: the session key when configured, else the owner key; `prefer` overrides.
 */
export interface TradeSigner {
  who: "session" | "owner";
  role: "owner" | "session";
  signer: LocalAccount;
}

export function tradeSigner(ctx: KitContext, prefer?: "session" | "owner"): TradeSigner {
  const pick = prefer ?? (ctx.session ? "session" : "owner");
  const signer = pick === "owner" ? ctx.owner : ctx.session;
  if (!signer) throw new Error(pick === "owner" ? "no owner key: set HEDGEHOOD_OWNER_KEY_FILE (or use the session key)" : "no session key: set HEDGEHOOD_SESSION_KEY_FILE");
  const role = signer.address.toLowerCase() === ctx.account.toLowerCase() ? "owner" : "session";
  if (pick === "owner" && role !== "owner") throw new Error(`the owner key ${signer.address} is not the trading account ${ctx.account}: it cannot fill for it`);
  return { who: pick, role, signer };
}
