import { describe, expect, it } from "vitest";
import { acceptGrowth } from "@/lib/ai/growth";
import { buildDecisionContext } from "@/lib/ai/context";
import { parseDecisionOutput } from "@/lib/ai/schema";
import type { PersonalityTraits } from "@/lib/ai/personality";
import {
  civicMenu,
  closedCivic,
  hostileFromRecord,
  menuOpen,
  proposesOffense,
  readCivicFacts,
  skipsMarkedMeeting,
} from "@/lib/world/civic";
import type { BuildingView, CitizenView } from "@/lib/world/types";

const traits: PersonalityTraits = {
  sociability: 40,
  curiosity: 40,
  industriousness: 40,
  cooperation: 20,
  caution: 20,
  planning: 40,
  resourcefulness: 80,
  preferredActivity: "work",
};

function citizen(): CitizenView {
  return {
    tokenId: "7",
    name: "Chog #7",
    origin: "founding",
    activity: "idle",
    role: "farmer",
    locationId: "commons-square",
    destinationId: null,
    originId: null,
    purpose: null,
    homeId: "house-01",
    workId: "north-farm",
    dayIndex: 1,
    shiftsToday: 0,
    worldStartedS: 0,
    worldEndsS: null,
    startedAt: "2026-10-13T00:00:00Z",
    endsAt: null,
    decisionSource: "simulation",
    updatedTick: 1,
  };
}

function bank(): BuildingView {
  return {
    id: "chog-bank",
    kind: "bank",
    name: "ChogBank",
    x: 80,
    y: 11,
    w: 3,
    h: 3,
    doorX: 81,
    doorY: 11,
    status: "active",
    role: null,
    capacity: null,
    jobSlots: null,
    openAir: false,
    constructionProgress: null,
    stock: {},
    batchShifts: null,
    productionProgress: 0,
    batchesCompleted: 0,
    completedAt: null,
    updatedTick: 1,
  };
}

