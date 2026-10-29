import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import pg from "pg";

// Slice-0 migration runner: runs each .sql file in order via pg directly
// (a file may contain several statements; drizzle's execute is single-statement).
async function migrate() {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const client = new pg.Client({ connectionString: process.env.POSTGRES_URL });
  await client.connect();
  try {
    for (const f of files) {
      const sqlText = await readFile(join(dir, f), "utf8");
      await client.query(sqlText);
      // eslint-disable-next-line no-console
      console.log(`[migrate] applied ${f}`);
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
