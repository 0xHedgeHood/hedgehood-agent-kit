import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";
import { DEFAULT_CHAIN_ID } from "@hedgehood-io/sdk";

/**
 * Configuration of the local server, from the environment. Keys are read once, kept in memory, and never
 * logged, echoed in tool output or included in error messages.
 *
 *   HEDGEHOOD_CHAIN_ID          46630 (testnet) or 4663 (mainnet); default DEFAULT_CHAIN_ID (46630)
 *   HEDGEHOOD_RPC_URL           override the chain's public RPC
 *   HEDGEHOOD_RFQ_URL           override the quote service host (default per chain: https://agent-api.hedgehood.io on
 *                               mainnet, https://testnet-agent-api.hedgehood.io on the testnet)
 *   HEDGEHOOD_INDEXER_URL       override the indexer host (default agent-index / testnet-agent-index .hedgehood.io)
 *   HEDGEHOOD_GATEWAY_URL       override the x402 deposit gateway host (default agent-pay / testnet-agent-pay .hedgehood.io)
 *   HEDGEHOOD_UNDERLYING        NVDA (default: first market on the chain)
 *   HEDGEHOOD_ACCOUNT           the trading account (owner address) the session key acts for; defaults to the
 *                               owner key's address, else the session key's own address (self-custody mode)
 *   HEDGEHOOD_SESSION_KEY_FILE  path to a file holding the session private key (0x + 64 hex), or
 *   HEDGEHOOD_SESSION_KEY       the key itself (prefer the file)
 *   HEDGEHOOD_OWNER_KEY_FILE    optional owner key for deposit / withdraw / authorize_session / register_agent, or
 *   HEDGEHOOD_OWNER_KEY         (keep the owner key offline where you can; the session key is enough to trade)
 *   HEDGEHOOD_PAYER_KEY_FILE    optional agent payment wallet (`hedgehood init --with-payer`): pays x402 deposits into
 *   HEDGEHOOD_PAYER_KEY         the account's market balances, nothing else (EIP-3009: it only signs, holds USDG, no ETH)
 *   HEDGEHOOD_DRY_RUN           "false" to make sends real by default (tools still need confirm: true)
 *   HEDGEHOOD_MAX_DEPOSIT       cap per x402 deposit, USDG (default 1000)
 *   HEDGEHOOD_VAULT_API_URL     Stock Yield fund snapshot API for list_vaults (default: the chain's registry entry,
 *                               https://hedgehood.app/api/stockyield/funds on mainnet); "off" reads the chain only
 */
export interface KitConfig {
  chainId: number;
  rpcUrl?: string;
  rfqUrl?: string;
  indexerUrl?: string;
  gatewayUrl?: string;
  underlying?: string;
  account?: Address;
  sessionKey?: Hex;
  ownerKey?: Hex;
  /** The agent payment wallet: pays x402 deposits (before the owner key and the session key). */
  payerKey?: Hex;
  dryRunDefault: boolean;
  maxDepositUsdg: string;
  /** Stock Yield fund snapshot API; `false` = chain reads only. Undefined = the chain's registry default (mainnet only). */
  vaultApiUrl?: string | false;
}

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export class KeyError extends Error {}

/** Reads a private key from a file: trims whitespace, accepts a bare 64-hex or 0x-prefixed key. Refuses group/world-readable files on POSIX. */
export function readKeyFile(path: string): Hex {
  const p = path.startsWith("~") ? resolve(homedir(), path.slice(2)) : resolve(path);
  let text: string;
  try {
    const st = statSync(p);
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      throw new KeyError(`key file ${p} is readable by others; chmod 600 it`);
    }
    text = readFileSync(p, "utf8");
  } catch (e) {
    if (e instanceof KeyError) throw e;
    throw new KeyError(`cannot read key file ${p}`);
  }
  return normalizeKey(text, `key file ${p}`);
}

export function normalizeKey(text: string, what: string): Hex {
  let s = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) s = `0x${s}`;
  if (!KEY_RE.test(s)) throw new KeyError(`${what} does not hold a 32-byte hex private key`);
  return s as Hex;
}

