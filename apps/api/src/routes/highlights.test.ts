import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { documents, highlights, sections } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import type { ObjectStore } from "../storage/object-store.js";
import { registerHighlights } from "./highlights.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const DOC_A = "22222222-2222-2222-2222-222222222222";
const DOC_B = "33333333-3333-3333-3333-333333333333";
const SECTION_1 = "44444444-4444-4444-4444-444444444444";
const SECTION_2 = "55555555-5555-5555-5555-555555555555";
const SECTION_GONE = "66666666-6666-6666-6666-666666666666";
const HL_ID = "99999999-9999-9999-9999-999999999999";
const TOKEN = "good-token";

// The section canonical text every anchor in this file is built against.
// "The lighthouse keeper walked the spiral stairs." — "keeper walked the
// spiral" starts at offset 17.
const CANON = "The lighthouse keeper walked the spiral stairs.";
const ANCHOR = {
  kind: "reflow" as const,
  v: 1 as const,
  sectionId: SECTION_1,
  exact: "keeper walked the spiral",
  prefix: "The lighthouse ",
  suffix: " stairs.",
  offsetHint: 17,
  canonicalTextVersion: 1,
};

/** Fake object store: htmlObjectId → stored section HTML. */
const objectStore: ObjectStore = {
  put: async () => { throw new Error("unused"); },
  putCiphertextStream: async () => { throw new Error("unused"); },
  recordObject: async () => { throw new Error("unused"); },
  get: async (id: string) => new TextEncoder().encode(`<!-- html:${id} -->`),
  getRange: async () => { throw new Error("unused"); },
  meta: async () => null,
  delete: async () => { throw new Error("unused"); },
};

/** Fake canonicalize: the stored HTML's marker maps to the section's
 *  canonical text (SECTION_1 → CANON; SECTION_2 → edited text; others → ""). */
function fakeCanonicalize(html: string): string {
  const m = /<!-- html:([\da-f-]+) -->/.exec(html);
  if (m?.[1] === SECTION_1) return CANON;
  if (m?.[1] === SECTION_2) return CANON + " And the fog never lifted.";
  return "";
}

/** Mutable fake standing in for the drizzle db (getDb is mocked). Rows are
 *  keyed by the table object the route selected from (identity — computed
 *  property keys would stringify every Drizzle table to "[object Object]"). */
const state = {
  rowsByTable: new Map<object, unknown[]>(),
  from: undefined as unknown,
  where: undefined as unknown,
  insertTable: undefined as unknown,
  insertValues: undefined as unknown,
  updateTable: undefined as unknown,
  updateValues: undefined as unknown,
  updateWhere: undefined as unknown,
  returning: [] as unknown[],
};

function chain(rows: unknown[]) {
  const arr = [...rows] as unknown[] & {
    orderBy: () => unknown;
    limit: () => unknown;
    returning: () => Promise<unknown[]>;
  };
  arr.orderBy = () => arr;
  arr.limit = () => arr;
  arr.returning = async () => state.returning;
  return arr;
}

vi.mock("../db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: (t: object) => {
        state.from = t;
        return {
          // Synchronous query builder (like drizzle's): the route chains
          // .orderBy()/.limit() BEFORE awaiting.
          where: (w: unknown) => {
            state.where = w;
            return chain(state.rowsByTable.get(t) ?? []);
          },
        };
      },
    }),
    insert: (t: unknown) => {
      state.insertTable = t;
      return {
        values: (v: unknown) => {
          state.insertValues = v;
          return { returning: async () => state.returning };
        },
      };
    },
    update: (t: unknown) => {
      state.updateTable = t;
      return {
        set: (v: unknown) => {
          state.updateValues = v;
          return {
            where: (w: unknown) => {
              state.updateWhere = w;
              return chain(state.returning);
            },
          };
        },
      };
    },
  }),
}));

vi.mock("../services/session.js", () => ({
  SESSION_COOKIE: "rdr_session",
  authenticate: async (token: string) =>
    token === TOKEN
      ? {
          user: { id: USER_ID, email: "a@b.c", createdAt: new Date(0) },
          sessionId: "sess-1",
          kind: "web",
          expiresAt: new Date(Date.now() + 86400_000),
        }
      : null,
}));

function makeConfig(): AppConfig {
  return {
    masterKey: new Uint8Array(32),
    hippus: { endpoint: "http://s3", region: "us-east-1", bucket: "b", accessKey: "a", secretKey: "s" },
    dbUrl: "postgres://x",
    allowedEmail: "a@b.c",
    publicOrigin: "reader.test",
    env: "prod",
    mailer: "console",
  };
}

function reset(
  ...tables: [object, unknown[]][]
) {
  state.rowsByTable = new Map(tables);
  state.from = undefined;
  state.where = undefined;
  state.insertTable = undefined;
  state.insertValues = undefined;
  state.updateTable = undefined;
  state.updateValues = undefined;
  state.updateWhere = undefined;
  state.returning = [];
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie, {});
  await registerHighlights(app, {
    config: makeConfig(),
    objectStore,
    canonicalize: fakeCanonicalize,
  });
  await app.ready();
  return app;
}

