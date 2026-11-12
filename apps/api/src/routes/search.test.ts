/**
 * Slice 8 search-route tests: GET /v1/search.
 *
 * Same identity-keyed db mock pattern as documents-slice5.test.ts. The
 * search route runs three independent select chains (sections, documents,
 * highlights) plus one `= ANY(...)` doc-title lookup; the fake returns the
 * rows seeded for the table it was asked to select from, and the test
 * asserts the route's row→response mapping, auth/validation gates, and the
 * combined-OR/ts_rank SQL being passed to the db (as opaque drizzle
 * fragments — the real ranking runs in Postgres, covered by e2e).
 */
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { documents, highlights, sections } from "../db/schema.js";
import { SEARCH_MAX_Q } from "@reader/shared";
import type { AppConfig } from "../config.js";
import { registerSearch } from "./search.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const DOC_A = "22222222-2222-2222-2222-222222222222";
const DOC_B = "33333333-3333-3333-3333-333333333333";
const SECTION_1 = "44444444-4444-4444-4444-444444444444";
const SECTION_2 = "55555555-5555-5555-5555-555555555555";
const HL_ID = "99999999-9999-9999-9999-999999999999";
const TOKEN = "good-token";

const state = {
  rowsByTable: new Map<object, unknown[]>(),
  // Captured drizzle `sql` fragments (opaque objects) so tests can assert
  // the query shape without evaluating SQL.
  lastWhere: [] as unknown[],
};

function chain(rows: unknown[]) {
  const arr = [...rows] as unknown[] & {
    where: (w: unknown) => unknown;
    innerJoin: (t: object, _cond?: unknown) => unknown;
    groupBy: () => unknown;
    orderBy: () => unknown;
    limit: () => unknown;
  };
  arr.where = (w: unknown) => {
    state.lastWhere.push(w);
    return arr;
  };
  arr.innerJoin = () => arr;
  arr.groupBy = () => arr;
  arr.orderBy = () => arr;
  arr.limit = () => arr;
  return arr;
}

vi.mock("../db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: (t: object) => {
        const rows = state.rowsByTable.get(t) ?? [];
        return {
          where: (w: unknown) => {
            state.lastWhere.push(w);
            return chain(rows);
          },
          innerJoin: (_t: object, _cond?: unknown) => ({
            where: (w: unknown) => {
              state.lastWhere.push(w);
              const c = chain(rows);
              // groupBy is used by the documents branch; it must also be
              // chainable into orderBy/limit.
              c.groupBy = () => c;
              return c;
            },
          }),
        };
      },
    }),
  }),
}));

vi.mock("../services/session.js", () => ({
  SESSION_COOKIE: "rdr_session",
  authenticate: async (token: string, now: () => number) =>
    token === TOKEN && now() > 0
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

function sectionRow(over: Record<string, unknown> = {}) {
  return {
    id: SECTION_1,
    documentId: DOC_A,
    idx: 0,
    title: "Chapter One",
    language: "english",
    rank: 0.42,
    ...over,
  };
}

function docRow(over: Record<string, unknown> = {}) {
  return {
    id: DOC_A,
    type: "epub",
    title: "The Night Fox",
    author: "Ada Lovelace",
    language: "english",
    status: "inbox",
    rank: 0.51,
    ...over,
  };
}

function highlightRow(over: Record<string, unknown> = {}) {
  return {
    id: HL_ID,
    documentId: DOC_A,
    anchor: { kind: "reflow", v: 1, sectionId: SECTION_1, exact: "the quick brown fox", prefix: "", suffix: "", offsetHint: 0, canonicalTextVersion: 1 },
    exact: "the quick brown fox",
    color: "#fff176",
    note: null,
    documentTitle: "The Night Fox",
    rank: 0.33,
    ...over,
  };
}

function reset(...tables: [object, unknown[]][]) {
  state.rowsByTable = new Map(tables);
  state.lastWhere = [];
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie, {});
  await registerSearch(app, { config: makeConfig() });
  await app.ready();
  return app;
}

const cookie = { rdr_session: TOKEN };

/** Flattens a drizzle `sql` fragment's queryChunks into its SQL text (the
 *  fragment objects are opaque — `String(frag)` does not serialize them).
 *  Chunk shapes: string | { value: (string|Fragment)[] } | Fragment. */
function fragSql(frag: unknown): string {
  if (typeof frag === "string") return frag;
  const f = frag as { queryChunks?: unknown[] } | string | undefined;
  if (!f || typeof f !== "object") return "";
  if (!Array.isArray(f.queryChunks)) return "";
  return f.queryChunks
    .map((c: unknown) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object") {
        const v = (c as { value?: unknown }).value;
        if (Array.isArray(v)) return v.map(fragSql).join("");
        if (typeof v === "string") return v;
        return fragSql(c);
      }
      return "";
    })
    .join("");
}

