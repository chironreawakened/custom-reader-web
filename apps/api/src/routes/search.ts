/**
 * Slice 8 search API (SPECS §9, §12).
 *
 *   GET /v1/search?q=   full-text search across the signed-in user's corpus,
 *                       returning three independently-ranked lists:
 *                       documents (ranked by best matching section),
 *                       sections (ranked by ts_rank), and highlights
 *                       (ranked by ts_rank).
 *
 * The query is matched with ONE combined, OR'd tsquery built from the three
 * FTS configs — `websearch_to_tsquery('english',q) || websearch_to_tsquery('finnish',q)
 * || websearch_to_tsquery('simple',q)` (SPECS §9) — so a term resolves in
 * whichever config actually indexed the hit. Each row is ranked with
 * `ts_rank` (descending); per-list results are capped.
 *
 * Session auth only (read-only; no CSRF on a GET).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { desc, eq, and, isNull, sql, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { documents, highlights, sections } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { SEARCH_MAX_PER_LIST, SEARCH_MAX_Q } from "@reader/shared";
import { authenticate, SESSION_COOKIE, type Authenticated } from "../services/session.js";

function err(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

async function authedUser(req: FastifyRequest, now: () => number): Promise<Authenticated | null> {
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

export interface SearchContext {
  config: AppConfig;
  now?: (() => number) | undefined;
}

export async function registerSearch(app: FastifyInstance, ctx: SearchContext) {
  const now = () => (ctx.now ? ctx.now() : Date.now());

  app.get("/v1/search", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");

    const q = (req.query as Record<string, string | undefined>)["q"];
    if (!q) return err(reply, 400, "invalid_request", "q is required");
    const query = q.trim();
    if (query.length === 0) return err(reply, 400, "invalid_request", "q must not be blank");
    if (query.length > SEARCH_MAX_Q) {
      return err(reply, 400, "invalid_request", `q must be at most ${SEARCH_MAX_Q} characters`);
    }

    const userId = authed.user.id;
    // One combined, OR'd tsquery (SPECS §9): the three FTS configs each parse
    // `query` as websearch syntax and the results are OR'd, so a term
    // resolves in whichever config indexed the hit. `websearch_to_tsquery`
    // never throws on malformed input (it yields an empty tsquery that
    // matches no rows), so no guard is needed.
    const combined = sql`(websearch_to_tsquery('english', ${query}) || websearch_to_tsquery('finnish', ${query}) || websearch_to_tsquery('simple', ${query}))::tsquery`;
    const limit = SEARCH_MAX_PER_LIST;

    // ---- sections (ranked by ts_rank) ------------------------------------
    const sectionRows = await getDb()
      .select({
        id: sections.id,
        documentId: sections.documentId,
        idx: sections.idx,
        title: sections.title,
        language: documents.language,
        rank: sql<number>`ts_rank(${sections.searchVector}, ${combined})`,
      })
      .from(sections)
      .innerJoin(documents, and(eq(sections.documentId, documents.id), eq(documents.userId, userId)))
      .where(sql`${sections.searchVector} @@ ${combined}`)
      .orderBy(desc(sql`ts_rank(${sections.searchVector}, ${combined})`))
      .limit(limit);

    const sectionDocIds = [...new Set(sectionRows.map((r) => r.documentId))];
    const docTitles = new Map<string, string>();
    if (sectionDocIds.length > 0) {
      const docRows = await getDb()
        .select({ id: documents.id, title: documents.title })
        .from(documents)
        .where(inArray(documents.id, sectionDocIds));
      for (const d of docRows) docTitles.set(d.id, d.title);
    }
    const sectionHits = sectionRows.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      documentTitle: docTitles.get(r.documentId) ?? "",
      idx: r.idx,
      title: r.title,
      language: r.language,
      rank: Number(r.rank),
    }));

    // ---- documents (ranked by best matching section) ---------------------
    const documentRows = await getDb()
      .select({
        id: documents.id,
        type: documents.type,
        title: documents.title,
        author: documents.author,
        language: documents.language,
        status: documents.status,
        rank: sql<number>`max(ts_rank(${sections.searchVector}, ${combined}))`,
      })
      .from(documents)
      .innerJoin(sections, eq(documents.id, sections.documentId))
      .where(and(eq(documents.userId, userId), sql`${sections.searchVector} @@ ${combined}`))
      .groupBy(documents.id)
      .orderBy(desc(sql`max(ts_rank(${sections.searchVector}, ${combined}))`))
      .limit(limit);

    const documentHits = documentRows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      author: r.author,
      language: r.language,
      status: r.status,
      rank: Number(r.rank),
    }));

    // ---- highlights (ranked by ts_rank) ----------------------------------
    const highlightRows = await getDb()
      .select({
        id: highlights.id,
        documentId: highlights.documentId,
        anchor: highlights.anchor,
        exact: highlights.exact,
        color: highlights.color,
        note: highlights.note,
        documentTitle: documents.title,
        rank: sql<number>`ts_rank(${highlights.searchVector}, ${combined})`,
      })
      .from(highlights)
      .innerJoin(documents, and(eq(highlights.documentId, documents.id), eq(documents.userId, userId)))
      .where(
        and(
          eq(highlights.userId, userId),
          isNull(highlights.deletedAt),
          sql`${highlights.searchVector} @@ ${combined}`,
        ),
      )
      .orderBy(desc(sql`ts_rank(${highlights.searchVector}, ${combined})`))
      .limit(limit);

    const highlightHits = highlightRows.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      documentTitle: r.documentTitle,
      sectionId: r.anchor && typeof r.anchor === "object" && "sectionId" in r.anchor
        ? ((r.anchor as { sectionId?: string | null }).sectionId ?? null)
        : null,
      exact: r.exact,
      color: r.color,
      note: r.note,
      rank: Number(r.rank),
    }));

    return reply.status(200).send({ q: query, documents: documentHits, sections: sectionHits, highlights: highlightHits });
  });
}
