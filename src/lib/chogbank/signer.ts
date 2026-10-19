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
