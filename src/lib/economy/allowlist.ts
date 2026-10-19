import { getAddress, type Address, type Hex } from "viem";

export type ProtocolAsset = "MON" | "CHOG";

export type ProtocolRule = {
  chainId: 143;
  target: Address;
  selectors: Hex[];
  assets: ProtocolAsset[];
  label: string;
};

const SELECTOR = /^0x[0-9a-fA-F]{8}$/;

/**
 * Executable protocols start empty. A rule is accepted only from explicit
 * operator JSON. Unknown or malformed config stays empty and cannot spend.
 */
export function parseProtocolAllowlist(raw: string | undefined): { rules: ProtocolRule[]; reason: string } {
  const text = raw?.trim();
  if (!text) {
    return { rules: [], reason: "No protocol allowlist is configured." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { rules: [], reason: "The protocol allowlist is not valid JSON, so it is empty." };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { rules: [], reason: "The protocol allowlist is empty." };
  }
  const rules: ProtocolRule[] = [];
  for (const item of parsed) {
    const rule = parseRule(item);
    if (!rule) {
      return { rules: [], reason: "A protocol rule was malformed, so the executable allowlist is empty." };
    }
    rules.push(rule);
  }
  return { rules, reason: `${rules.length} reviewed protocol rule${rules.length === 1 ? "" : "s"} configured.` };
}

function parseRule(value: unknown): ProtocolRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (row.chainId !== 143 || typeof row.target !== "string" || typeof row.label !== "string" || !row.label.trim()) {
    return null;
  }
  let target: Address;
  try {
    target = getAddress(row.target);
  } catch {
    return null;
  }
  if (!Array.isArray(row.selectors) || row.selectors.length === 0) {
    return null;
  }
  const selectors: Hex[] = [];
  for (const selector of row.selectors) {
    if (typeof selector !== "string" || !SELECTOR.test(selector)) {
      return null;
    }
    selectors.push(selector.toLowerCase() as Hex);
  }
  if (!Array.isArray(row.assets) || row.assets.length === 0) {
    return null;
  }
  const assets: ProtocolAsset[] = [];
  for (const asset of row.assets) {
    if (asset !== "MON" && asset !== "CHOG") {
      return null;
    }
    assets.push(asset);
  }
  return { chainId: 143, target, selectors, assets, label: row.label.trim().slice(0, 80) };
}

export function findProtocolRule(
  rules: readonly ProtocolRule[],
  target: Address,
  selector: Hex,
  asset: ProtocolAsset,
): ProtocolRule | null {
  const wanted = target.toLowerCase();
  const call = selector.toLowerCase();
  return (
    rules.find(
      (rule) =>
        rule.chainId === 143 &&
        rule.target.toLowerCase() === wanted &&
        rule.selectors.some((item) => item.toLowerCase() === call) &&
        rule.assets.includes(asset),
    ) ?? null
  );
}
