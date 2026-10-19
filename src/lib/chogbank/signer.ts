import { getAddress, type Address } from "viem";

/**
 * Protected signer for ChogBank. This milestone has no live backend.
 * Environment private keys are never loaded into a signing object.
 */
export type ProtectedSigner = {
  kind: "none";
  address: null;
  reason: string;
};

const REFUSED_KEYS = [
  "CHOG_BANK_RELAYER_PRIVATE_KEY",
  "CHOG_BANK_SIGNER_KEY",
  "CHOG_BANK_TREASURY_PRIVATE_KEY",
] as const;

export function loadProtectedSigner(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ProtectedSigner {
  for (const name of REFUSED_KEYS) {
    if (env[name] && env[name]!.trim() !== "") {
      return {
        kind: "none",
        address: null,
        reason: `${name} is set; this milestone refuses to load relayer keys from the environment`,
      };
    }
  }
  return {
    kind: "none",
    address: null,
    reason: "no protected signer backend is configured",
  };
}

export function signerAddress(signer: ProtectedSigner): null {
  return signer.address;
}

/** Operations a future gas signer may sign. Asset-control keys are not in this list. */
export const APPROVED_SIGNER_OPS = ["factory.create", "account.executeSession", "account.invalidateSession"] as const;

/**
 * Packages a production signer would need. None of these are installed.
 * Do not add a private-key signer to satisfy this list.
 */
export const MISSING_SIGNER_DEPENDENCIES = [
  "@aws-sdk/client-kms",
  "@google-cloud/kms",
  "@privy-io/node",
  "@turnkey/sdk-server",
  "@fireblocks/ts-sdk",
] as const;

export type GasSigner = {
  kind: "none";
  canSign: false;
  gasAddress: Address | null;
  assetAddress: Address | null;
  approvedOps: typeof APPROVED_SIGNER_OPS;
  reason: string;
};

const GAS_KEY_NAMES = [
  ...REFUSED_KEYS,
  "CHOG_BANK_GAS_PRIVATE_KEY",
  "CHOG_BANK_ASSET_PRIVATE_KEY",
] as const;

/**
 * Public addresses only. canSign is always false: this repository has no KMS or custody SDK.
 * A configured gas address can be observed. It is not a key.
 */
export function loadGasSigner(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): GasSigner {
  for (const name of GAS_KEY_NAMES) {
    if (env[name] && env[name]!.trim() !== "") {
      return {
        kind: "none",
        canSign: false,
        gasAddress: null,
        assetAddress: null,
        approvedOps: APPROVED_SIGNER_OPS,
        reason: `${name} is set; signing stays disabled and the secret is not loaded`,
      };
    }
  }

  const gasAddress = readAddress(env.CHOG_BANK_GAS_ADDRESS);
  const assetAddress = readAddress(env.CHOG_BANK_ASSET_ADDRESS);
  if (gasAddress === "invalid" || assetAddress === "invalid") {
    return disabled(null, null, "CHOG_BANK_GAS_ADDRESS or CHOG_BANK_ASSET_ADDRESS is not a valid address");
  }
  if (gasAddress && assetAddress && gasAddress.toLowerCase() === assetAddress.toLowerCase()) {
    return disabled(null, null, "gas-paying address must differ from the treasury asset address");
  }
  return disabled(
    gasAddress,
    assetAddress,
    `signing is disabled. No KMS or custody SDK is installed (${MISSING_SIGNER_DEPENDENCIES.join(", ")}).`,
  );
}

function disabled(gasAddress: Address | null, assetAddress: Address | null, reason: string): GasSigner {
  return {
    kind: "none",
    canSign: false,
    gasAddress,
    assetAddress,
    approvedOps: APPROVED_SIGNER_OPS,
    reason,
  };
}

function readAddress(value: string | undefined): Address | null | "invalid" {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return getAddress(trimmed);
  } catch {
    return "invalid";
  }
}
