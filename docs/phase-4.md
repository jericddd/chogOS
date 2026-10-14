# Phase 4 — Autonomous AI civilization mind

Phase 4 adds a hosted, cost-controlled decision loop around the existing simulation. It does not replace `world_tick()`, does not rebuild the map, and does not rerun the Phase 3.75 event cutover.

The hosted model is a reasoning engine. The civilization accumulates experience through `ai_memories`, `citizen_skills`, `citizen_goals`, and validated outcomes. This repository does not train or fine-tune Gemini.

## Source

Branch: `cursor/phase-4-ai-mind-155c`

Base: `origin/cursor/phase-1-genesis-world-155c` at `b3e570b` (merge of Phase 3.75 PR #10). That commit already contains genesis-v1.1 (120×80) and the verifiability layer.

Two already-applied Phase 3.75 follow-ups were cherry-picked so this branch also has `20261014133000_phase375_pgcrypto_path.sql` and the smaller Merkle batch script. **Do not rerun `verify_cutover`.** Hosted cutover remains at the previously reported seq.

## What is preserved

- Founding citizens, buildings, routes, genesis-v1.1 layout, `world_tick()`, `pg_cron`, public inspectors, and the Verify interface.
- Event hashing: new AI and construction events go through `world_record_event` → `civilization_events_seal_live`. No second hasher.
- `/api/transactions` still returns 403. No wallets, keys, treasury spending, or chain writes.

## Provider

| Item | Value |
| --- | --- |
| Adapter | `src/lib/ai/providers/gemini.ts` |
| Official model id | `gemini-3.8-flash` (stable; [Gemini 3.8 Flash model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), updated September 2026) |
| Endpoint | `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent` |
| Structured output | Supported by the model. Adapter sends `responseMimeType=application/json` plus `responseSchema`. Server still parses independently. |
| Default when `AI_PROVIDER=gemini` and `AI_MODEL` is blank | `gemini-3.8-flash` |
| Paid fallback | None. Quota, rate-limit, and billing errors halt new calls. |
| Ajax | Still refuses. Not operational. |

Google's rate limits are per project and usage tier (RPM / TPM / RPD). They are shown in AI Studio, not as one public number, and are not guaranteed capacity. The Free tier has no spend-based cap on that page; moving to a billed tier is a manual billing setup, and chogOS never performs that switch. Free-tier prompts **may be used to improve Google products**. Do not send API keys, service-role keys, wallet material, or unrelated personal data. The runner only sends a bounded citizen context.

`AI_PROVIDER` remains `none` in `.env.example`. Credentials do not start the mind. `AI_RUNNER_ENABLED` must be the exact string `true`.

## Loop

`Observe → Decide → Validate → Execute → Verify outcome → Remember → Decide again`

1. `POST /api/ai/run` (or `npm run ai:runner`) claims eligible citizens. This is **not** inside `world_tick()`.
2. Context is personality, skills, open goals, up to 8 memories, current activity, feasible actions from `precheckAction`, and whether a served plot is free.
3. Gemini returns JSON. `parseDecisionOutput` is independent of the vendor.
4. The row is stored in `ai_decisions` with `input_commitment` (SHA-256 of the context, not the raw key).
5. `precheckAction` + `validateProposal` + `submitIntent`. `source=ai` requires a real `ai_decisions.id`.
6. `world_tick()` re-runs `world_check_action`. Accepted intents can set `decision_source=ai`. Rejected intents store a failure memory, never a success.
7. Completed work awards skill XP once per `(event_id, skill)` and may advance a matching goal.

Rule-based activity stays `source=simulation`. A model timeout does not stop the clock.

## Personalities, goals, memory, skills

- `citizen_personalities`: seven 0–100 traits plus `preferred_activity`, hashed from `citizen_id`. `world_ensure_minds()` is idempotent.
- `citizen_goals`: `proposed | active | blocked | completed | abandoned | superseded`. Completion is progress from simulation outcomes.
- `ai_memories`: bounded retrieval, event-linked when possible. Unique indexes stop duplicate success/rejection memories.
- `citizen_skills.experience` plus `citizen_skill_awards`. Level is `min(100, max(1, 1 + experience/20))`. The model cannot write levels.

## Construction

The engine still has no free-form map generator. Phase 4 can start a **house** on a **vacant, road-served** genesis-v1.1 lot (`world_plots`). East lots at y=2 are reserved until a road touches them. The model cannot pick coordinates. `planHousePlacement` chooses the plot, door, and complete `world_routes` table; `world_place_building` re-validates overlap and inserts `under_construction` at 0%. Completion is still +4% per builder shift with Storehouse wood/stone. Unsupported kinds (new farms, workshops) are rejected honestly.

## Scheduling

- Primary world clock: existing `pg_cron` `world_tick()` every 5 seconds. Unchanged.
- AI: `POST /api/ai/run` with `Authorization: Bearer AI_RUNNER_SECRET`, or `npm run ai:runner` on a machine that stays on (Fly, a VPS, GitHub-hosted runner, Cloud Scheduler). This repo has no `vercel.json`; do not assume Vercel cron exists on the current plan.
- Defaults: 2 decisions per run, 30 minutes between a citizen's decisions, 12/hour, 48/day, 8k prompt chars, 512 output tokens, 20s timeout.
- Fair queue: `ai_claim_citizens` orders by `last_decision_at` nulls first with `SKIP LOCKED`.

Opening the homepage does not call the model.

## Hosted database

`supabase/migrations/20261014180000_phase4_ai_mind.sql` is **pending on the hosted project** until an operator pastes it. It is additive: no truncates, no citizen inserts, no clock reset, no cutover.

After it is applied:

```text
select world_ensure_minds();
```

Then set Vercel env (`AI_PROVIDER=gemini`, `AI_API_KEY`, `AI_RUNNER_SECRET`, `AI_RUNNER_ENABLED=true`) and a cloud timer for `POST https://chogos.vercel.app/api/ai/run`. Leave `AI_RUNNER_ENABLED` false until a live smoke test succeeds.

## Verifiability

New events reuse `chogos-event-v1` hashing. `intent_id` and `decision_id` are stored on the event when known. Hosted hashes are not onchain anchors. `/verify` labels are unchanged.

## Live inference

`npm run ai:smoke` makes one real Gemini request and does not write world rows.

This agent environment had no `AI_API_KEY` or `GEMINI_API_KEY`. A live `generateContent` call was **not** made. Mocked provider tests must not be read as live inference.

Against the hosted database on 2026-10-14:

| Check | Result |
| --- | --- |
| Layout | `genesis-v1.1` hash `b1745d8d` |
| Citizens / buildings | 59 / 25 |
| Event sources in the live feed | `simulation` only |
| `GET /api/world/mind?citizen=7` | 503 `migration_pending` |
| `POST /api/ai/run` | 403 (no `AI_RUNNER_SECRET`) |
| `POST /api/transactions` | 403 |

A genuine model decision has changed persisted world state only when:

1. `ai:smoke` (or an equivalent live complete) returned JSON from Gemini, and
2. A row with `source=ai` exists in `civilization_events` or a `world_buildings` row was inserted by `world_place_building` with `p_source=ai` after a stored `ai_decisions` row.

Until those two are observed on the hosted database, do not claim production AI is active.

## Security

The runner has no wallet, no SQL debugger, and no `/api/transactions` access. NFT metadata and model text are untrusted. The action allowlist is enforced on the server.
