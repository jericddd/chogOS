import type { AiRunState } from "@/lib/ai/run-record";
import { activeTownNeeds, describeTownNeedsBanner } from "@/lib/world/needs";
import { openTownProjects } from "@/lib/world/projects";
import { describeRoadsBanner } from "@/lib/world/roads";
import type { BuildingView, RoadOverlayView, TownNeedView, TownProjectView } from "@/lib/world/types";

export type MeasuredConstruction = {
  id: string;
  name: string;
  progress: number;
};

/** Active construction from stored building rows. A missing progress stays missing. */
export function constructionSites(
  buildings: readonly Pick<BuildingView, "id" | "name" | "status" | "constructionProgress">[],
): { count: number; measured: MeasuredConstruction[]; unmeasured: number } {
  const active = buildings.filter((building) => building.status === "under_construction");
  const measured: MeasuredConstruction[] = [];
  let unmeasured = 0;
  for (const building of active) {
    if (typeof building.constructionProgress === "number" && Number.isFinite(building.constructionProgress)) {
      measured.push({ id: building.id, name: building.name, progress: building.constructionProgress });
    } else {
      unmeasured += 1;
    }
  }
  return { count: active.length, measured, unmeasured };
}

export type TownDevelopment =
  | { kind: "untracked" }
  | { kind: "none" }
  | { kind: "status"; projectId: string; name: string; status: string; open: number }
  | { kind: "steps"; projectId: string; name: string; status: string; open: number; completed: number; total: number };

/**
 * Town development from persisted project steps.
 * The fraction is completed or skipped steps over stored steps. No steps means a status, not a percent.
 */
export function townDevelopment(projects: readonly TownProjectView[], ready: boolean): TownDevelopment {
  if (!ready) return { kind: "untracked" };
  const open = openTownProjects(projects);
  if (open.length === 0) return { kind: "none" };
  const top = open[0]!;
  const total = top.steps.length;
  if (total === 0) {
    return { kind: "status", projectId: top.id, name: top.name, status: top.status, open: open.length };
  }
  const completed = top.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
  return {
    kind: "steps",
    projectId: top.id,
    name: top.name,
    status: top.status,
    open: open.length,
    completed,
    total,
  };
}

/** Open town needs as a count. The title is the stored banner, not a made-up percent. */
export function townNeedsIndicator(
  needs: readonly TownNeedView[],
  ready: boolean,
): { value: string; title: string } {
  const banner = describeTownNeedsBanner(needs, ready);
  if (!ready) return { value: "Not tracked", title: banner.detail };
  const open = activeTownNeeds(needs);
  if (open.length === 0) return { value: "None open", title: banner.detail };
  return { value: `${open.length} open`, title: `${banner.title}. ${banner.detail}` };
}

/** Constructed road spurs as a count. A road overlay has no stored percent. */
export function roadsIndicator(
  roads: readonly Pick<RoadOverlayView, "id" | "name">[],
  ready: boolean,
): { value: string; title: string; roadId: string | null } {
  const banner = describeRoadsBanner(roads, ready);
  if (!ready) return { value: "Not tracked", title: banner.detail, roadId: null };
  if (roads.length === 0) return { value: "None built", title: banner.detail, roadId: null };
  return { value: `${roads.length} built`, title: banner.detail, roadId: roads[0]?.id ?? null };
}

/** Short AI mind label. "Running" is only the stored started state. */
export function aiMindLabel(state: AiRunState): string {
  switch (state) {
    case "started":
      return "Running";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    case "halted":
      return "Halted";
    case "completed_with_proposals":
      return "Proposals stored";
    case "completed_without_decisions":
      return "No decisions";
    case "noted":
      return "Noted";
    case "not_recorded":
      return "No run";
    case "unconfigured":
      return "Not connected";
    default:
      return "Unread";
  }
}

export type BankDeploymentState = "pending" | "rejected" | "unreadable" | "live";

/** ChogBank label from the public deployment check. A verified contract is not described as paying. */
export function bankStatusLabel(state: BankDeploymentState | "loading" | "unread"): string {
  switch (state) {
    case "live":
      return "Verified";
    case "pending":
      return "Not deployed";
    case "rejected":
      return "Rejected";
    case "unreadable":
      return "Unreadable";
    case "loading":
      return "Reading";
    default:
      return "Unread";
  }
}
