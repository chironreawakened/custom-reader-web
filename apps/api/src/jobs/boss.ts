/**
 * pg-boss client factory. Both the API (job sender) and the worker
 * (job handler) create their own client against the same Postgres; pg-boss
 * creates its own tables in the `pgboss` schema on start.
 */
import pgBoss from "pg-boss";
import type { AppConfig } from "../config.js";

export const JOB_EPUB_PROCESS = "epub.process";
export const JOB_BACKUP_NIGHTLY = "backup.nightly";

export interface EpubProcessJob {
  documentId: string;
}

export type Boss = InstanceType<typeof pgBoss>;

export function createBoss(cfg: AppConfig): Boss {
  const boss = new pgBoss({
    connectionString: cfg.dbUrl,
    schema: "pgboss",
  });
  boss.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[boss] pg-boss error", err);
  });
  return boss;
}