function hlRow(over: Record<string, unknown> = {}) {
  return {
    id: HL_ID,
    userId: USER_ID,
    documentId: DOC_A,
    anchor: ANCHOR,
    exact: ANCHOR.exact,
    color: null,
    note: null,
    createdAt: new Date("2026-11-01T09:00:00.000Z"),
    updatedAt: new Date("2026-11-01T09:00:00.000Z"),
    deletedAt: null,
    ...over,
  };
}

const cookie = { rdr_session: TOKEN };
const bearer = { authorization: `Bearer ${TOKEN}` };
const csrf = { "x-requested-with": "reader", origin: "https://reader.test" };

beforeEach(() => {
  reset();
});

describe("GET /v1/highlights", () => {
  it("401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/highlights" });
    expect(res.statusCode).toBe(401);
  });

  it("400 for a non-uuid documentId filter", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/highlights?documentId=xyz", cookies: cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("returns an empty list when there are no highlights", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/highlights", cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0 });
  });

  it("returns the highlight with a resolvable anchor (orphaned: false) and the section title", async () => {
    reset(
      [highlights, [hlRow()]],
      [sections, [
        { id: SECTION_1, title: "Chapter One", htmlObjectId: SECTION_1, documentId: DOC_A, userId: USER_ID },
      ]],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/highlights", cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          id: HL_ID,
          documentId: DOC_A,
          sectionId: SECTION_1,
          anchor: ANCHOR,
          exact: ANCHOR.exact,
          color: null,
          note: null,
          orphaned: false,
          sectionTitle: "Chapter One",
          createdAt: "2026-11-01T09:00:00.000Z",
          updatedAt: "2026-11-01T09:00:00.000Z",
        },
      ],
      total: 1,
    });
  });

  it("flags an orphaned anchor (section HTML gone) but still returns it", async () => {
    // SECTION_GONE has no htmlObjectId → canonical text unavailable → orphaned.
    reset(
      [highlights, [hlRow({ id: "88888888-8888-8888-8888-888888888888", anchor: { ...ANCHOR, sectionId: SECTION_GONE } })]],
      [sections, [{ id: SECTION_GONE, title: "Gone", htmlObjectId: null, documentId: DOC_A, userId: USER_ID }]],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/highlights", cookies: cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { orphaned: boolean; sectionId: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!.orphaned).toBe(true);
    expect(body.items[0]!.sectionId).toBe(SECTION_GONE);
  });

  it("filters by documentId", async () => {
    reset(
      [highlights, [
        hlRow(),
        hlRow({ id: "77777777-7777-7777-7777-777777777777", documentId: DOC_B }),
      ]],
      [sections, [
        { id: SECTION_1, title: "Chapter One", htmlObjectId: SECTION_1, documentId: DOC_A, userId: USER_ID },
      ]],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/highlights?documentId=${DOC_B}`, cookies: cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!.id).toBe("77777777-7777-7777-7777-777777777777");
  });
});

describe("POST /v1/highlights", () => {
  const body = {
    documentId: DOC_A,
    anchor: ANCHOR,
    exact: ANCHOR.exact,
    color: "yellow",
    note: "nice line",
  };

  it("401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/highlights", payload: body });
    expect(res.statusCode).toBe(401);
  });

  it("403 for a cookie request missing the CSRF headers", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/highlights", payload: body, cookies: cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf");
  });

  it("400 for an anchor whose section is not in the document", async () => {
    // documents: the user owns DOC_A. sections: none → the anchor's
    // section lookup comes up empty (the mock returns table contents as
    // the query result).
    reset(
      [documents, [{ id: DOC_A, userId: USER_ID, title: "Book A" }]],
      [sections, []],
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/highlights",
      payload: body, // anchor.sectionId = SECTION_1, which belongs to no doc here
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(state.insertTable).toBeUndefined();
  });

  it("404 for a document not owned by the session user", async () => {
    // documents: no row for this user → ownedDocument finds nothing (the
    // mock returns table contents as the query result).
    reset(
      [documents, []],
      [sections, []],
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/highlights",
      payload: { ...body, documentId: DOC_B },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(state.insertTable).toBeUndefined();
  });

  it("inserts and echoes the highlight (cookie + CSRF)", async () => {
    const row = hlRow({ color: "yellow", note: "nice line" });
    reset(
      [documents, [{ id: DOC_A, userId: USER_ID, title: "Book A" }]],
      [sections, [{ id: SECTION_1, title: "Chapter One", htmlObjectId: SECTION_1, documentId: DOC_A, userId: USER_ID }]],
    );
    state.returning = [row];
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/highlights",
      payload: body,
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(201);
    const item = res.json() as { id: string; exact: string; color: string; note: string; orphaned: boolean };
    expect(item.id).toBe(HL_ID);
    expect(item.exact).toBe(ANCHOR.exact);
    expect(item.color).toBe("yellow");
    expect(item.note).toBe("nice line");
    expect(item.orphaned).toBe(false);
    expect(state.insertTable).toBe(highlights);
    expect(state.insertValues).toMatchObject({
      userId: USER_ID,
      documentId: DOC_A,
      anchor: ANCHOR,
      exact: ANCHOR.exact,
      color: "yellow",
      note: "nice line",
    });
  });

  it("exempts bearer-only requests from CSRF", async () => {
    reset(
      [documents, [{ id: DOC_A, userId: USER_ID, title: "Book A" }]],
      [sections, [{ id: SECTION_1, title: "Chapter One", htmlObjectId: SECTION_1, documentId: DOC_A, userId: USER_ID }]],
    );
    state.returning = [hlRow()];
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/highlights", payload: body, headers: bearer });
    expect(res.statusCode).toBe(201);
  });
});

describe("PATCH /v1/highlights/:id", () => {
  const stored = hlRow({ color: "yellow", note: "old note" });

  it("403 for a cookie request missing the CSRF headers", async () => {
    reset([highlights, [stored]]);
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/highlights/${HL_ID}`,
      payload: { note: "new note" },
      cookies: cookie,
    });
    expect(res.statusCode).toBe(403);
  });

  it("404 for an unknown (or deleted) id", async () => {
    // No rows for this user → the id lookup comes up empty (the mock
    // returns table contents as the query result).
    reset([highlights, []]);
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/highlights/11111111-2222-3333-4444-555555555555`,
      payload: { note: "x" },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(404);
  });

  it("updates only the sent field (partial)", async () => {
    reset([highlights, [stored]]);
    state.returning = [hlRow({ color: "yellow", note: "new note" })];
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/highlights/${HL_ID}`,
      payload: { note: "new note" },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ note: "new note", color: "yellow" });
    expect(state.updateTable).toBe(highlights);
    expect(state.updateValues).toMatchObject({ color: "yellow", note: "new note" });
  });

  it("clears the colour with an explicit null", async () => {
    reset([highlights, [stored]]);
    state.returning = [hlRow({ color: null, note: "old note" })];
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/highlights/${HL_ID}`,
      payload: { color: null },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ color: null, note: "old note" });
    expect(state.updateValues).toMatchObject({ color: null, note: "old note" });
  });

  it("400 for an invalid colour", async () => {
    reset([highlights, [stored]]);
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/highlights/${HL_ID}`,
      payload: { color: "neon" },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });
});

