import type { Address } from "viem";

export type CitizenOrigin = "founding_treasury" | "community";
export type EnrollmentStatus = "pending" | "active" | "suspended" | "withdrawn";
export type MetadataStatus = "missing" | "fetched" | "unavailable";
export type RosterVerification = "verified" | "stale";

export type CitizenRecord = {
  id: string;
  chainId: 143 | 10143;
  nftContract: Address;
  tokenId: string;
  origin: CitizenOrigin;
  foundingMembershipActive: boolean;
  enrollmentStatus: EnrollmentStatus;
  observedOwner: Address | null;
  ownershipObservedBlock: string | null;
  ownershipObservedAt: string | null;
  enrolledAt: string | null;
  metadataName: string | null;
  metadataDescription: string | null;
  metadataImage: string | null;
  metadataStatus: MetadataStatus;
  rosterVerification: RosterVerification | null;
};

export type CivilizationEvent = {
  id: string;
  occurredAt: string;
  kind: string;
  summary: string;
  citizenId: string | null;
  tokenId: string | null;
  chainStatus: "offchain" | "submitted" | "confirmed";
  dedupeKey: string | null;
};

export type Holding = {
  tokenId: string;
  owner: Address;
};

export type Recheck =
  | { tokenId: string; status: "owner"; owner: Address }
  | { tokenId: string; status: "failed"; reason: string };

export type NewEvent = {
  dedupeKey: string;
  kind: string;
  summary: string;
  tokenId: string;
  chainId: 143 | 10143;
  citizenId: string | null;
  payload: Record<string, string>;
};

export type SyncPlan = {
  creates: CitizenRecord[];
  updates: Array<{ id: string; patch: Partial<CitizenRecord> }>;
  events: NewEvent[];
  warnings: string[];
};
