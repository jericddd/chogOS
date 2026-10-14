import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { initializationLayout } from "@/lib/world/layout";

export const NFT = "0xc96d31F8626c6D03Fae5dCD3d61e3FB9F4a73763";
export const START = new Date("2026-10-13T00:00:00Z");

const migrationsDir = path.join(process.cwd(), "supabase", "migrations");

export function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * An in-process Postgres with every repository migration applied in order,
 * plus the Supabase roles, so grants can be checked. Test data stays here.
 */
export async function openWorldDb(options: { before?: (db: PGlite) => Promise<void> } = {}): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
  `);
  let seeded = false;
  for (const file of migrationFiles()) {
    if (!seeded && file.startsWith("20261013040000") && options.before) {
      await options.before(db);
      seeded = true;
    }
    await db.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  return db;
}

export async function seedCitizens(db: PGlite, count: number, origin = "founding_treasury"): Promise<void> {
  await db.query(
    `insert into citizens (chain_id, nft_contract, token_id, enrollment_status, origin, founding_membership_active)
     select 143, $1, g * 7, 'active', $2, $2 = 'founding_treasury' from generate_series(1, $3::int) g`,
    [NFT, origin, count],
  );
}

export async function initialize(db: PGlite, speed = 60, at: Date = START): Promise<Record<string, unknown>> {
  const result = await db.query<{ r: Record<string, unknown> }>(
    "select world_initialize_at($1::jsonb, 143, $2, $3, $4) as r",
    [JSON.stringify(initializationLayout()), NFT, speed, at.toISOString()],
  );
  return result.rows[0]!.r;
}

export async function tick(db: PGlite, at: Date): Promise<Record<string, unknown>> {
  const result = await db.query<{ r: Record<string, unknown> }>("select world_tick_at($1) as r", [at.toISOString()]);
  return result.rows[0]!.r;
}

/** Runs ticks every intervalSeconds from start (exclusive) through start + seconds. */
export async function runFor(
  db: PGlite,
  start: Date,
  seconds: number,
  intervalSeconds = 5,
): Promise<{ end: Date; failed: number }> {
  let failed = 0;
  let at = start;
  for (let elapsed = intervalSeconds; elapsed <= seconds; elapsed += intervalSeconds) {
    at = new Date(start.getTime() + elapsed * 1000);
    const result = await tick(db, at);
    failed += Number(result.failed ?? 0);
  }
  return { end: at, failed };
}

export async function rows<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}
