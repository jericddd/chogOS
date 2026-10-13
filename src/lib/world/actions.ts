/**
 * Phase 4 seam: how a future decision maker proposes a citizen action.
 *
 * propose -> precheck (here, advisory) -> submit as a pending world intent ->
 * world_tick validates it again with world_check_action and either applies it
 * or records the rejection reason. The database check is authoritative.
 * Phase 3 has no caller: nothing here runs an AI model or moves assets.
 */
import { worldDay, worldHour } from "@/lib/world/clock";
import type { BuildingView, CitizenView } from "@/lib/world/types";

export const WORLD_ACTIONS = ["work", "shop", "socialize", "rest", "sleep"] as const;
export type WorldAction = (typeof WORLD_ACTIONS)[number];

/** Who made the decision. `ai` is reserved for the integrated AI mind. */
export type DecisionSource = "ai" | "system";

export type ActionProposal = {
  tokenId: string;
  action: WorldAction;
  buildingId: string;
  source: DecisionSource;
  /** ai_decisions.id that explains this proposal. Required when source is ai. */
  decisionId?: string;
  /** Real-time expiry. A stale intent is marked expired instead of applied. */
  expiresAt?: string;
};

export type ActionCheck = { ok: true } | { ok: false; reason: string };

export type ResourceStock = { wood: number; stone: number };

/**
 * Same rules as world_check_action, evaluated on a public snapshot. Useful
 * to reject obviously invalid proposals before they reach the database.
 */
export function precheckAction(
  proposal: Pick<ActionProposal, "action" | "buildingId">,
  citizen: CitizenView,
  building: BuildingView | undefined,
  worldS: number,
  stock: ResourceStock,
): ActionCheck {
  const no = (reason: string): ActionCheck => ({ ok: false, reason });
  if (citizen.activity === "unavailable") {
    return no("citizen is unavailable");
  }
  if (!building) {
    return no("unknown building");
  }
  const hour = worldHour(worldS);
  switch (proposal.action) {
    case "work": {
      if (!citizen.role) {
        return no("citizen has no job");
      }
      if (citizen.workId !== building.id) {
        return no("citizen is not assigned to this building");
      }
      if (building.role !== citizen.role) {
        return no("this building does not offer that job");
      }
      if (hour < 5 || hour >= 18) {
        return no("outside working hours");
      }
      if (citizen.dayIndex === worldDay(worldS) && citizen.shiftsToday >= 2) {
        return no("two shifts already worked today");
      }
      if (citizen.role === "builder") {
        if (building.status !== "under_construction") {
          return no("nothing left to build here");
        }
        if (stock.wood < 3 || stock.stone < 2) {
          return no("not enough wood and stone in the Storehouse");
        }
      } else if (building.status !== "active") {
        return no("building is not complete");
      }
      if (citizen.role === "crafter" && stock.wood < 2) {
        return no("not enough wood in the Storehouse");
      }
      return { ok: true };
    }
    case "shop":
      if (building.kind !== "market") {
        return no("not a market");
      }
      return hour < 7 || hour >= 20 ? no("the market is closed") : { ok: true };
    case "socialize":
      if (building.kind !== "commons") {
        return no("not a public space");
      }
      return hour < 7 ? no("too early to gather") : { ok: true };
    case "rest":
    case "sleep":
      if (citizen.homeId) {
        return citizen.homeId === building.id ? { ok: true } : no("not this citizen's home");
      }
      return building.kind === "hall" ? { ok: true } : no("a citizen without a home rests at Commons Hall");
    default:
      return no("unknown action");
  }
}

export function validateProposal(proposal: ActionProposal): ActionCheck {
  if (!WORLD_ACTIONS.includes(proposal.action)) {
    return { ok: false, reason: "unknown action" };
  }
  if (!/^[0-9]{1,78}$/.test(proposal.tokenId)) {
    return { ok: false, reason: "invalid token id" };
  }
  if (!/^[a-z0-9-]{2,40}$/.test(proposal.buildingId)) {
    return { ok: false, reason: "invalid building id" };
  }
  if (proposal.source !== "ai" && proposal.source !== "system") {
    return { ok: false, reason: "invalid decision source" };
  }
  if (proposal.source === "ai" && !proposal.decisionId) {
    return { ok: false, reason: "an ai proposal must reference an ai_decisions record" };
  }
  if (proposal.expiresAt && Number.isNaN(Date.parse(proposal.expiresAt))) {
    return { ok: false, reason: "invalid expiry" };
  }
  return { ok: true };
}
