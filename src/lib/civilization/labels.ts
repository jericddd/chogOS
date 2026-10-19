import type { CitizenRecord } from "@/lib/civilization/types";

export function foundingCountLabel(
  verified: number | null,
  expected: number,
  discrepancy: string | null,
): string {
  if (verified === null) {
    return "Treasury verification is unavailable. No founding count is shown until ownerOf succeeds.";
  }
  const base = `${verified} Chog NFTs verified in ChogTreasury.`;
  if (verified === expected && !discrepancy) {
    return base;
  }
  return discrepancy ? `${base} ${discrepancy}` : base;
}

export function citizenDesignation(citizen: Pick<CitizenRecord, "origin" | "foundingMembershipActive">): string {
  if (citizen.origin === "founding_treasury") {
    return "Founding citizen";
  }
  if (citizen.foundingMembershipActive) {
    return "Community citizen · currently held by ChogTreasury";
  }
  return "Community citizen";
}

export function verificationLabel(status: string): string {
  switch (status) {
    case "verified":
      return "Verified on this chain read";
    case "stale":
      return "Stale. The last recheck failed, so membership was left unchanged.";
    case "unpersisted":
      return "Verified holding. The citizen record is not in the database yet.";
    case "departed":
      return "Enrollment is not active. The stored citizen record was not removed.";
    case "enrolled":
      return "Permanent citizen. This NFT is not in the latest ChogTreasury holdings. The stored address is the last observed owner.";
    case "community":
      return "Community citizen. Stored owner is a snapshot until the next protected action.";
    case "needs_recheck":
      return "Stored record. This treasury membership was not confirmed by the latest chain read.";
    default:
      return status;
  }
}

export function shortAddress(value: string): string {
  if (value.length < 12) {
    return value;
  }
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function formatUtc(iso: string | null): string {
  if (!iso) {
    return "Not recorded";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "Not recorded";
  }
  return `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}
