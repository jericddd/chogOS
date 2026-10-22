import type { DecisionContext } from "@/lib/ai/context";
import { worldDay } from "@/lib/world/clock";
import { civicLines } from "@/lib/world/civic";
import { GRID_H, GRID_W, REGIONS, type BuildingKind } from "@/lib/world/layout";
import { KIND_LABEL } from "@/lib/world/present";

function kindLabel(kind: string): string {
  return kind in KIND_LABEL ? KIND_LABEL[kind as BuildingKind] : kind;
}

/** What a standing place is for. Facts about this map, not a list of jobs to pick. */
const LAND_USE: Record<BuildingKind, string> = {
  house: "shelter",
  hall: "a roof for gathering",
  commons: "open ground where people meet",
  farm: "food from the fields",
  forest: "wood",
  quarry: "stone",
  workshop: "tools",
  storehouse: "the town's stock",
  market: "trade",
  park: "open leisure after 07:00",
  amusement: "open leisure after 07:00",
  bank: "a door onto the public books, which does not move money",
  jail: "a room for a sentence, with no job",
};

/**
 * A description of the town as it stands. This is what the mind reads.
 * It is not a menu of actions.
 */
export function describePlace(context: DecisionContext): string {
  const lines: string[] = [];
  lines.push(
    `The map is ${GRID_W} by ${GRID_H} tiles. The founded town is the western ground. Open country lies to the east and south. A building can stand only on a lot that already touches a road. Land the roads have not reached stays empty.`,
  );
  lines.push(REGIONS.map((region) => `${region.name}: ${region.note}`).join(" "));
  lines.push(
    "Water lies in a pond inside the founding town, in the river along that town's south edge, and in a pond on the southern ground.",
  );
  lines.push(`The clock reads day ${worldDay(context.worldS)}, about hour ${Math.floor(context.hour)}.`);
  const who = context.name?.trim() || `Citizen ${context.tokenId}`;
  lines.push(`${who}, role ${context.role ?? "unassigned"}, is at ${context.locationId ?? "no recorded place"}.`);

  if (context.standing.length === 0) {
    const counts = context.construction.counts;
    lines.push(`Known structures: ${counts.house} houses, ${counts.farm} farms, ${counts.workshop} workshops.`);
  } else {
    const groups = new Map<string, string[]>();
    for (const place of context.standing) {
      const label = place.status === "under_construction" ? `${place.name} (under construction)` : place.name;
      const list = groups.get(place.kind) ?? [];
      list.push(label);
      groups.set(place.kind, list);
    }
    const parts = [...groups.entries()].map(([kind, names]) => {
      const use = kind in LAND_USE ? LAND_USE[kind as BuildingKind] : "";
      const label = kindLabel(kind);
      return use ? `${label} (${use}): ${names.join(", ")}` : `${label}: ${names.join(", ")}`;
    });
    lines.push(`What stands: ${parts.join(". ")}.`);
  }

  const stock = context.stock;
  lines.push(`The storehouse holds food ${stock.food}, wood ${stock.wood}, stone ${stock.stone}, and tools ${stock.tools}.`);
  const needs = context.townNeeds.filter((need) => need.status === "active" || need.status === "blocked");
  if (needs.length === 0) {
    lines.push("No shortage is active.");
  } else {
    for (const need of needs) {
      lines.push(
        `Observed condition: ${need.needType.replaceAll("_", " ")} is ${need.status}.${need.blocker ? ` ${need.blocker}` : ""}`,
      );
    }
  }

  lines.push(
    `Open lots that already touch a road: ${context.construction.vacantServedLots}. Reserved land a road has not reached: ${context.construction.reservedLots}.`,
  );
  const built = context.construction.roads.completedStubIds;
  lines.push(built.length > 0 ? `Surveyed roads already built: ${built.join(", ")}.` : "No surveyed road has been built yet.");
  const unbuilt = context.construction.roads.eligibleStubs;
  if (unbuilt.length === 0) {
    lines.push("No surveyed road is waiting to be built.");
  } else {
    const bits = unbuilt.map(
      (stub) => `${stub.name}, survey label ${stub.id}, which would reach ${stub.servesPlotIds.join(", ")}`,
    );
    lines.push(`Surveyed roads not built yet: ${bits.join("; ")}.`);
  }
  if (context.construction.underConstruction.length > 0) {
    lines.push(
      `Already underway: ${context.construction.underConstruction.map((site) => `${site.name} (${site.kind})`).join(", ")}.`,
    );
  }

  if (context.townProjects.length === 0) {
    lines.push("No town project is open.");
  } else {
    for (const project of context.townProjects) {
      const step = project.steps.find((item) => item.id === project.currentStepId);
      lines.push(
        `Open town work "${project.name}" is ${project.status}. ${project.justification}${step ? ` Current step: ${step.title}.` : ""}${project.blocker ? ` Blocked: ${project.blocker}.` : ""}`,
      );
    }
  }
  if (context.memories.length > 0) {
    lines.push(`Remembered: ${context.memories.map((memory) => memory.content).join(" ")}`);
  }
  if (context.goals.length > 0) {
    lines.push(`Goals still open: ${context.goals.map((goal) => goal.title).join("; ")}.`);
  }
  lines.push(...civicLines(context.civic));
  const traits = context.personality;
  lines.push(
    `Temperament, on a 0–100 scale: curiosity ${traits.curiosity}, planning ${traits.planning}, caution ${traits.caution}, industriousness ${traits.industriousness}, resourcefulness ${traits.resourcefulness}, sociability ${traits.sociability}, cooperation ${traits.cooperation}.`,
  );
  return lines.join("\n");
}
