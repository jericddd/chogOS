> **Not the live record.** Deployed addresses and what the app does today are in [README.md](../README.md). This file is a phase journal. A present-tense sentence about deployment describes the day it was written.

# Phase 3: the living civilization

The home page is now a persistent 2D pixel-art world. Every eligible existing citizen has a home, a job, a current activity, and a history. One simulation runs inside the database, so the world moves whether or not anyone is watching. Visitors observe and inspect. They cannot steer citizens, and no public route writes world state.

## What is real, simulated, placeholder, or still needs configuration

| Item | Status |
| --- | --- |
| Citizens | Real. The existing `citizens` rows. No citizen is created by the world. Active founding citizens and active community citizens on the configured chain and contract are placed. |
| Buildings, roads, homes, jobs | Simulated, persistent. Layout `genesis-v1.1` is 120×80 tiles. The founding town stays on its original `genesis-v1` tiles. |
| Activities, movement, shifts | Simulated by fixed rules (`source = simulation`). Not AI decisions. |
| Food, wood, stone, tools | Simulated counts from 0 to 400 in the Storehouse. Not tokens, not balances. |
| Construction of houses 13 to 15 | Simulated. Builders consume simulated wood and stone. |
| Membership history from Phase 1 | Real, relabeled `source = system`, `category = membership`. |
| AI events | The hosted world now stores `source=ai` decisions. This journal was written before that. Rule-based activity stays `simulation`. See [README.md](../README.md) and [phase-4.md](phase-4.md). |
| Onchain events | Confirmed Chog Genesis transfers recorded by the watcher. The simulation itself still sends no transactions. |
| Scheduler | Needs the migration. `pg_cron` runs `world_tick()` every 5 seconds, or every minute if sub-minute schedules are unsupported. |
| Browser realtime | Needs `SUPABASE_ANON_KEY`. Without it the browser polls every 4 seconds. |

## Setup

1. Apply `supabase/migrations/20261013040000_phase3_world.sql` in the Supabase SQL editor. It is additive. It adds five tables, adds columns and indexes to `civilization_events`, creates the `world_*` functions, and schedules the tick.
2. Found the world once from a trusted machine with the service role key:

   ```bash
   npm run world:init
   ```

   A second run returns `already_initialized` and then attaches the current layout if the stored town is an older compatible version. `npm run world:expand` only runs that upgrade. It does not move buildings or reset citizens.
3. Check it:

   ```bash
   npm run world:admin -- status
   ```

   `scheduler.job` shows the `pg_cron` job. If it says `none`, enable `pg_cron` under Database, Extensions in the Supabase dashboard, then run the two `do $$ ... $$` blocks at the end of the migration again. Until then, `npm run world:runner` ticks from any trusted machine.
4. Optional: set `SUPABASE_ANON_KEY` so browsers receive realtime nudges. The anon key is public by design and has no table grants; it can only join the broadcast channel.

Verification of history (hashes, Merkle batches, the EventAnchor contract) is Phase 3.75. It is documented in [phase-3.75.md](phase-3.75.md) and is not applied on hosted until that SQL file is pasted.

Operator commands, all recorded as system events:

```bash
npm run world:expand                   # genesis-v1 → genesis-v1.1 map, same town
npm run world:admin -- speed calm      # or demo, or a number from 1 to 1000
npm run world:admin -- pause
npm run world:admin -- resume
```

## Map (genesis-v1.1)

The observable world is 120×80 tiles (1920×1280 px), four times the original 60×40 area. The founding settlement remains at tiles (0,0)–(60,40). New land lies to the east and south: reserved lots, meadows, woods, and roads that join the old network at its rim so founding walk times do not change.

Undeveloped lots are not buildings. `world_regions` names four quadrants for later districts. `world_expand_layout` is idempotent. A truthful `world.expanded` system event is recorded once. Citizen construction events are not invented for the new land.

The default camera still frames the founding town. Zoom out or pan to see the rest of the map.

Apply `supabase/migrations/20261013120000_phase35_map.sql`, then `npm run world:expand`, then deploy the frontend that draws 120×80. The SQL file alone does not expand an already-founded world.

`POST /api/world/tick` is an optional HTTP runner. It stays closed (403) until `WORLD_RUNNER_SECRET` is set and then requires `Authorization: Bearer <secret>`. It can only call `world_tick()`.

## Time

World time and real time are stored separately. `world_state` holds an anchor:

```
world_seconds = anchor_world_s + (real_time - anchor_real) × speed
```

Every scheduled activity stores both `ends_at` (real UTC) and `world_ends_s` (world seconds). Events store `occurred_at` (real UTC) and `world_s`. The world starts at Day 1, 05:40.

### Speed: 60×

