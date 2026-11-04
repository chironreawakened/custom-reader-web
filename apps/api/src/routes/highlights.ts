/**
 * Slice 4 highlights API (SPECS §7, §11, §12).
 *
 *   GET    /v1/highlights[?documentId]   the user's active highlights, newest
 *                                        first, with a server-computed
 *                                        `orphaned` flag (SPECS §7: orphaned
 *                                        anchors are shown in the list, not
 *                                        in the text, never dropped).
 *   POST   /v1/highlights                { documentId, anchor, exact, … }.
 *   PATCH  /v1/highlights/:id            { color?, note? } — partial.
 *   DELETE /v1/highlights/:id            soft delete (deleted_at).
 *   GET    /v1/export/highlights.md      Markdown export, optional
 *                                        ?documentId= (download link).
 *
 * All routes require session auth. Cookie-authenticated mutating requests
 * are CSRF-checked (X-Requested-With + Origin); bearer requests are exempt
 * (SPECS §4).
 */
import { DOMParser } from "@xmldom/xmldom";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { documents, highlights, sections } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import type { ObjectStore } from "../storage/object-store.js";
import {
  canonicalText,
  formatHighlightMarkdown,
  patchHighlightBody,
  postHighlightBody,
  resolveAnchor,
  type CTElement,
  type HighlightAnchor,
  type HighlightColor,
  type HighlightItem,
  type PostHighlightBody,
} from "@reader/shared";
import { csrfOk } from "../services/csrf.js";
import { authenticate, SESSION_COOKIE, type Authenticated } from "../services/session.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** List/export are read-only; one user's corpus stays well under this. */
const MAX_HIGHLIGHTS = 500;

