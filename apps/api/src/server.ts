import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { createS3Storage } from "./storage/s3.js";
import { makeHealthService } from "./services/health.js";
import { closeDb } from "./db/client.js";

export async function buildServer(cfg = loadConfig()) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const storage = createS3Storage(cfg);
  const health = makeHealthService(cfg, storage);

  app.get("/v1/health", async () => {
    const report = await health();
    const ok = report.db === "ok" && report.storage === "ok (encrypted)";
    return { statusCode: ok ? 200 : 503, body: report };
  });

  app.addHook("onClose", async () => {
    await closeDb();
  });

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3100);
  await app.listen({ port, host: "0.0.0.0" });
}
