import type { Address } from "viem";
import { compareTokenIds } from "@/lib/blockchain/holdings";
import { citizenDesignation } from "@/lib/civilization/labels";
import { sameAddress } from "@/lib/civilization/token-id";
import type { CitizenRecord } from "@/lib/civilization/types";

export type DisplayCitizen = {
  tokenId: string;
  citizenId: string | null;
  designation: string;
  owner: string | null;
  verification: "verified" | "stale" | "unpersisted" | "departed" | "community" | "needs_recheck" | "enrolled";
  enrollmentStatus: string;
  metadataName: string | null;
  metadataImage: string | null;
  metadataStatus: CitizenRecord["metadataStatus"] | "missing";
};

export function mergeCitizensForDisplay(input: {
  liveTokenIds: string[] | null;
  treasury: Address;
  citizens: CitizenRecord[];
  chainId: 143 | 10143;
  nftContract: Address;
}): DisplayCitizen[] {
  const relevant = input.citizens.filter(
    (citizen) => citizen.chainId === input.chainId && sameAddress(citizen.nftContract, input.nftContract),
  );
  const byToken = new Map(relevant.map((citizen) => [citizen.tokenId, citizen]));
  const ids = new Set<string>(relevant.map((citizen) => citizen.tokenId));
  for (const tokenId of input.liveTokenIds ?? []) {
    ids.add(tokenId);
  }

  return [...ids].sort(compareTokenIds).map((tokenId) => {
    const citizen = byToken.get(tokenId) ?? null;
    const live = input.liveTokenIds?.includes(tokenId) ?? false;
    if (!citizen) {
      return {
        tokenId,
        citizenId: null,
        designation: "Founding citizen",
        owner: input.treasury,
        verification: "unpersisted",
        enrollmentStatus: "Verified holding, record not persisted",
        metadataName: null,
        metadataImage: null,
        metadataStatus: "missing",
      };
    }

    let verification: DisplayCitizen["verification"];
    if (citizen.enrollmentStatus !== "active") {
      verification = "departed";
    } else if (live) {
      verification = "verified";
    } else if (citizen.rosterVerification === "stale") {
      verification = "stale";
    } else if (input.liveTokenIds === null) {
      verification = citizen.origin === "community" && !citizen.foundingMembershipActive ? "community" : "needs_recheck";
    } else if (citizen.origin === "founding_treasury") {
      verification = "enrolled";
    } else if (citizen.foundingMembershipActive) {
      verification = "needs_recheck";
    } else {
      verification = "community";
    }

    const owner = live ? input.treasury : citizen.observedOwner;
    return {
      tokenId,
      citizenId: citizen.id,
      designation: citizenDesignation(
        live
          ? { origin: citizen.origin, foundingMembershipActive: true }
          : citizen,
      ),
      owner,
      verification,
      enrollmentStatus: citizen.enrollmentStatus,
      metadataName: citizen.metadataName,
      metadataImage: citizen.metadataImage,
      metadataStatus: citizen.metadataStatus,
    };
  });
}