beforeEach(() => reset());

describe("GET /v1/search", () => {
  it("401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/search?q=fox" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("400 when q is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/search", cookies: cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("400 when q is blank after trimming", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/search?q=%20%20", cookies: cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("400 when q exceeds the shared length cap", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/search?q=${"x".repeat(SEARCH_MAX_Q + 1)}`, cookies: cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("returns the three ranked lists mapped from the db rows", async () => {
    reset(
      [sections, [sectionRow(), sectionRow({ id: SECTION_2, documentId: DOC_B, title: "Kissa", language: "finnish" })]],
      [documents, [docRow(), docRow({ id: DOC_B, title: "Ikkuna", author: null, language: "finnish" })]],
      [highlights, [highlightRow({ documentId: DOC_B, documentTitle: "Ikkuna" })]],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/search?q=%20fox%20", cookies: cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      q: string;
      documents: Array<Record<string, unknown>>;
      sections: Array<Record<string, unknown>>;
      highlights: Array<Record<string, unknown>>;
    };
    // q is trimmed and echoed.
    expect(body.q).toBe("fox");
    expect(body.documents.length).toBe(2);
    expect(body.documents[0]).toMatchObject({ id: DOC_A, title: "The Night Fox", author: "Ada Lovelace", type: "epub", language: "english", status: "inbox" });
    expect(body.sections.length).toBe(2);
    expect(body.sections[0]).toMatchObject({ id: SECTION_1, documentId: DOC_A, documentTitle: "The Night Fox", idx: 0, title: "Chapter One", language: "english" });
    expect(body.sections[1]).toMatchObject({ id: SECTION_2, documentId: DOC_B, documentTitle: "Ikkuna", language: "finnish" });
    expect(body.highlights.length).toBe(1);
    expect(body.highlights[0]).toMatchObject({
      id: HL_ID,
      documentId: DOC_B,
      documentTitle: "Ikkuna",
      sectionId: SECTION_1,
      exact: "the quick brown fox",
      color: "#fff176",
      note: null,
    });
    // ranks survive the round-trip as numbers
    expect(typeof body.documents[0]!.rank).toBe("number");
    expect(typeof body.sections[0]!.rank).toBe("number");
    expect(typeof body.highlights[0]!.rank).toBe("number");
  });

  it("returns empty lists when nothing matches", async () => {
    reset([sections, []], [documents, []], [highlights, []]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/search?q=zzz", cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ q: "zzz", documents: [], sections: [], highlights: [] });
  });

  it("skips the doc-title lookup when no section matched", async () => {
    reset([sections, []], [documents, []], [highlights, []]);
    const app = await buildApp();
    // The route runs 3 chains; with zero section rows the 4th (`= ANY`) is skipped.
    await app.inject({ method: "GET", url: "/v1/search?q=zzz", cookies: cookie });
    const anyLookups = state.lastWhere.filter((w) => String(w).includes("ANY"));
    expect(anyLookups.length).toBe(0);
  });

  it("highlights without a reflow anchor map sectionId to null", async () => {
    reset(
      [sections, []],
      [documents, []],
      [highlights, [highlightRow({ anchor: { kind: "pdf", v: 1, page: 3, exact: "fox page" } })]],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/search?q=fox", cookies: cookie });
    expect(res.json().highlights[0]!.sectionId).toBeNull();
  });

  it("passes a combined-OR websearch tsquery into every match clause", async () => {
    reset([sections, []], [documents, []], [highlights, []]);
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/v1/search?q=fox", cookies: cookie });
    // The route's three where clauses (sections, documents, highlights) each
    // embed the combined fragment: three websearch_to_tsquery configs OR'd,
    // with the query value inlined (drizzle serializes the fragment into the
    // SQL text). Assert on the flattened SQL, not the opaque fragment.
    const orClauses = state.lastWhere.filter((w) => {
      const s = fragSql(w);
      return (
        s.includes("websearch_to_tsquery('english', fox") &&
        s.includes("websearch_to_tsquery('finnish', fox") &&
        s.includes("websearch_to_tsquery('simple', fox")
      );
    });
    expect(orClauses.length).toBe(3);
    // Each combined clause is used as a boolean match (vector @@ tsquery).
    for (const w of orClauses) expect(fragSql(w)).toContain("@@");
  });
});
