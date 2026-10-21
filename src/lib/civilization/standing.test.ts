import { describe, expect, it } from "vitest";
import {
  socialDetail,
  standingBand,
  summarizeStanding,
  wealthDetail,
  type StandingSourceEvent,
} from "@/lib/civilization/standing-summary";

function met(partial: Partial<StandingSourceEvent> & Pick<StandingSourceEvent, "side" | "occurredAt">): StandingSourceEvent {
  return {
    kind: "social.met",
    actorTokenId: "1",
    relatedTokenId: "2",
    buildingName: "Commons Square",
    foodTaken: 0,
    ...partial,
  };
}

describe("citizen standing from recorded events", () => {
  it("stays empty when no meeting names another citizen", () => {
    const summary = summarizeStanding([
      {
        kind: "citizen.market_visit",
        side: "actor",
        occurredAt: "2026-10-20T00:00:00.000Z",
        actorTokenId: "7",
        relatedTokenId: null,
        buildingName: "Market",
        foodTaken: 1,
      },
    ]);
    expect(summary.band).toBe("none");
    expect(summary.meetings).toBe(0);
    expect(summary.relationships).toEqual([]);
    expect(summary.rationsDrawn).toBe(1);
    expect(socialDetail(summary)).toBe("No meeting with another citizen is recorded.");
    expect(wealthDetail(1)).toContain("Drew 1 food ration");
    expect(wealthDetail(1)).toContain("not a balance still held");
  });

  it("counts both sides of a meeting as one acquaintance", () => {
    const summary = summarizeStanding([
      met({ side: "actor", occurredAt: "2026-10-20T01:00:00.000Z", actorTokenId: "7", relatedTokenId: "14" }),
      met({
        side: "related",
        occurredAt: "2026-10-21T01:00:00.000Z",
        actorTokenId: "14",
        relatedTokenId: "7",
        buildingName: "Commons Hall",
      }),
      met({ side: "actor", occurredAt: "2026-10-19T01:00:00.000Z", actorTokenId: "7", relatedTokenId: null }),
    ]);
    expect(standingBand(summary.acquaintances)).toBe("acquainted");
    expect(summary.meetings).toBe(2);
    expect(summary.relationships).toEqual([
      { tokenId: "14", meetings: 2, lastMetAt: "2026-10-21T01:00:00.000Z", place: "Commons Hall" },
    ]);
    expect(socialDetail(summary)).toBe("Met 1 citizen in 2 recorded meetings.");
  });

  it("uses the acquaintance count for the status band", () => {
    expect(standingBand(0)).toBe("none");
    expect(standingBand(2)).toBe("acquainted");
    expect(standingBand(3)).toBe("familiar");
    expect(standingBand(9)).toBe("familiar");
    expect(standingBand(10)).toBe("known");
    const partners = Array.from({ length: 10 }, (_, index) =>
      met({
        side: "actor",
        occurredAt: `2026-10-20T00:0${index % 6}:00.000Z`,
        relatedTokenId: String(index + 2),
      }),
    );
    const summary = summarizeStanding(partners);
    expect(summary.label).toBe("Known");
    expect(summary.relationships[0]?.meetings).toBe(1);
    expect(wealthDetail(0)).toContain("No food ration has been drawn");
    expect(wealthDetail(0)).toContain("Storehouse");
  });
});