/** Uniform error shape (SPECS §12). */
function err(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

/** Cookie (web) or Bearer (RN/CLI) auth. */
async function authedUser(
  req: FastifyRequest,
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

/** Mutating request is CSRF-checked when the session cookie is present. */
function mutatingCsrfOk(req: FastifyRequest, config: AppConfig): boolean {
  const hasCookie = Boolean((req.cookies as Record<string, string | undefined>)[SESSION_COOKIE]);
  const hasBearer =
    typeof req.headers["authorization"] === "string" &&
    req.headers["authorization"]!.startsWith("Bearer");
  if (hasBearer && !hasCookie) return true;
  return csrfOk(req, config);
}

export interface HighlightsContext {
  config: AppConfig;
  objectStore: ObjectStore;
  now?: (() => number) | undefined;
  /**
   * section HTML → canonical text. Injectable for unit tests; the default
   * parses the XHTML with @xmldom/xmldom and runs the shared canonicalText
   * (SPECS §6) — the same function the worker ran at ingest time.
   */
  canonicalize?: ((html: string) => string) | undefined;
}

const defaultCanonicalize = (html: string): string => {
  // Stored section HTML is a sanitized <body> FRAGMENT (parse-epub serializes
  // the body element, sanitize-html drops the tag, contents remain) — several
  // top-level elements. xmldom's XHTML parser requires exactly one root
  // element, so wrap it: `body` is not a canonical block boundary, so the
  // resulting text is identical to walking the fragment itself.
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "application/xhtml+xml");
  // getElementsByTagName, not doc.body (the Document type name collides with
  // the DOM lib — same pattern as parse-epub).
  const body = doc.getElementsByTagName("body")[0] as unknown as CTElement | undefined;
  if (!body) return "";
  const { text } = canonicalText(body);
  return text;
};

export async function registerHighlights(app: FastifyInstance, ctx: HighlightsContext) {
  const config = ctx.config;
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const objectStore = ctx.objectStore;
  const canonicalize = ctx.canonicalize ?? defaultCanonicalize;

  // ---- helpers -------------------------------------------------------------

  async function ownedDocument(docId: string, userId: string) {
    const rows = await getDb()
      .select()
      .from(documents)
      .where(and(eq(documents.id, docId), eq(documents.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Section id → canonical text, for the user's rows of ONE document. Returns
   * undefined for a section whose stored HTML is unavailable (the anchor
   * then counts as orphaned — safe direction: shown in the list).
   */
  async function sectionCanonicalTexts(
    docId: string,
    userId: string,
    sectionIds: Set<string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (sectionIds.size === 0) return out;
    const all = await getDb()
      .select({ id: sections.id, htmlObjectId: sections.htmlObjectId })
      .from(sections)
      .where(and(eq(sections.documentId, docId), eq(sections.userId, userId)));
    for (const s of all) {
      if (!sectionIds.has(s.id)) continue;
      if (!s.htmlObjectId) { out.set(s.id, ""); continue; }
      try {
        out.set(s.id, canonicalize(new TextDecoder().decode(await objectStore.get(s.htmlObjectId))));
      } catch {
        out.set(s.id, "");
      }
    }
    return out;
  }

  function isOrphaned(anchor: HighlightAnchor, canon: string | undefined): boolean {
    if (anchor.kind !== "reflow") return false; // pdf anchors resolve in the PDF reader
    if (canon === undefined || canon === "") return true;
    return resolveAnchor(anchor, canon).status === "orphaned";
  }

  function toItem(
    row: typeof highlights.$inferSelect,
    sectionTitle: string | null,
    orphaned: boolean,
  ): HighlightItem {
    return {
      id: row.id,
      documentId: row.documentId,
      sectionId: row.anchor.kind === "reflow" ? row.anchor.sectionId : null,
      anchor: row.anchor,
      exact: row.exact,
      color: row.color,
      note: row.note,
      orphaned,
      sectionTitle,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** All the user's non-deleted highlights, newest first (capped). */
  async function activeHighlights(userId: string) {
    return getDb()
      .select()
      .from(highlights)
      .where(and(eq(highlights.userId, userId), isNull(highlights.deletedAt)))
      .orderBy(desc(highlights.createdAt), desc(highlights.id))
      .limit(MAX_HIGHLIGHTS);
  }

  /** Section id → display title, for one document. */
  async function sectionTitles(docId: string): Promise<Map<string, string>> {
    const rows = await getDb()
      .select({ id: sections.id, title: sections.title })
      .from(sections)
      .where(and(eq(sections.documentId, docId)));
    const out = new Map<string, string>();
    for (const r of rows) if (r.title) out.set(r.id, r.title);
    return out;
  }

  // ---- GET /v1/highlights ----------------------------------------------------
  app.get("/v1/highlights", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    const q = req.query as Record<string, string | undefined>;
    if (q.documentId !== undefined && !UUID_RE.test(q.documentId)) {
      return err(reply, 400, "invalid_request", "documentId is not a uuid");
    }

    const rows = await activeHighlights(authed.user.id);
    const byDoc = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byDoc.get(r.documentId) ?? [];
      list.push(r);
      byDoc.set(r.documentId, list);
    }

    const items: HighlightItem[] = [];
    for (const [docId, docRows] of byDoc) {
      if (q.documentId && q.documentId !== docId) continue;
      const titles = await sectionTitles(docId);
      const secIds = new Set(docRows.map((r) => (r.anchor.kind === "reflow" ? r.anchor.sectionId : null)).filter((x): x is string => !!x));
      const canon = await sectionCanonicalTexts(docId, authed.user.id, secIds);
      for (const r of docRows) {
        const sectionId = r.anchor.kind === "reflow" ? r.anchor.sectionId : null;
        const title = r.anchor.kind === "pdf" ? `Page ${r.anchor.page}` : (sectionId ? (titles.get(sectionId) ?? null) : null);
        items.push(toItem(r, title, isOrphaned(r.anchor, sectionId ? canon.get(sectionId) : undefined)));
      }
    }
    return reply.status(200).send({ items, total: items.length });
  });

  // ---- POST /v1/highlights ----------------------------------------------------
  app.post("/v1/highlights", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    if (!mutatingCsrfOk(req, config)) return err(reply, 403, "csrf", "origin check failed");

    const parsed = postHighlightBody.safeParse(req.body);
    if (!parsed.success) {
      return err(reply, 400, "invalid_request", parsed.error.issues.map((i) => i.message).join(", "));
    }
    const body: PostHighlightBody = parsed.data;
    if (!UUID_RE.test(body.documentId)) return err(reply, 400, "invalid_request", "documentId is not a uuid");
    const doc = await ownedDocument(body.documentId, authed.user.id);
    if (!doc) return err(reply, 404, "not_found", "no such document");

    if (body.anchor.kind === "pdf") {
      // A PDF anchor only makes sense on a ready PDF document, and its
      // page must exist (SPECS §7: page is 1-based).
      if (doc.type !== "pdf") {
        return err(reply, 400, "invalid_request", "pdf anchors require a PDF document");
      }
      if (body.anchor.page > (doc.pageCount ?? 0)) {
        return err(reply, 400, "invalid_request", "anchor page is out of range");
      }
    } else {
      // The anchor must point at a section of this document (cross-document
      // or phantom section ids are rejected, not silently stored).
      const secRows = await getDb()
        .select({ id: sections.id })
        .from(sections)
        .where(and(eq(sections.id, body.anchor.sectionId), eq(sections.documentId, body.documentId)))
        .limit(1);
      if (secRows.length === 0) {
        return err(reply, 400, "invalid_request", "anchor section is not part of this document");
      }
    }

    const storedUpdatedAt = new Date(now());
    const [row] = await getDb()
      .insert(highlights)
      .values({
        id: crypto.randomUUID(),
        userId: authed.user.id,
        documentId: body.documentId,
        anchor: body.anchor,
        exact: body.exact,
        color: body.color,
        note: body.note,
        searchVector: sql`to_tsvector('simple', ${body.exact})`,
        updatedAt: storedUpdatedAt,
      })
      .returning();

    return reply.status(201).send(
      toItem(row!, null, false),
    );
  });

  // ---- find owned, non-deleted row -------------------------------------------
  async function ownedHighlight(id: string, userId: string) {
    const rows = await getDb()
      .select()
      .from(highlights)
      .where(and(eq(highlights.id, id), eq(highlights.userId, userId), isNull(highlights.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  // ---- PATCH /v1/highlights/:id -------------------------------------------------
  app.patch("/v1/highlights/:id", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    if (!mutatingCsrfOk(req, config)) return err(reply, 403, "csrf", "origin check failed");
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return err(reply, 400, "invalid_request", "id is not a uuid");

    const parsed = patchHighlightBody.safeParse(req.body);
    if (!parsed.success) {
      return err(reply, 400, "invalid_request", parsed.error.issues.map((i) => i.message).join(", "));
    }
    const row = await ownedHighlight(id, authed.user.id);
    if (!row) return err(reply, 404, "not_found", "no such highlight");

    const nextColor: HighlightColor | null | undefined = parsed.data.color;
    const nextNote: string | null | undefined = parsed.data.note;
    const storedUpdatedAt = new Date(now());
    const [updated] = await getDb()
      .update(highlights)
      .set({
        color: nextColor !== undefined ? nextColor : row.color,
        note: nextNote !== undefined ? nextNote : row.note,
        updatedAt: storedUpdatedAt,
      })
      .where(eq(highlights.id, id))
      .returning();

    return reply.status(200).send(toItem(updated!, null, false));
  });

  // ---- DELETE /v1/highlights/:id (soft) ------------------------------------------
  app.delete("/v1/highlights/:id", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    if (!mutatingCsrfOk(req, config)) return err(reply, 403, "csrf", "origin check failed");
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return err(reply, 400, "invalid_request", "id is not a uuid");

    const row = await ownedHighlight(id, authed.user.id);
    if (!row) return err(reply, 404, "not_found", "no such highlight");

    const deletedAt = new Date(now());
    await getDb()
      .update(highlights)
      .set({ deletedAt })
      .where(eq(highlights.id, id));
    return reply.status(204).send();
  });

  // ---- GET /v1/export/highlights.md ------------------------------------------------
  app.get("/v1/export/highlights.md", async (req, reply) => {
    const authed = await authedUser(req, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    const q = req.query as Record<string, string | undefined>;
    if (q.documentId !== undefined && !UUID_RE.test(q.documentId)) {
      return err(reply, 400, "invalid_request", "documentId is not a uuid");
    }

    const rows = await activeHighlights(authed.user.id);
    const byDoc = new Map<string, typeof rows>();
    for (const r of rows) {
      if (q.documentId && q.documentId !== r.documentId) continue;
      const list = byDoc.get(r.documentId) ?? [];
      list.push(r);
      byDoc.set(r.documentId, list);
    }
    if (byDoc.size === 0) {
      reply.header("content-type", "text/markdown; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="highlights.md"`);
      return reply.status(200).send("");
    }

    const blocks: string[] = [];
    for (const [docId, docRows] of byDoc) {
      const docRows2 = await getDb()
        .select({ title: documents.title })
        .from(documents)
        .where(eq(documents.id, docId))
        .limit(1);
      const title = docRows2[0]?.title ?? "Untitled";
      const titles = await sectionTitles(docId);
      const secIds = new Set(docRows.map((r) => (r.anchor.kind === "reflow" ? r.anchor.sectionId : null)).filter((x): x is string => !!x));
      const canon = await sectionCanonicalTexts(docId, authed.user.id, secIds);
      const md = formatHighlightMarkdown(
        title,
        docRows.map((r) => {
          const sectionId = r.anchor.kind === "reflow" ? r.anchor.sectionId : null;
          return {
            exact: r.exact,
            sectionTitle: r.anchor.kind === "pdf" ? `Page ${r.anchor.page}` : (sectionId ? (titles.get(sectionId) ?? null) : null),
            color: r.color,
            note: r.note,
            orphaned: isOrphaned(r.anchor, sectionId ? canon.get(sectionId) : undefined),
          };
        }),
      );
      if (md) blocks.push(md);
    }

    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="highlights.md"`);
    return reply.status(200).send(blocks.join("\n"));
  });
}
