import { explorerAddressUrl } from "@/lib/blockchain/explorer";
import {
  V11_FACTORY_CREATION_KECCAK,
  V11_FACTORY_PREDICTED,
  V2_FACTORY_CREATION_KECCAK,
  V2_FACTORY_PREDICTED,
  V2_IMPLEMENTATION_CREATION_KECCAK,
  V2_IMPLEMENTATION_PREDICTED,
  V2_WALLET_104_PREDICTED,
  V2_WALLET_129_PREDICTED,
} from "@/lib/chogbank/factory";
import { codePresenceLabel, readAddressCodes } from "@/lib/verify/anchor";
import type { SupportedChainId } from "@/lib/blockchain/chains";

export type ArtifactView = {
  id: string;
  label: string;
  hash: string | null;
  hashKind: string;
  address: string | null;
  chainId: 143;
  explorerUrl: string | null;
  deployment: "predicted_not_deployed";
  note: string;
  codeBytes: number | null;
  codeLabel: string;
};

const PREDICTED_NOTE =
  "Predicted and not broadcast. An explorer address page does not prove bytecode is deployed.";

function artifact(
  input: Omit<ArtifactView, "explorerUrl" | "deployment" | "codeBytes" | "codeLabel" | "chainId" | "note"> & { note?: string },
): ArtifactView {
  return {
    ...input,
    note: input.note ?? PREDICTED_NOTE,
    chainId: 143,
    deployment: "predicted_not_deployed",
    explorerUrl: explorerAddressUrl(143, input.address),
    codeBytes: null,
    codeLabel: codePresenceLabel(null),
  };
}

/** Creation-code hashes and predicted addresses maintained by this repository. */
export function deploymentArtifacts(): ArtifactView[] {
  return [
    artifact({
      id: "v2-implementation",
      label: "CitizenAccountV2 implementation creation code",
      hash: V2_IMPLEMENTATION_CREATION_KECCAK,
      hashKind: "creation-code keccak256",
      address: V2_IMPLEMENTATION_PREDICTED,
    }),
    artifact({
      id: "v2-factory",
      label: "CitizenAccountFactory V2 creation code",
      hash: V2_FACTORY_CREATION_KECCAK,
      hashKind: "creation-code keccak256",
      address: V2_FACTORY_PREDICTED,
    }),
    artifact({
      id: "v11-factory",
      label: "CitizenAccountFactory V1.1 creation code",
      hash: V11_FACTORY_CREATION_KECCAK,
      hashKind: "creation-code keccak256",
      address: V11_FACTORY_PREDICTED,
      note: "Unused V1.1 prediction. Predicted and not broadcast. Do not treat the address as a deployed factory.",
    }),
    artifact({
      id: "v2-wallet-104",
      label: "Predicted wallet for Chog Genesis token 104",
      hash: null,
      hashKind: "predicted address",
      address: V2_WALLET_104_PREDICTED,
      note: "CREATE2 prediction for token 104. No per-token creation hash is stored here. Predicted and undeployed.",
    }),
    artifact({
      id: "v2-wallet-129",
      label: "Predicted wallet for Chog Genesis token 129",
      hash: null,
      hashKind: "predicted address",
      address: V2_WALLET_129_PREDICTED,
      note: "CREATE2 prediction for token 129. No per-token creation hash is stored here. Predicted and undeployed.",
    }),
  ];
}

export async function artifactsWithCode(rpcUrl: string | undefined, chainId: SupportedChainId = 143): Promise<ArtifactView[]> {
  const artifacts = deploymentArtifacts();
  if (!rpcUrl) {
    return artifacts;
  }
  const codes = await readAddressCodes(
    rpcUrl,
    chainId,
    artifacts.flatMap((item) => (item.address ? [item.address] : [])),
  );
  return artifacts.map((item) => {
    if (!item.address) {
      return item;
    }
    const codeBytes = codes[item.address.toLowerCase()] ?? null;
    return { ...item, codeBytes, codeLabel: codePresenceLabel(codeBytes) };
  });
}