/** An env value that is empty or an unexpanded `${VAR}` placeholder (plugin manifests) counts as unset. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  if (!v || /^\$\{[^}]*\}$/.test(v)) return undefined;
  return v;
}

function keyFrom(env: NodeJS.ProcessEnv, fileVar: string, rawVar: string): Hex | undefined {
  const file = envValue(env, fileVar);
  if (file) return readKeyFile(file);
  const raw = envValue(env, rawVar);
  if (raw) return normalizeKey(raw, rawVar);
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KitConfig {
  const chainId = Number(envValue(env, "HEDGEHOOD_CHAIN_ID") ?? DEFAULT_CHAIN_ID);
  if (chainId !== 46630 && chainId !== 4663) throw new Error(`HEDGEHOOD_CHAIN_ID must be 46630 or 4663 (got ${env.HEDGEHOOD_CHAIN_ID})`);
  const account = envValue(env, "HEDGEHOOD_ACCOUNT");
  if (account && !/^0x[0-9a-fA-F]{40}$/.test(account)) throw new Error("HEDGEHOOD_ACCOUNT is not an address");
  const vaultApi = envValue(env, "HEDGEHOOD_VAULT_API_URL");
  return {
    chainId,
    rpcUrl: envValue(env, "HEDGEHOOD_RPC_URL"),
    rfqUrl: envValue(env, "HEDGEHOOD_RFQ_URL"),
    indexerUrl: envValue(env, "HEDGEHOOD_INDEXER_URL"),
    gatewayUrl: envValue(env, "HEDGEHOOD_GATEWAY_URL"),
    underlying: envValue(env, "HEDGEHOOD_UNDERLYING"),
    account: account as Address | undefined,
    sessionKey: keyFrom(env, "HEDGEHOOD_SESSION_KEY_FILE", "HEDGEHOOD_SESSION_KEY"),
    ownerKey: keyFrom(env, "HEDGEHOOD_OWNER_KEY_FILE", "HEDGEHOOD_OWNER_KEY"),
    payerKey: keyFrom(env, "HEDGEHOOD_PAYER_KEY_FILE", "HEDGEHOOD_PAYER_KEY"),
    dryRunDefault: (envValue(env, "HEDGEHOOD_DRY_RUN") ?? "true").toLowerCase() !== "false",
    maxDepositUsdg: envValue(env, "HEDGEHOOD_MAX_DEPOSIT") ?? "1000",
    vaultApiUrl: vaultApi === undefined ? undefined : /^(off|false|0|none)$/i.test(vaultApi) ? false : vaultApi,
  };
}

/** A copy of the config safe to print: keys replaced by their presence. */
export function describeConfig(cfg: KitConfig): Record<string, unknown> {
  return {
    chainId: cfg.chainId,
    rpcUrl: cfg.rpcUrl ?? "(chain default)",
    rfqUrl: cfg.rfqUrl ?? "(registry default)",
    indexerUrl: cfg.indexerUrl ?? "(registry default)",
    gatewayUrl: cfg.gatewayUrl ?? "(registry default)",
    underlying: cfg.underlying ?? "(first market)",
    account: cfg.account ?? "(derived from keys)",
    sessionKey: cfg.sessionKey ? "set" : "missing",
    ownerKey: cfg.ownerKey ? "set" : "missing",
    payerKey: cfg.payerKey ? "set" : "missing",
    dryRunDefault: cfg.dryRunDefault,
    maxDepositUsdg: cfg.maxDepositUsdg,
    vaultApiUrl: cfg.vaultApiUrl === false ? "off (chain only)" : (cfg.vaultApiUrl ?? "(registry default)"),
  };
}

/**
 * Non-secret settings `hedgehood init` saves in `~/.hedgehood/config.json` (HEDGEHOOD_CONFIG overrides the path,
 * "off" disables it), so the CLI and the MCP server find the account, chain and key files without flags. Precedence:
 * flags > environment > this file > built-in defaults. It never holds a private key: only paths to key files.
 */
export interface SettingsFile {
  chainId?: number;
  account?: Address;
  sessionKeyFile?: string;
  payerKeyFile?: string;
  siteUrl?: string;
  underlying?: string;
}

/** The kit's home directory: HEDGEHOOD_HOME, default ~/.hedgehood. */
export function hedgehoodHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(expandHome(envValue(env, "HEDGEHOOD_HOME") ?? "~/.hedgehood"));
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

/** The settings file path, or undefined when HEDGEHOOD_CONFIG is "off". */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = envValue(env, "HEDGEHOOD_CONFIG");
  if (v && /^(off|false|0|none)$/i.test(v)) return undefined;
  return v ? expandHome(v) : resolve(hedgehoodHome(env), "config.json");
}

/** Reads the settings file; {} when it does not exist. Throws on a file that is not a JSON object. */
export function readSettings(path: string | undefined): SettingsFile {
  if (!path) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`settings file ${path} is not valid JSON`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`settings file ${path} is not a JSON object`);
  return v as SettingsFile;
}

/**
 * The environment with the settings file filled in where the environment is silent. A key given in the environment
 * (file or raw) always wins over the file's key path.
 */
export function withSettings(env: NodeJS.ProcessEnv = process.env, settings: SettingsFile = readSettings(settingsPath(env))): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const fill = (name: string, v: unknown, unlessAlso?: string) => {
    if (v === undefined || v === null || v === "") return;
    if (envValue(out, name) !== undefined || (unlessAlso && envValue(out, unlessAlso) !== undefined)) return;
    out[name] = String(v);
  };
  fill("HEDGEHOOD_CHAIN_ID", settings.chainId);
  fill("HEDGEHOOD_ACCOUNT", settings.account);
  fill("HEDGEHOOD_SESSION_KEY_FILE", settings.sessionKeyFile, "HEDGEHOOD_SESSION_KEY");
  fill("HEDGEHOOD_PAYER_KEY_FILE", settings.payerKeyFile, "HEDGEHOOD_PAYER_KEY");
  fill("HEDGEHOOD_SITE_URL", settings.siteUrl);
  fill("HEDGEHOOD_UNDERLYING", settings.underlying);
  return out;
}
