import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let db: Db | null = null;

export function getDb(): Db {
  if (!db) {
    const url = process.env.POSTGRES_URL;
    if (!url) throw new Error("POSTGRES_URL is required");
    pool = new pg.Pool({ connectionString: url, max: 10 });
    db = drizzle(pool, { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
