import { formatUnits, parseUnits } from "viem";

export const USDG_DECIMALS = 6;
export const SHARE_DECIMALS = 18;
export const WHOLE_SHARE = 10n ** 18n;

/** "12.5" USDG -> 12500000n. Refuses more than 6 decimals rather than rounding. */
export function parseUsdg(v: string | number | bigint): bigint {
  if (typeof v === "bigint") return v;
  const s = typeof v === "number" ? v.toString() : v.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new RangeError(`not a USDG amount with at most 6 decimals: ${s}`);
  return parseUnits(s, USDG_DECIMALS);
}

export function formatUsdg(raw: bigint): string {
  return formatUnits(raw, USDG_DECIMALS);
}

/** "1.5" shares -> 1500000000000000000n. */
export function parseShares(v: string | number | bigint): bigint {
  if (typeof v === "bigint") return v;
  const s = typeof v === "number" ? v.toString() : v.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new RangeError(`not a share quantity with at most 18 decimals: ${s}`);
  return parseUnits(s, SHARE_DECIMALS);
}

export function formatShares(raw: bigint): string {
  return formatUnits(raw, SHARE_DECIMALS);
}

/** Price per whole share from a total premium and quantity, as a decimal string (floored at 6 decimals). */
export function pricePerShare(premiumRaw: bigint, quantityRaw: bigint): string {
  if (quantityRaw === 0n) return "0";
  return formatUsdg((premiumRaw * WHOLE_SHARE) / quantityRaw);
}

/** Strike in USDG raw per share -> "220" / "222.5". */
export function formatStrike(strikeRaw: bigint): string {
  const s = formatUsdg(strikeRaw);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
