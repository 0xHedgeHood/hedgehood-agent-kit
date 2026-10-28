import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Address, Hex } from "viem";

/**
 * Configuration of the local server, from the environment. Keys are read once, kept in memory, and never
 * logged, echoed in tool output or included in error messages.
 *
 *   HEDGEHOOD_CHAIN_ID          46630 (default) or 4663
 *   HEDGEHOOD_RPC_URL           override the chain's public RPC
 *   HEDGEHOOD_API_URL           override the agent-market backend
 *   HEDGEHOOD_UNDERLYING        NVDA (default: first market on the chain)
 *   HEDGEHOOD_ACCOUNT           the trading account (owner address) the session key acts for; defaults to the
 *                               owner key's address, else the session key's own address (self-custody mode)
 *   HEDGEHOOD_SESSION_KEY_FILE  path to a file holding the session private key (0x + 64 hex), or
 *   HEDGEHOOD_SESSION_KEY       the key itself (prefer the file)
 *   HEDGEHOOD_OWNER_KEY_FILE    optional owner key for deposit / withdraw / authorize_session / register_agent, or
 *   HEDGEHOOD_OWNER_KEY         (keep the owner key offline where you can; the session key is enough to trade)
 *   HEDGEHOOD_DRY_RUN           "false" to make sends real by default (tools still need confirm: true)
 *   HEDGEHOOD_MAX_DEPOSIT       cap per x402 deposit, USDG (default 1000)
 */
export interface KitConfig {
  chainId: number;
  rpcUrl?: string;
  apiUrl?: string;
  underlying?: string;
  account?: Address;
  sessionKey?: Hex;
  ownerKey?: Hex;
  dryRunDefault: boolean;
  maxDepositUsdg: string;
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
  const chainId = Number(envValue(env, "HEDGEHOOD_CHAIN_ID") ?? 46630);
  if (chainId !== 46630 && chainId !== 4663) throw new Error(`HEDGEHOOD_CHAIN_ID must be 46630 or 4663 (got ${env.HEDGEHOOD_CHAIN_ID})`);
  const account = envValue(env, "HEDGEHOOD_ACCOUNT");
  if (account && !/^0x[0-9a-fA-F]{40}$/.test(account)) throw new Error("HEDGEHOOD_ACCOUNT is not an address");
  return {
    chainId,
    rpcUrl: envValue(env, "HEDGEHOOD_RPC_URL"),
    apiUrl: envValue(env, "HEDGEHOOD_API_URL"),
    underlying: envValue(env, "HEDGEHOOD_UNDERLYING"),
    account: account as Address | undefined,
    sessionKey: keyFrom(env, "HEDGEHOOD_SESSION_KEY_FILE", "HEDGEHOOD_SESSION_KEY"),
    ownerKey: keyFrom(env, "HEDGEHOOD_OWNER_KEY_FILE", "HEDGEHOOD_OWNER_KEY"),
    dryRunDefault: (envValue(env, "HEDGEHOOD_DRY_RUN") ?? "true").toLowerCase() !== "false",
    maxDepositUsdg: envValue(env, "HEDGEHOOD_MAX_DEPOSIT") ?? "1000",
  };
}

/** A copy of the config safe to print: keys replaced by their presence. */
export function describeConfig(cfg: KitConfig): Record<string, unknown> {
  return {
    chainId: cfg.chainId,
    rpcUrl: cfg.rpcUrl ?? "(chain default)",
    apiUrl: cfg.apiUrl ?? "(registry default)",
    underlying: cfg.underlying ?? "(first market)",
    account: cfg.account ?? "(derived from keys)",
    sessionKey: cfg.sessionKey ? "set" : "missing",
    ownerKey: cfg.ownerKey ? "set" : "missing",
    dryRunDefault: cfg.dryRunDefault,
    maxDepositUsdg: cfg.maxDepositUsdg,
  };
}
