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

The mind sees storehouse stock, building counts, open sites, and vacant served lots. `buildKind` must be `house`, `farm`, or `workshop`. Missing or unknown kinds, including `road`, are rejected. Extra JSON fields such as coordinates are dropped.

## 5b — Roads (not this slice)

Runtime `world_roads` overlay. An AI/system `build` + `road` places a short segment from a catalog of stubs (not free-draw). `world_plots.served` flips true when a door would touch the new asphalt. That is how the reserved east y=2 lots and true forest lots unlock.

## 5c — Planner pressure (not this slice)

A town-level goal (“food below 40”) so more than one citizen does not all socialize while the storehouse is empty. Phase 5a only passes stock and a suggested kind; it does not force every citizen to build.

## What this is not

Not a real-world sandbox. Not weather, war, marriage, or markets with token balances. Not a chatbot writing events that never hit `world_buildings`. Growth means **another building on the canvas** and **another job**, hashed like every other event.

## Operator

After merge, paste `supabase/migrations/20261015200000_phase5a_civil_works.sql` into the hosted SQL editor (same way as Phase 4). Then deploy the app. Do not rerun `verify_cutover`. Do not reset the clock. This file is **not** applied to hosted Supabase merely by existing in git.
