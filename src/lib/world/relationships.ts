/**
 * Relationship stage is derived from repeated meetings and both citizens'
 * traits. One meeting never starts a date. Dating requires both people to
 * have initiated a meeting, enough familiarity, and mutual interest.
 * It does not grant a wallet, a payout, or any onchain authority.
 */

export const INTEREST_SOCIABILITY = 55;
export const INTEREST_COOPERATION = 40;
export const FAMILIAR_MEETINGS = 3;
export const INTERESTED_MEETINGS = 5;
export const DATING_MEETINGS = 6;

export type BondStage = "met" | "familiar" | "interested" | "dating";

export type BondInput = {
  meetings: number;
  actorSociability: number;
  partnerSociability: number;
  actorCooperation: number;
  partnerCooperation: number;
  /** True when this citizen has been the actor on at least one stored meeting. */
  actorInitiated: boolean;
  partnerInitiated: boolean;
  /** True when either citizen already has a dating bond with someone else. */
  eitherDatingElsewhere: boolean;
};

export type BondProgress = {
  stage: BondStage;
  dating: boolean;
  reason: string;
};

export function showsInterest(sociability: number, cooperation: number): boolean {
  return sociability >= INTEREST_SOCIABILITY && cooperation >= INTEREST_COOPERATION;
}

export function progressBond(input: BondInput): BondProgress {
  const meetings = Math.max(0, Math.floor(input.meetings));
  if (meetings < 1) {
    return { stage: "met", dating: false, reason: "No meeting is stored." };
  }
  const mutualTraits = showsInterest(input.actorSociability, input.actorCooperation) && showsInterest(input.partnerSociability, input.partnerCooperation);
  const mutualInitiation = input.actorInitiated && input.partnerInitiated;
  if (
    meetings >= DATING_MEETINGS &&
    mutualTraits &&
    mutualInitiation &&
    !input.eitherDatingElsewhere
  ) {
    return {
      stage: "dating",
      dating: true,
      reason: "Repeated meetings, mutual initiation, and mutual interest support dating. This is not a wallet or a payment.",
    };
  }
  if (meetings >= INTERESTED_MEETINGS && mutualTraits && mutualInitiation) {
    const reason = input.eitherDatingElsewhere
      ? "Both are interested, and one already has a dating bond."
      : "Both have initiated meetings and both show interest. Another meeting can become dating.";
    return { stage: "interested", dating: false, reason };
  }
  if (meetings >= FAMILIAR_MEETINGS) {
    const reason = mutualTraits
      ? "They have met enough times to be familiar. Dating still needs both of them to initiate a meeting."
      : "They are familiar. Dating stays closed because interest is not mutual.";
    return { stage: "familiar", dating: false, reason };
  }
  return {
    stage: "met",
    dating: false,
    reason: "One or two meetings are acquaintanceship, not a date.",
  };
}
