/**
 * Slice 5 tags API (SPECS §11, §12).
 *
 *   GET    /v1/tags         the user's tags, name-ordered.
 *   POST   /v1/tags         {name} → create (idempotent: existing tag returned).
 *   DELETE /v1/tags/:id     remove the tag (document_tags cascade).
 *
 * Tags are per-user, unique on (user_id, lower(name)); the stored name keeps
 * the display casing of the first creation.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { tags } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { csrfOk } from "../services/csrf.js";
import { authenticate, SESSION_COOKIE, type Authenticated } from "../services/session.js";

function err(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

async function authedUser(
  req: FastifyRequest,
  config: AppConfig,
  now: () => number,
): Promise<Authenticated | null> {
  const cookie = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
  let token = cookie;
  if (!token) {
    const h = req.headers["authorization"];
    const m = typeof h === "string" ? /^Bearer\s+(.+)$/i.exec(h) : null;
    if (m) token = m[1];
  }
  if (!token) return null;
  return authenticate(token, now);
}

function mutatingCsrfOk(req: FastifyRequest, config: AppConfig): boolean {
  const hasCookie = Boolean((req.cookies as Record<string, string | undefined>)[SESSION_COOKIE]);
  const hasBearer = typeof req.headers["authorization"] === "string" && req.headers["authorization"]!.startsWith("Bearer");
  if (hasBearer && !hasCookie) return true; // bearer is exempt
  return csrfOk(req, config);
}

export interface TagsContext {
  config: AppConfig;
  now?: (() => number) | undefined;
}

export async function registerTags(app: FastifyInstance, ctx: TagsContext) {
  const { config } = ctx;
  const now = () => (ctx.now ? ctx.now() : Date.now());

  // ---- GET /v1/tags ---------------------------------------------------------
  app.get("/v1/tags", async (req, reply) => {
    const authed = await authedUser(req, config, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");

    const rows = await getDb()
      .select()
      .from(tags)
      .where(eq(tags.userId, authed.user.id))
      .orderBy(asc(sql`lower(${tags.name})`));

    return {
      items: rows.map((t) => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  });

  // ---- POST /v1/tags ---------------------------------------------------------
  app.post("/v1/tags", async (req, reply) => {
    const authed = await authedUser(req, config, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    if (!mutatingCsrfOk(req, config)) return err(reply, 403, "csrf", "origin check failed");

    const name = String((req.body as { name?: unknown } | undefined)?.name ?? "").trim();
    if (name.length < 1 || name.length > 64) {
      return err(reply, 400, "invalid_tag", "name must be 1–64 chars");
    }

    // Idempotent: an existing tag (case-insensitively) is returned as-is.
    const existing = await getDb()
      .select()
      .from(tags)
      .where(and(eq(tags.userId, authed.user.id), sql`lower(${tags.name}) = ${name.toLowerCase()}`))
      .limit(1);
    if (existing[0]) {
      return {
        id: existing[0].id,
        name: existing[0].name,
        createdAt: existing[0].createdAt.toISOString(),
      };
    }

    try {
      const [tag] = await getDb()
        .insert(tags)
        .values({ id: crypto.randomUUID(), userId: authed.user.id, name })
        .returning();
      return reply.status(201).send({
        id: tag!.id,
        name: tag!.name,
        createdAt: tag!.createdAt.toISOString(),
      });
    } catch (e) {
      // Lost the insert race (unique index) — return the winner.
      if (e instanceof Error && e.message.includes("tags_user_name_unique")) {
        const winner = await getDb()
          .select()
          .from(tags)
          .where(and(eq(tags.userId, authed.user.id), sql`lower(${tags.name}) = ${name.toLowerCase()}`))
          .limit(1);
        if (winner[0]) {
          return {
            id: winner[0].id,
            name: winner[0].name,
            createdAt: winner[0].createdAt.toISOString(),
          };
        }
      }
      req.log.error({ err: e }, "tag insert failed");
      return err(reply, 500, "db_error", "could not create the tag");
    }
  });

  // ---- DELETE /v1/tags/:id ----------------------------------------------------
  app.delete("/v1/tags/:id", async (req, reply) => {
    const authed = await authedUser(req, config, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    if (!mutatingCsrfOk(req, config)) return err(reply, 403, "csrf", "origin check failed");

    const tagId = (req.params as { id: string }).id;
    const rows = await getDb()
      .delete(tags)
      .where(and(eq(tags.id, tagId), eq(tags.userId, authed.user.id)))
      .returning({ id: tags.id });
    if (rows.length === 0) return err(reply, 404, "not_found", "no such tag");

    return reply.status(204).send();
  });
}
