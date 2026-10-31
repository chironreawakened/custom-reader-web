import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createS3Storage } from "./storage/s3.js";
import { createObjectStore } from "./storage/object-store.js";
import { makeHealthService } from "./services/health.js";
import { closeDb } from "./db/client.js";
import { registerAuth } from "./routes/auth.js";
import { registerDocuments } from "./routes/documents.js";
import { createBoss } from "./jobs/boss.js";
import type { AppConfig } from "./config.js";
import type { Mailer } from "./services/mailer.js";

export interface BuildServerOptions {
  /** Inject a mailer (unit tests); production uses the configured one. */
  mailer?: Mailer;
  /** Override the clock (unit tests for rate limits / session windows). */
  now?: () => number;
}

export async function buildServer(cfg = loadConfig(), opts: BuildServerOptions = {}) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(fastifyCookie, {});
  await app.register(fastifyMultipart, { limits: { fileSize: 200 * 1024 * 1024 } });

  const storage = createS3Storage(cfg);
  const health = makeHealthService(cfg, storage);

  // CI e2e uses a fresh MinIO per run: make sure the bucket exists before the
  // first health check. In prod the Hippius bucket already exists, so this is
  // a cheap HeadBucket no-op.
  if (cfg.env === "ci") await storage.ensureBucket();

  app.get("/v1/health", async () => {
    const report = await health();
    const ok = report.db === "ok" && report.storage === "ok (encrypted)";
    return { statusCode: ok ? 200 : 503, body: report };
  });

  const authCtx: { config: AppConfig; mailer?: Mailer; now?: () => number } = { config: cfg };
  if (opts.mailer) authCtx.mailer = opts.mailer;
  if (opts.now) authCtx.now = opts.now;
  await registerAuth(app, authCtx);

  const objectStore = createObjectStore(cfg, storage);
  const boss = createBoss(cfg);
  // The API only SENDS jobs; starting the boss opens its db connection (and
  // runs a schema check). The worker process starts its own boss + work() handlers.
  await boss.start();
  app.addHook("onClose", async () => {
    await boss.stop().catch(() => {});
  });
  await registerDocuments(app, { config: cfg, objectStore, boss, now: opts.now });

  // CI e2e only: serve the built SPA so Playwright can drive the real UI at the
  // API origin (in prod Caddy serves /srv/reader/web-dist instead).
  const webDist = process.env.RDR_WEB_DIST;
  if (cfg.env === "ci" && webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, index: "index.html" });
  }

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
