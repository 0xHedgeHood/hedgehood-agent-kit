/**
 * x402 v2 "exact" payments in USDG for the Hedgehood deposit gateway (`POST /v1/deposit`), built on the official
 * `@x402/core` + `@x402/evm` client stack. The USDG preset (6 decimals, EIP-712 domain "Global Dollar" / "1", the
 * full-address allowlist against lookalike tokens, the capped signing window) is adapted from `@priors/x402`
 * (MIT, https://github.com/Leonardiae/priors/tree/main/packages/x402: networks.mjs, merchant.mjs `registerUsdg`,
 * payer.mjs `CappedExactEvmScheme` / `pickV2Requirement`). Thanks to the Priors contributors.
 *
 * Flow: POST the deposit intent -> 402 with PAYMENT-REQUIRED -> pick the one USDG requirement on our chain -> sign
 * an EIP-3009 TransferWithAuthorization with the agent's key -> resend with PAYMENT-SIGNATURE -> the gateway
 * settles the transfer and calls `market.deposit(account, amount)`; its response carries PAYMENT-RESPONSE and the
 * deposit tx hash. The payer signs a transfer of USDG from its own wallet to the gateway: the key that pays must
 * hold USDG. In the recommended setup that is the owner wallet funding `account`; a session key holds no funds.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { Address, Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { deployments, getDeployment, type SupportedChainId } from "./chains.js";
import { RfqPaths } from "./rfq.js";

/** The one token this payer signs for on each chain, by full address (never by symbol). */
export const USDG_NETWORKS = Object.freeze(
  Object.fromEntries(
    (Object.values(deployments) as Array<(typeof deployments)[SupportedChainId]>).map((d) => [
      d.caip2,
      Object.freeze({ network: d.caip2, chainId: d.chainId, asset: d.usdg, symbol: d.chainId === 4663 ? "USDG" : "tUSDG", decimals: 6, eip712: d.usdgEip712 }),
    ]),
  ) as Record<`eip155:${number}`, { network: `eip155:${number}`; chainId: number; asset: Address; symbol: string; decimals: 6; eip712: { name: string; version: string } }>,
);

/** The longest EIP-3009 validity window this payer signs, whatever `maxTimeoutSeconds` a 402 asks (as in @priors/x402). */
export const MAX_VALIDITY_SECONDS = 600;

export type MoneyParserScheme = { registerMoneyParser: (p: (amount: string | number, network: string) => Promise<unknown>) => unknown };

/**
 * Server side (for a gateway or a test merchant): teach an `ExactEvmScheme` from `@x402/evm/exact/server` that a
 * dollar price on a Robinhood Chain network means USDG. Port of `registerUsdg` in @priors/x402 merchant.mjs,
 * extended to testnet 46630. A price finer than one USDG unit is refused rather than rounded.
 */
export function registerUsdg<S extends MoneyParserScheme>(scheme: S, opts: { asset?: Address; network?: `eip155:${number}` } = {}): S {
  const network = opts.network ?? "eip155:4663";
  const preset = USDG_NETWORKS[network];
  if (!preset) throw new RangeError(`registerUsdg: unknown network ${network}`);
  const asset = opts.asset ?? preset.asset;
  scheme.registerMoneyParser(async (amount, net) => {
    if (net !== network) return null;
    return { amount: dollarsToUnits(amount).toString(), asset, extra: { name: preset.eip712.name, version: preset.eip712.version } };
  });
  return scheme;
}

/** "0.05" -> 50000n (6 decimals), refusing more than 6 decimals. */
export function dollarsToUnits(amount: string | number): bigint {
  const s = typeof amount === "number" ? amount.toFixed(12).replace(/\.?0+$/, "") : String(amount).trim().replace(/^\$/, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`USDG price: not a dollar amount: ${JSON.stringify(s)}`);
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > 6) throw new RangeError(`USDG price ${s} has more than 6 decimals`);
  const units = BigInt(m[1]!) * 10n ** 6n + BigInt(frac.padEnd(6, "0") || "0");
  if (units === 0n) throw new RangeError("USDG price must be above zero");
  return units;
}