describe("civic menu", () => {
  it("keeps every civic act closed until the record exists", () => {
    const dayOne = closedCivic(80);
    expect(menuOpen(civicMenu(dayOne))).toBe(false);
    expect(civicMenu(dayOne).proclaim).toBe(false);
    expect(civicMenu({ ...dayOne, bankId: "chog-bank" }).visit).toBe(true);
    expect(civicMenu({ ...dayOne, shortageActive: true }).proclaim).toBe(true);
    expect(civicMenu({ ...dayOne, repeatedBreach: true, breachCount: 2 }).proclaim).toBe(true);
    const fined = civicMenu({
      ...dayOne,
      breachCount: 1,
      laws: [{ code: "ration_fine", status: "proclaimed" }],
    });
    expect(fined.levy).toBe(true);
    expect(fined.raiseJail).toBe(false);
    const unpaid = civicMenu({
      ...dayOne,
      breachCount: 1,
      unpaidFine: true,
      laws: [{ code: "ration_fine", status: "proclaimed" }],
    });
    expect(unpaid.raiseJail).toBe(true);
    expect(unpaid.detain).toBe(false);
    const room = civicMenu({
      ...dayOne,
      breachCount: 1,
      unpaidFine: true,
      jailId: "jail-01",
      jailCapacity: 4,
      laws: [{ code: "ration_fine", status: "proclaimed" }],
    });
    expect(room.detain).toBe(true);
    expect(room.raiseJail).toBe(false);
    expect(civicMenu({ ...dayOne, hostileCount: 1 }).watch).toBe(true);
    expect(
      civicMenu({
        ...dayOne,
        food: 12,
        detainedFarmers: 2,
        laws: [{ code: "ration_fine", status: "proclaimed" }],
      }).amend,
    ).toBe(true);
  });

  it("derives hostility from stored conduct and lets it fade", () => {
    expect(proposesOffense(traits)).toBe(true);
    expect(proposesOffense({ ...traits, caution: 60 })).toBe(false);
    expect(skipsMarkedMeeting(60)).toBe(true);
    expect(skipsMarkedMeeting(59)).toBe(false);
    expect(hostileFromRecord({ breaches: 1, releasedWorldS: null, latestBreachWorldS: 10, worldS: 10 })).toBe(false);
    expect(hostileFromRecord({ breaches: 2, releasedWorldS: null, latestBreachWorldS: 10, worldS: 10 })).toBe(true);
    const released = 20_000;
    expect(
      hostileFromRecord({ breaches: 2, releasedWorldS: released, latestBreachWorldS: 10, worldS: released + 86_400 }),
    ).toBe(true);
    expect(
      hostileFromRecord({
        breaches: 2,
        releasedWorldS: released,
        latestBreachWorldS: 10,
        worldS: released + 3 * 86_400,
      }),
    ).toBe(false);
    expect(
      hostileFromRecord({
        breaches: 3,
        releasedWorldS: released,
        latestBreachWorldS: released + 10,
        worldS: released + 4 * 86_400,
      }),
    ).toBe(true);
  });

  it("reads a snapshot and refuses a law the record does not hold", () => {
    const facts = readCivicFacts({
      bankId: "chog-bank",
      jailId: null,
      breachCount: "2",
      shortageActive: false,
      unpaidFine: false,
      food: 12,
      breachTokens: ["91", "nope"],
      laws: [{ code: "ration_fine", status: "proclaimed" }, { code: "be_evil", status: "proclaimed" }],
    });
    expect(facts).toMatchObject({
      bankId: "chog-bank",
      breachCount: 2,
      repeatedBreach: true,
      breachTokens: ["91"],
      laws: [{ code: "ration_fine", status: "proclaimed" }],
    });
    expect(readCivicFacts(null)).toBeNull();

    const open = buildDecisionContext({
      citizenId: "11111111-1111-4111-8111-111111111111",
      citizen: citizen(),
      buildings: [bank()],
      worldS: 12 * 3600,
      stock: { wood: 60, stone: 40, food: 80, tools: 20 },
      personality: traits,
      skills: [],
      goals: [],
      memories: [],
      canBuild: true,
      vacantServedLots: 8,
      canBuildKinds: ["park", "amusement"],
      civic: { ...closedCivic(80), bankId: "chog-bank" },
    });
    const park = parseDecisionOutput(
      JSON.stringify({
        action: "build",
        buildKind: "park",
        placeName: "South Lantern",
        summary: "Raise a park on open road-connected land.",
        rationale: "People already gather after 07:00 and the lots are empty.",
      }),
    );
    expect(park.ok).toBe(true);
    if (park.ok) {
      const accepted = acceptGrowth(park.decision, open);
      expect(accepted.ok).toBe(true);
      if (accepted.ok) {
        expect(accepted.decision.placeName).toBe("South Lantern");
      }
    }
    const visit = parseDecisionOutput(
      JSON.stringify({
        action: "visit",
        summary: "Read the public books.",
        rationale: "The bank door is already on the map.",
      }),
    );
    expect(visit.ok).toBe(true);
    if (visit.ok) {
      const accepted = acceptGrowth(visit.decision, open);
      expect(accepted.ok).toBe(true);
      if (accepted.ok) {
        expect(accepted.decision.buildingId).toBe("chog-bank");
      }
    }
    const statute = parseDecisionOutput(
      JSON.stringify({
        action: "proclaim",
        lawCode: "ration_fine",
        summary: "Proclaim a fine.",
        rationale: "A shortage has stayed active.",
      }),
    );
    expect(statute.ok).toBe(true);
    if (statute.ok) {
      expect(acceptGrowth(statute.decision, open).ok).toBe(false);
    }
    const evil = parseDecisionOutput(
      JSON.stringify({
        action: "proclaim",
        lawCode: "be_evil",
        summary: "Be evil.",
        rationale: "Freeform text.",
      }),
    );
    expect(evil.ok).toBe(true);
    if (evil.ok) {
      expect(evil.decision.lawCode).toBeNull();
      expect(acceptGrowth(evil.decision, open).ok).toBe(false);
    }
  });
});
