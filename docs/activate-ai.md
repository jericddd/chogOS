# Turn the AI mind on (click these)

The civilization **already runs with your PC off**. That is Supabase `pg_cron` calling `world_tick()`.

As of 2026-10-14 the mind tables, Gemini env, and a live `source=ai` market visit are on production. Vercel Hobby Cron still hits `/api/ai/run` once per day at 16:00 UTC. GitHub Actions (free on this public repo) pokes the same URL every 30 **real** minutes so more citizens can decide without paying for Vercel Pro. Your laptop can stay off. Opening the homepage does not call the model.

After merging the Actions workflow, add the runner secret here (same string as Vercel `AI_RUNNER_SECRET`):

[https://github.com/jericddd/chogOS/settings/secrets/actions](https://github.com/jericddd/chogOS/settings/secrets/actions)

Name: `AI_RUNNER_SECRET`. Then **Actions → AI mind → Run workflow** once. GitHub only auto-runs the schedule from **`main`**. If that branch is still the old Phase 0 default, merge the workflow onto `main` or switch the default branch.

The numbered steps below are the original activation recipe. Do not re-run the SQL if `world_ensure_minds()` already inserted 59 personalities.

---

## 1. Paste the Phase 4 SQL

1. Open the SQL editor: [https://supabase.com/dashboard/project/pjsedyqourngnjjdcenl/sql/new](https://supabase.com/dashboard/project/pjsedyqourngnjjdcenl/sql/new)
2. Open the migration file: [https://github.com/jericddd/chogOS/blob/cursor/phase-1-genesis-world-155c/supabase/migrations/20261014180000_phase4_ai_mind.sql](https://github.com/jericddd/chogOS/blob/cursor/phase-1-genesis-world-155c/supabase/migrations/20261014180000_phase4_ai_mind.sql)
3. Click **Raw**, select all, copy.
4. Paste into the Supabase editor. Run it.
5. In a new query, run:

```sql
select world_ensure_minds();
```

Check: [https://chogos.vercel.app/api/world/mind?citizen=7](https://chogos.vercel.app/api/world/mind?citizen=7) should return JSON with `"status":"ok"`, not `migration_pending`.

---

## 2. Create a Gemini key (free tier)

1. Open [https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Sign in with Google. Accept the terms if asked.
3. Click **Create API key**. Copy it once. Treat it like a password.
4. Optional: confirm the model exists at [https://aistudio.google.com/prompts/new_chat](https://aistudio.google.com/prompts/new_chat) — pick `gemini-3.8-flash`.
5. Quotas live here: [https://ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits) and [https://aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit).

Do **not** turn on billing unless you want to. chogOS will not switch to paid if the free tier is exhausted.

Google may use free-tier prompts to improve Google products. The runner only sends a bounded citizen snapshot, never keys or wallets.

---

## 3. Put secrets on Vercel (Production)

1. Open env vars: [https://vercel.com/0xjericd-2214s-projects/chogos/settings/environment-variables](https://vercel.com/0xjericd-2214s-projects/chogos/settings/environment-variables)
2. Add these for **Production** (not Preview unless you want preview to call Gemini too):

| Name | Value |
| --- | --- |
| `AI_PROVIDER` | `gemini` |
| `AI_API_KEY` | the key from step 2 |
| `AI_MODEL` | `gemini-3.8-flash` (leave this; Hobby tries faster 3.x lite models first, then 3.8) |
| `AI_RUNNER_SECRET` | a long random string (`openssl rand -hex 32`) |
| `CRON_SECRET` | **the same string** as `AI_RUNNER_SECRET` |
| `AI_RUNNER_ENABLED` | `true` |
| `AI_DECISIONS_PER_RUN` | `1` (keep at 1 on Vercel Hobby; 4+ hits the 60s function timeout) |

Leave `AI_RUNNER_ENABLED` as `false` if you only want to test the key first.

3. Redeploy Production so the new env is picked up: [https://vercel.com/0xjericd-2214s-projects/chogos/deployments](https://vercel.com/0xjericd-2214s-projects/chogos/deployments) → ⋮ on the current Production deployment → **Redeploy**.

---

## 4. Merge the always-on cron PR, then wait for Vercel

`vercel.json` registers a **daily** GET to `/api/ai/run` at 16:00 UTC. Vercel Cron only runs on Production, and only after that file is deployed.

Hobby plans cannot schedule more than once per day. If this project is on Pro, say so and the schedule can be changed to hourly.

Cron list after deploy: [https://vercel.com/0xjericd-2214s-projects/chogos/settings/cron-jobs](https://vercel.com/0xjericd-2214s-projects/chogos/settings/cron-jobs)

---

## 5. Prove it (optional, one shot)

From any machine, not as a public visitor:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer YOUR_AI_RUNNER_SECRET" \
  https://chogos.vercel.app/api/ai/run
```

You want `"ok": true` and a `report` whose `status` is `ran` or `idle`, not `disabled` / `unconfigured`.

Then check [https://chogos.vercel.app/activity](https://chogos.vercel.app/activity) and filter source **AI**. A real decision is a `source=ai` row, not a model paragraph.

---

## What is already true without you

- Site: [https://chogos.vercel.app/](https://chogos.vercel.app/)
- World clock: still ticking. 59 citizens, 25 buildings, `genesis-v1.1`.
- Phase 4 code: merged in [PR #11](https://github.com/jericddd/chogOS/pull/11).
- Money: `/api/transactions` stays 403. No wallets, no treasury spend.
