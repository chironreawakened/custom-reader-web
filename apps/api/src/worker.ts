import pgBoss from "pg-boss";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const boss = new pgBoss({
  connectionString: cfg.dbUrl,
  schema: "pgboss",
});

boss.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] pg-boss error", err);
});

const shutdown = async (sig: string) => {
  // eslint-disable-next-line no-console
  console.log(`[worker] ${sig}, shutting down`);
  await boss.stop({ timeout: 10 });
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await boss.start();
// eslint-disable-next-line no-console
console.log("[worker] started (no jobs registered yet)");
