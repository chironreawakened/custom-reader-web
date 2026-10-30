import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import pg from "pg";

/**
 * Idempotent migration runner.
 *
 * Tracks applied files in the "app.migrations" ledger so re-deploys skip what
 * is already applied (slice 0's runner re-ran every .sql on each deploy and
 * would fail on "relation already exists" once a second migration existed).
 * Each file runs in its own transaction together with its ledger insert, so a
 * failing file is never recorded as applied.
 */
async function migrate() {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const client = new pg.Client({ connectionString: process.env.POSTGRES_URL });
  await client.connect();
  try {
    // Ledger bootstrap (idempotent).
    await client.query(`create schema if not exists "app"`);
    await client.query(`create table if not exists "app"."migrations" (
      "name" text primary key,
      "applied_at" timestamp with time zone default now() not null
    )`);

    // slice-0 -> slice-1 transition: 0000.sql was applied to the existing prod
    // DB before the ledger existed, so it has no ledger row. If the ledger is
    // empty but app.users already exists, record 0000.sql as applied instead of
    // re-running it. On a brand-new DB (CI e2e) app.users does not exist, so
    // this is a no-op and 0000.sql runs normally. Becomes a permanent no-op
    // once 0000.sql has a ledger row.
    const { rows } = await client.query(`select count(*)::int as n from "app"."migrations"`);
    if (Number(rows[0].n) === 0) {
      const { rows: check } = await client.query(`select to_regclass('app.users') is not null as exists`);
      if (check[0].exists) {
        await client.query(`insert into "app"."migrations" ("name") values ('0000.sql') on conflict do nothing`);
        console.log("[migrate] ledger seeded: 0000.sql (pre-existing)");
      }
    }

    for (const f of files) {
      const { rows: done } = await client.query(`select 1 from "app"."migrations" where "name" = $1`, [f]);
      if (done.length > 0) {
        console.log(`[migrate] skip ${f} (already applied)`);
        continue;
      }

      const sqlText = await readFile(join(dir, f), "utf8");
      await client.query("begin");
      try {
        await client.query(sqlText);
        await client.query(`insert into "app"."migrations" ("name") values ($1)`, [f]);
        await client.query("commit");
        console.log(`[migrate] applied ${f}`);
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    }
  } finally {
    await client.end();
  }
}

migrate().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