function sameAddr(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

const CORE_PAYMENT_FLOWS = new Set(["authorization", "upfront", "escrow"]);

/**
 * The first v2 `exact` requirement this payer may sign: on `network`, for its USDG by full address, EIP-3009, with no
 * EIP-712 domain but the token's own, no exotic payment flow. Null when the 402 offers nothing acceptable.
 */
export function pickUsdgRequirement(accepts: PaymentRequirements[], network: `eip155:${number}`, asset?: Address): PaymentRequirements | null {
  const preset = USDG_NETWORKS[network];
  if (!preset) return null;
  const token = asset ?? preset.asset;
  return (
    accepts.find(
      (x) =>
        x &&
        x.scheme === "exact" &&
        x.network === network &&
        sameAddr(x.asset, token) &&
        /^\d+$/.test(String(x.amount)) &&
        /^0x[0-9a-fA-F]{40}$/.test(String(x.payTo)) &&
        (!x.extra?.assetTransferMethod || x.extra.assetTransferMethod === "eip3009") &&
        (x.extra?.paymentFlow == null || CORE_PAYMENT_FLOWS.has(String(x.extra.paymentFlow))) &&
        (!x.extra?.name || x.extra.name === preset.eip712.name) &&
        (!x.extra?.version || x.extra.version === preset.eip712.version),
    ) ?? null
  );
}

/** `ExactEvmScheme` that caps the signed validity window and fills in USDG's domain when a 402 omits it. */
class CappedUsdgScheme {
  readonly scheme = "exact";
  private readonly inner: ExactEvmScheme;
  constructor(
    signer: LocalAccount,
    private readonly network: `eip155:${number}`,
    private readonly maxValiditySeconds = MAX_VALIDITY_SECONDS,
  ) {
    this.inner = new ExactEvmScheme({ address: signer.address, signTypedData: (m) => signer.signTypedData(m as never) });
  }
  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements, context?: unknown) {
    if (requirements.extra?.assetTransferMethod && requirements.extra.assetTransferMethod !== "eip3009") {
      throw new Error("only EIP-3009 authorizations are signed for USDG");
    }
    const preset = USDG_NETWORKS[this.network]!;
    const extra = { ...(requirements.extra ?? {}) };
    if (!extra.name) extra.name = preset.eip712.name;
    if (!extra.version) extra.version = preset.eip712.version;
    const window = Math.max(1, Math.min(Number(requirements.maxTimeoutSeconds) || this.maxValiditySeconds, this.maxValiditySeconds));
    return this.inner.createPaymentPayload(x402Version, { ...requirements, maxTimeoutSeconds: window, extra }, context as never);
  }
}

export interface UsdgPayerOptions {
  /** The key that pays: it must hold USDG on `chainId`. */
  signer: LocalAccount;
  chainId: number;
  /** Most one payment may be, USDG raw (default 1,000 USDG). Refuses larger 402s. */
  maxAmountRaw?: bigint;
  maxValiditySeconds?: number;
  /** Override the USDG address (a fork); default from the registry. */
  asset?: Address;
}

/** An `x402Client` that signs USDG on one Robinhood Chain network only, under a per-payment cap. */
export function createUsdgClient(opts: UsdgPayerOptions): { client: x402Client; http: x402HTTPClient; network: `eip155:${number}`; asset: Address; cap: bigint } {
  const dep = getDeployment(opts.chainId);
  const network = dep.caip2;
  const asset = opts.asset ?? dep.usdg;
  const cap = opts.maxAmountRaw ?? 1_000_000_000n;
  const client = new x402Client()
    .register(network, new CappedUsdgScheme(opts.signer, network, opts.maxValiditySeconds) as never)
    .setSpendControls({ allowedAssets: [{ network, asset, maxAmountPerPayment: cap.toString() }] });
  return { client, http: new x402HTTPClient(client), network, asset, cap };
}

export interface DepositViaGatewayRequest {
  /** The market account to credit (`market.deposit(account, amount)`), normally the agent's owner account. */
  account: Address;
  market: Address;
  /** USDG raw to deposit; the gateway's 402 must ask exactly this (or less). */
  amountRaw: bigint;
}