One world hour is one real minute, and one world day is 24 real minutes. The value lives in `world_state.speed` and is read by every viewer. `WORLD_SPEED` only sets the starting value. Presets are in `src/lib/world/speed.ts`: `demo` = 60, `calm` = 20.

`npm run world:speed-report` runs the real engine in an in-process Postgres with 59 citizens for 5-minute windows:

| Speed | Window | Moved in first minute | 2+ transitions | Events per minute | Walking, average and peak |
| --- | --- | --- | --- | --- | --- |
| 60× | After setup (05:40) | 41 | 59 | 16.8 | 3.7 and 14 |
| 60× | Midday | 33 | 59 | 27.2 | 4.2 and 11 |
| 60× | Evening | 38 | 59 | 27.4 | 4.9 and 10 |
| 60× | Night (23:30) | 17 | 5 | 5.8 | 0.3 |

At 30× most citizens changed once in five minutes, so a visitor saw almost nothing happen. At 120× the feed wrote 59 to 74 events a minute, too fast to read. 60× keeps something moving in every daytime minute, keeps the feed readable, and is easy to explain. The cost is about four quiet real minutes around world midnight, when nearly everyone sleeps. Every window had zero failed transitions.

At 60× the feed writes roughly 25,000 to 45,000 rows per real day. On a small Supabase plan, choose `calm` or add a retention job later. Nothing in Phase 3 deletes history.

## Simulation rules

- Roles: farmer, woodcutter, stonecutter, crafter, merchant, builder. Jobs are filled round-robin by job slots. Citizens without a slot are unassigned.
- Homes: 12 houses with 4 beds each. Citizens without a bed shelter at Commons Hall (12 places).
- Each citizen has a chronotype. Bedtime falls between 21:00 and about 00:30, and waking between 04:30 and 08:30.
- Work runs 05:00 to 18:00, two shifts at most per world day. The market is open 07:00 to 20:00. Commons Square opens at 07:00.
- Walking takes 30 world seconds per road tile along a breadth-first path over the road network. The browser draws the same path the server priced.
- Production: three shifts complete a batch. Farms make 15 food, the woods 18 wood, the quarry 9 stone, a workshop 4 tools. A crafter shift uses 2 wood.
- Construction: a builder shift uses 3 wood and 2 stone and adds 4%. A finished house takes in homeless citizens in token order, and its builders move to the next site, or become unassigned when none is left.
- A market visit takes one food ration. Stock is clamped to 0 to 400.

Rules are in `world_check_action` and `world_choose_action` in the migration. `src/lib/world/actions.ts` mirrors `world_check_action`, and a test compares the two on every action, building, and hour.

## Correctness under concurrency and downtime

- `world_tick()` takes a transaction-scoped advisory lock. A second caller gets `busy` or `too_soon` (less than one second since the last tick) and changes nothing. Twenty-four simultaneous calls advance the world exactly once.
- Each transition happens at its scheduled time, not at the time a tick notices it. A late tick catches up on up to 150 seconds.
- After a longer outage the world pauses instead of replaying. Every schedule is re-anchored so world time continues from the last processed moment, and one `world.resumed` system event says how long the runner was away.
- Each citizen's step runs in its own subtransaction. A failing step rolls back with its event, is retried 30 seconds later, and is recorded in `world_state.last_error`. Other citizens keep moving.
- Every event has a unique `dedupe_key`, so a repeated step cannot write a duplicate row.
- A citizen who stops being eligible becomes `unavailable` and leaves the map. A newly enrolled citizen joins with a system event.

## Activity history

The feed sits under the map on `/` and on `/activity`. It is newest first, ordered by the new `civilization_events.seq` column, with filters for category and source, "Load older" pagination, and a "New activity" indicator when rows arrive while the reader is further down. Rows link to the citizen and building they mention. `/activity?citizen=7` and `/activity?building=market` scope the feed.

Sources: `simulation` (rule-based world transitions), `system` (setup, synchronization, operator actions, membership), `ai` (reserved for the AI mind), `onchain` (reserved for activity verified on Monad).

Event kinds written by the world: `world.initialized`, `world.resumed`, `world.paused`, `world.speed_changed`, `citizen.joined_world`, `citizen.returned`, `citizen.unavailable`, `citizen.moved_in`, `citizen.market_visit`, `citizen.sleep`, `citizen.idle`, `movement.arrived_home`, `work.shift_started`, `work.shift_completed`, `resource.farming_started`, `resource.gathering_started`, `production.batch_completed`, `construction.work_started`, `construction.completed`, `social.met`, `social.gathered`. Starting to walk is not an event; the map shows it.

## Live updates

The browser never reads Supabase tables. It calls two read-only routes:

