import { describe, expect, it } from "vitest";
import { aiMindLabel, bankStatusLabel, constructionSites, roadsIndicator, townDevelopment, townNeedsIndicator } from "@/lib/world/civilization-status";
import type { TownNeedView, TownProjectView } from "@/lib/world/types";

function project(steps: TownProjectView["steps"]): TownProjectView {
  return {
    id: "proj-1",
    projectType: "residential",
    objectiveKey: "house-1",
    name: "East houses",
    description: "Stored project",
    status: "active",
    priority: 50,
    needType: null,
    justification: "Housing is short.",
    steps,
    currentStepId: steps[0]?.id ?? null,
    currentStepIndex: 0,
    blocker: null,
    recommendedAction: "build",
    recommendedKind: "house",
    recommendedStubId: null,
    relatedBuildingId: null,
    relatedPlotId: null,
    relatedRoadId: null,
    relatedCitizenId: null,
    evidence: {
      food: 0,
      wood: 0,
      stone: 0,
      tools: 0,
      vacantServedLots: 0,
      reservedLots: 0,
      farms: 0,
      workshops: 0,
      houses: 0,
      underConstruction: [],
      houseBeds: 0,
      pendingHouseBeds: 0,
      assignedResidents: 0,
      unassignedCitizens: 0,
      farmBatches: 0,
      workshopBatches: 0,
      placedStubIds: [],
    },
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    lastEvaluatedAt: null,
    lastEventId: null,
    lastDecisionId: null,
  };
}

function step(id: string, status: TownProjectView["steps"][number]["status"]): TownProjectView["steps"][number] {
  return {
    id,
    title: id,
    status,
    action: "build",
    buildKind: "house",
    roadStubId: null,
    plotId: null,
    buildingId: null,
    blocker: null,
    skipped: status === "skipped",
    completedAt: null,
    eventId: null,
  };
}

describe("civilization status indicators", () => {
  it("counts construction and keeps a bar only for stored progress", () => {
    const sites = constructionSites([
      { id: "hall", name: "Hall", status: "active", constructionProgress: null },
      { id: "farm", name: "North Farm", status: "under_construction", constructionProgress: 36 },
      { id: "shop", name: "Market", status: "under_construction", constructionProgress: null },
    ]);
    expect(sites.count).toBe(2);
    expect(sites.measured).toEqual([{ id: "farm", name: "North Farm", progress: 36 }]);
    expect(sites.unmeasured).toBe(1);
  });

  it("uses stored project steps and omits a percent when steps are absent", () => {
    expect(townDevelopment([], false)).toEqual({ kind: "untracked" });
    expect(townDevelopment([], true)).toEqual({ kind: "none" });
    const bare = townDevelopment([project([])], true);
    expect(bare.kind).toBe("status");
    const tracked = townDevelopment([project([step("a", "completed"), step("b", "skipped"), step("c", "eligible")])], true);
    expect(tracked).toMatchObject({ kind: "steps", completed: 2, total: 3, name: "East houses" });
  });

  it("counts open needs and built roads without inventing a percent", () => {
    expect(townNeedsIndicator([], false)).toMatchObject({ value: "Not tracked" });
    expect(townNeedsIndicator([], true)).toMatchObject({ value: "None open" });
    const need: TownNeedView = {
      needType: "food_shortage",
      status: "active",
      priority: 100,
      firstDetectedAt: null,
      lastEvaluatedAt: null,
      lastStatusChangedAt: null,
      resolvedAt: null,
      evidence: {
        food: 12,
        wood: 0,
        stone: 0,
        tools: 0,
        vacantServedLots: 0,
        reservedLots: 0,
        farms: 0,
        workshops: 0,
        houses: 0,
        underConstruction: [],
      },
      blocker: null,
      recommendedAction: "work",
      recommendedKind: "none",
      lastEventId: null,
      lastDecisionId: null,
    };
    const needs = townNeedsIndicator([need], true);
    expect(needs.value).toBe("1 open");
    expect(needs.title).toContain("Food supply is running low");
    expect(roadsIndicator([], false).value).toBe("Not tracked");
    expect(roadsIndicator([], true)).toMatchObject({ value: "None built", roadId: null });
    expect(roadsIndicator([{ id: "north-spur", name: "North spur" }], true)).toMatchObject({
      value: "1 built",
      roadId: "north-spur",
      title: "North spur",
    });
  });

  it("names the AI mind from the stored run state and the bank from the deployment check", () => {
    expect(aiMindLabel("started")).toBe("Running");
    expect(aiMindLabel("interrupted")).toBe("Interrupted");
    expect(aiMindLabel("completed_without_decisions")).toBe("No decisions");
    expect(aiMindLabel("unread")).toBe("Unread");
    expect(aiMindLabel("started")).not.toBe("Interrupted");
    expect(bankStatusLabel("live")).toBe("Verified");
    expect(bankStatusLabel("pending")).toBe("Not deployed");
    expect(bankStatusLabel("unread")).toBe("Unread");
    expect(bankStatusLabel("live")).not.toMatch(/pay|operat/i);
  });
});