export interface DepositViaGatewayResult {
  /** True when nothing was signed or sent (dry run): `requirement` shows what the gateway asked. */
  dryRun: boolean;
  requirement?: PaymentRequirements;
  /** The signed payment (resend these headers on a retry; never sign twice for one deposit). */
  paymentHeaders?: Record<string, string>;
  payload?: PaymentPayload;
  status?: number;
  body?: unknown;
  /** Settlement reported in PAYMENT-RESPONSE, if any (the EIP-3009 transfer's tx hash). */
  settlement?: { success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string };
  /** The deposit tx hash the gateway reports in its body (`depositTxHash`), when it does. */
  depositTxHash?: Hex;
}

export interface DepositViaGatewayOptions extends UsdgPayerOptions {
  apiUrl?: string;
  fetch?: typeof fetch;
  /** Default true: stop after the 402 and report the requirement without signing. */
  dryRun?: boolean;
  timeoutMs?: number;
}

/**
 * Deposits USDG into `account`'s market balance through the x402 gateway. Checks before signing: the 402 names our
 * chain's USDG by full address, asks no more than `amountRaw` and no more than the payer's cap. The request body is
 * `{ chainId, market, account, amountRaw }`; the gateway shape is assumed (see rfq.ts header).
 */
export async function depositViaGateway(req: DepositViaGatewayRequest, opts: DepositViaGatewayOptions): Promise<DepositViaGatewayResult> {
  const dep = getDeployment(opts.chainId);
  const apiUrl = (opts.apiUrl ?? dep.apiUrl)?.replace(/\/+$/, "");
  if (!apiUrl) throw new Error(`no API url for chain ${opts.chainId}`);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = `${apiUrl}${RfqPaths.deposit}`;
  const body = JSON.stringify({ chainId: opts.chainId, market: req.market, account: req.account, amountRaw: req.amountRaw.toString() });
  const headers = { "content-type": "application/json", accept: "application/json" };
  const { http, network, asset, cap } = createUsdgClient(opts);

  const first = await fetchImpl(url, { method: "POST", headers, body });
  if (first.status !== 402) {
    const text = await first.text();
    throw new Error(`deposit gateway answered ${first.status} instead of 402: ${text.slice(0, 300)}`);
  }
  let parsedBody: unknown;
  const text = await first.text();
  try {
    parsedBody = text ? JSON.parse(text) : undefined;
  } catch {
    parsedBody = undefined;
  }
  const paymentRequired: PaymentRequired = http.getPaymentRequiredResponse((n) => first.headers.get(n), parsedBody);
  const requirement = pickUsdgRequirement(paymentRequired.accepts ?? [], network, asset);
  if (!requirement) throw new Error(`the gateway's 402 offers no USDG "exact" requirement on ${network} for ${asset}; nothing was signed`);
  const price = BigInt(requirement.amount);
  if (price > req.amountRaw) throw new Error(`the gateway asks ${price} USDG raw, more than the requested deposit ${req.amountRaw}; nothing was signed`);
  if (price > cap) throw new Error(`the gateway asks ${price} USDG raw, above this payer's cap ${cap}; nothing was signed`);
  if (opts.dryRun ?? true) return { dryRun: true, requirement };

  const payload = await http.createPaymentPayload({ ...paymentRequired, accepts: [requirement] });
  const paymentHeaders = http.encodePaymentSignatureHeader(payload);
  const second = await fetchImpl(url, { method: "POST", headers: { ...headers, ...paymentHeaders }, body });
  const text2 = await second.text();
  let body2: unknown;
  try {
    body2 = text2 ? JSON.parse(text2) : undefined;
  } catch {
    body2 = text2;
  }
  let settlement: DepositViaGatewayResult["settlement"];
  try {
    settlement = http.getPaymentSettleResponse((n) => second.headers.get(n)) as DepositViaGatewayResult["settlement"];
  } catch {
    settlement = undefined;
  }
  const depositTxHash = (body2 as { depositTxHash?: Hex } | undefined)?.depositTxHash;
  if (!second.ok) {
    const err = new Error(`deposit gateway refused the payment: ${second.status} ${text2.slice(0, 300)}`);
    Object.assign(err, { paymentHeaders, payload, status: second.status, body: body2, settlement });
    throw err;
  }
  return { dryRun: false, requirement, paymentHeaders, payload, status: second.status, body: body2, settlement, depositTxHash };
}