- `GET /api/world/live?since=<seq>` returns the clock, every building, every citizen, and events after `since`. If more than 100 arrived, it sets `gap` and the feed reloads from the first page.
- `GET /api/world/events?before=&limit=&category=&source=&citizen=&building=` pages history. Filters are validated against fixed lists.

After each tick that changed something, the database broadcasts `{ tick, processed }` on the public Realtime channel `chogos-world`. The browser treats it only as a nudge to call the live route. With realtime it also polls every 20 seconds; without it, every 4 seconds. Polling pauses in hidden tabs and resumes immediately when the tab is shown or the network returns. Failures back off from 4 to 30 seconds. Because citizens and buildings are always sent whole, a reconnecting tab is correct after one read. If the Realtime socket has not resubscribed 30 seconds after an error, the tab closes it, keeps polling, and tries a new socket after 1, 2, 4, and then every 5 minutes, so a missing or misconfigured Realtime service does not keep reconnecting in every open tab.

The browser clock corrects for skew using the server time in each response. It never projects world time past the point where the server would pause, so a stopped runner shows a frozen world and a "Runner stopped" notice.

## Map and interaction

- Canvas renderer in `src/components/world`. Terrain, roads, decor, and building shells are drawn once to an offscreen layer and redrawn only when a building changes status. Citizens, overlays, and lighting are drawn per frame at up to 30 fps. Drawing stops when the map is scrolled out of view or the tab is hidden.
- Citizens are procedural Chog sprites with role hats and activity icons. People inside houses, the hall, workshops, and the Storehouse are hidden and counted on a badge. Farms, the woods, the quarry, the market, the square, and construction sites show their occupants.
- Lighting follows world time: dawn, day, dusk, and night, with street lamps and lit windows in occupied buildings.
- Hover shows a tooltip. Click or tap opens an inspector for a citizen or building. The Storehouse inspector shows simulated stock.
- Drag to pan. Ctrl or ⌘ plus scroll, a trackpad pinch, or a two-finger pinch zooms. The buttons zoom and reset. Arrow keys pan, plus and minus zoom, 0 resets, Escape clears the selection. A selected citizen is followed until you move the map.
- `/?citizen=7` and `/?building=market` open the map on that entity. Lists beside the map find any citizen or place without the canvas.

## Security

- Public routes are `GET` only. `/api/world/tick` is `POST` behind a server secret and is closed by default.
- The browser receives the anon key only when it is configured, and only for the broadcast channel. The anon and authenticated roles have no grants on world tables or functions.
- The service role may select world tables and insert `world_intents`. It cannot update or delete world rows. All world writes happen inside `security definer` functions. Only `world_tick`, `world_initialize`, `world_set_speed`, `world_set_status`, and `world_cron_status` are executable by the service role.
- No financial action, token transfer, or onchain call exists in the world.

## Phase 4 seam

`world_intents` is the only way anything other than the rules can change what a citizen does.

1. Propose: build an `ActionProposal` (`src/lib/world/actions.ts`) with the action, building, `source` (`ai` or `system`), and for AI a required `decisionId` pointing at `ai_decisions`.
2. Validate: `validateProposal` checks shape. `precheckAction` applies the database rules to a snapshot.
3. Submit: `submitIntent` (`src/lib/world/intents.ts`, server-only) inserts one pending intent per citizen. There is no HTTP route for it.
4. Execute: when the citizen's current activity ends, `world_tick` validates the intent again with `world_check_action`. It applies it with `decision_source = ai` and an `ai`-sourced event, or marks it `rejected` with the reason. Expired intents are marked `expired`.

Phase 3 still does not call `submitIntent`. The Phase 4 runner does, from server code only. See [phase-4.md](phase-4.md).

## Tests

`npm test` covers, among others:

- Layout: no overlaps, every door on a road, one connected network, enough beds and shelter.
- Engine on a real Postgres (PGlite) with every migration: idempotent setup, only eligible citizens placed, house capacity, world-time and real-time consistency, shifts only after their duration, work only at matching jobs, walking time equal to route length, rest only at home or the hall, bounded stock, repeated ticks, outage pause, failing transitions rolled back without events, intent rejection and acceptance, population changes, and grants.
- Speed: at 60× at least 20 citizens change in the first minute, and in daytime every citizen changes at least twice with 8 to 45 events per minute.
- Phase 4 parity between `precheckAction` and `world_check_action`.
- Routes: read-only methods, validated filters, the tick route closed without a secret.
- Loader states: migration pending, not initialized, unconfigured.
- Client: clock projection and runner health, walking along the server path, hidden indoor occupants, camera bounds and zoom, hit testing, live merge and reconnection, and the feed's New activity behavior.