describe("DELETE /v1/highlights/:id (soft)", () => {
  const stored = hlRow();

  it("404 for an unknown id", async () => {
    // No rows for this user → the id lookup comes up empty (the mock
    // returns table contents as the query result).
    reset([highlights, []]);
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/highlights/11111111-2222-3333-4444-555555555555",
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(404);
  });

  it("sets deleted_at and returns 204", async () => {
    reset([highlights, [stored]]);
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `/v1/highlights/${HL_ID}`, cookies: cookie, headers: csrf });
    expect(res.statusCode).toBe(204);
    expect(state.updateTable).toBe(highlights);
    expect(state.updateValues).toMatchObject({ deletedAt: expect.any(Date) });
  });
});

describe("GET /v1/export/highlights.md", () => {
  it("401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/export/highlights.md" });
    expect(res.statusCode).toBe(401);
  });

  it("returns an empty markdown file when there are no highlights", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/export/highlights.md", cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="highlights.md"');
    expect(res.body).toBe("");
  });

  it("renders the document's highlights as markdown with section titles, colour and note", async () => {
    reset(
      [highlights, [hlRow({ color: "yellow", note: "keep" })]],
      [documents, [{ id: DOC_A, title: "The Lighthouse" }]],
      [sections, [{ id: SECTION_1, title: "Chapter One", htmlObjectId: SECTION_1, documentId: DOC_A, userId: USER_ID }]],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/export/highlights.md", cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(res.body).toBe(
      [
        "# The Lighthouse",
        "",
        "> [Yellow] keeper walked the spiral",
        "> — Chapter One",
        "> Note: keep",
        "",
      ].join("\n"),
    );
  });

  it("marks orphaned rows in the export", async () => {
    reset(
      [highlights, [
        hlRow({ id: "88888888-8888-8888-8888-888888888888", anchor: { ...ANCHOR, sectionId: SECTION_GONE } }),
      ]],
      [documents, [{ id: DOC_A, title: "The Lighthouse" }]],
      [sections, [{ id: SECTION_GONE, title: "Gone", htmlObjectId: null, documentId: DOC_A, userId: USER_ID }]],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/export/highlights.md", cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(
      [
        "# The Lighthouse",
        "",
        "> keeper walked the spiral",
        "> — Gone (orphaned)",
        "",
      ].join("\n"),
    );
  });
});
