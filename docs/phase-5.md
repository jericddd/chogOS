> **Not the live record.** Deployed addresses and what the app does today are in [README.md](../README.md). This file is a phase journal. A present-tense sentence about deployment describes the day it was written.

# Phase 5 — Civil works (growth the map can show)

Phase 4 made the mind real. It did not make the town grow. Citizens still only picked work / rest / shop / socialize / one house on a pre-surveyed lot. The forest is scenery.

Phase 5 adds **legal verbs** so progress is visible. The AI still cannot invent coordinates or spend money. `world_tick()` still executes.

## Rule

The model never writes the map. It chooses `action=build` and a **kind**. The server picks a vacant, road-served plot, a door on that road, and a complete route table. Same seam as Phase 4 houses.

## 5a — Kinds on existing lots (this slice)

Allow `house | farm | workshop` on genesis-v1.1 surveyed plots that already touch a road. Eleven extra lots sit on roads that already exist (east at y=11: x=80, 84, 92, 96, 100; south at y=57: x=53, 57, 61, 65, 69, 73). East y=2 lots stay reserved.

During construction the workers are builders. A builder shift still uses 3 wood and 2 stone and adds 4%. The AI cannot mark a building complete.

When the site reaches 100%:

- a **house** becomes a home (capacity 4, residents assigned from homeless citizens in token order)
- a **farm** becomes a farmer workplace (4 job slots, `batch_shifts = 3`, 15 food per completed batch, same as North Farm / Riverside Farm)
- a **workshop** becomes a crafter workplace (4 job slots, `batch_shifts = 3`, 4 tools per batch, 2 wood per crafter shift)

Food is not awarded because a farm was built. Tools are not awarded because a workshop was built.

The mind sees storehouse stock, building counts, open sites, and vacant served lots. Extra JSON fields such as coordinates are dropped.

## 5b — Roads (this slice)

Runtime overlay table `world_roads`. The model may send `action=build`, `buildKind=road`, and `roadStubId` equal to a catalog id. It never supplies tiles or coordinates. `world_place_road` revalidates the catalog geometry, consumes 3 wood and 2 stone once, writes the overlay, and `world_refresh_plot_service` marks a plot served only when a real road tile is cardinally adjacent to its footprint.

Six catalog stubs (`east-y2-64` through `east-y2-84`) bridge the connected east `y=10` highway to the reserved lots at `y=2`. Each spur lays tiles at `y=9,8` (to join town) and `y=6,5` (to reach the lot), using the existing `y=7` strip in between. Placing `east-y2-64` serves `plot-64-2` and leaves the other five reserved until their own stubs are placed. Overlay tiles merge into the existing TypeScript pathfinder (`pathAcross` / `walkableOn`). Placement is atomic: there is no partial traversable road. A stub is rejected unless every tile is reachable from the founding road network.

`road` is not a Phase 5a construct kind. Houses, farms, and workshops still use `world_place_building` on vacant served lots. Newly served lots become eligible for that path. Town needs (Phase 5c) are unchanged.

## 5d — Strategic projects (this slice)

Runtime table `town_projects`. After each tick, `world_advance_town_projects` reads Storehouse stock, town needs, plots, roads, buildings, and house assignments. It may create at most two open projects and advances steps only from those facts. The model receives eligible next actions (`projectId`, `buildKind`, `roadStubId`) and may choose one. It cannot set project status, skip a road, or declare production complete.

Project types in this slice:

| Type | Activates | Completes |
| --- | --- | --- |
| `food_production` | Food shortage is actually open | Recovered food, or a new farm's first production batch if one was started |
| `tool_production` | Tool shortage is actually open | Recovered tools, or a new workshop's first production batch if one was started |
| `residential` | Citizens without a house assignment exceed unfinished house beds | The new house is actually complete |
| `territorial` | Reserved lots remain and a catalog stub is unused | That stub is in `world_roads` and its plot is `served` |

A healthy town does not invent a food emergency. It may still open a territorial project. Commons Hall remains a valid shelter; unassigned is not labeled homeless. A queued intent, an AI proposal, or a model sentence does not complete a step. `road` / `house` / `farm` / `workshop` still go through the existing placement RPCs. Town needs still resolve only on recovered stock.

## 5c — Town needs (this slice)

The engine, not the model, decides whether a shortage exists. `world_evaluate_town_needs()` runs after each `world_tick()` from Storehouse stock and layout facts. One row per need type lives in `town_needs`. Repeating the same stock does not insert another row or another event.

Needs in this slice:

| Need | Activates | Recovers | Why that recovery |
| --- | --- | --- | --- |
| `food_shortage` | food &lt; 40 | food ≥ 80 | Genesis initial food; twice the activate line; under the 400 cap |
| `tools_shortage` | tools &lt; 4 | tools ≥ 12 | Three workshop batches of 4 tools |
| `materials_shortage` | wood &lt; 3 or stone &lt; 2 | wood ≥ 15 and stone ≥ 10 | Cannot pay one builder shift (3 wood, 2 stone); recovery is five shifts so one gather batch does not flap the flag |

A need stays active in the band between those lines (hysteresis). It does **not** resolve because an AI proposal was queued, an intent is pending, or a farm/workshop finished. Food and tools move only through the existing production rules.

When a need is active and a relevant feasible action exists, ranking prefers that action over an ordinary social visit. Assigned workers keep their jobs so every citizen does not pile onto one site. Off-shift and unemployed citizens may take `build` when a farm or workshop would address the need and a vacant served lot plus materials exist. `world_check_action` / `precheckAction` still gate every intent. Road stubs are a separate catalog action, not a shortage type.

Detection events are `source=system`, kinds `town.need_detected`, `town.need_blocked`, and `town.need_resolved`. They use the ordinary `world_record_event` path and the Phase 3.75 hash trigger. They are not labeled `ai`.

The public inspector shows the persisted rows. If the table has not been applied, it says so instead of inventing a shortage or a clean bill of health.

## What this is not

Not a real-world sandbox. Not weather, war, marriage, or markets with token balances. Not a chatbot writing events that never hit `world_buildings`. Growth means **another building on the canvas** and **another job**, hashed like every other event.

## Operator

After merge, paste each new migration into the hosted SQL editor (same way as Phase 4). Do not rerun `verify_cutover`. Do not reset the clock. Files in git are **not** applied to hosted Supabase merely by existing in the repo.

- Phase 5a: `supabase/migrations/20261015200000_phase5a_civil_works.sql`
- Phase 5c: `supabase/migrations/20261015220000_phase5c_town_needs.sql`
- Phase 5b: `supabase/migrations/20261016200000_phase5b_roads.sql`
- Phase 5d: `supabase/migrations/20261016220000_phase5d_town_projects.sql`

Phase 5d SQL is **not** applied to hosted Supabase by this pull request. Paste it after review. Do not rerun `world:init` or `verify_cutover`.

The GitHub Actions 30-minute mind poke is unchanged.
