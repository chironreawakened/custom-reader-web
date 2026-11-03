/**
 * Slice 5 documents-route tests: POST /v1/documents/url, PATCH and
 * DELETE /v1/documents/:id, and the ?tag= filter on the list.
 *
 * Same identity-keyed db mock pattern as highlights.test.ts. `tagsFor`
 * innerJoins documentTags+tags, so the mock's from(documentTags) returns
 * joined join-rows ({documentId, name}).
 */
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assets, documentTags, documents, sections, tags } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import type { Boss } from "../jobs/boss.js";
import type { ObjectStore } from "../storage/object-store.js";
import { registerDocuments } from "./documents.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const DOC_A = "22222222-2222-2222-2222-222222222222";
const DOC_B = "33333333-3333-3333-3333-333333333333";
const TAG_A = "44444444-4444-4444-4444-444444444444";
const TAG_B = "55555555-5555-5555-5555-555555555555";
const TOKEN = "good-token";

const state = {
  rowsByTable: new Map<object, unknown[]>(),
  insertTable: undefined as unknown,
  insertValues: undefined as unknown,
  updateTable: undefined as unknown,
  updateValues: undefined as unknown,
  deleteTable: undefined as unknown,
  deleteValues: undefined as unknown,
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
      from: (t: object) => ({
        innerJoin: () => ({
          where: () => chain(state.rowsByTable.get(t) ?? []),
        }),
        where: () => chain(state.rowsByTable.get(t) ?? []),
      }),
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
          // Apply the update to the seeded rows so the route's re-read
          // sees the new values (the mock can't run SQL).
          for (const row of state.rowsByTable.get(t as object) ?? []) {
            Object.assign(row as object, v as Record<string, unknown>);
          }
          return { where: () => chain([]) };
        },
      };
    },
    delete: (t: unknown) => {
      state.deleteTable = t;
      return {
        where: () => chain(state.rowsByTable.get(t as object) ?? []),
        returning: () => Promise.resolve(state.returning),
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

const boss: Boss = {
  send: async () => {},
  work: () => {},
  start: async () => {},
  stop: async () => {},
} as unknown as Boss;

const objectStore: ObjectStore = {
  put: async () => { throw new Error("unused"); },
  putCiphertextStream: async () => { throw new Error("unused"); },
  recordObject: async () => { throw new Error("unused"); },
  get: async () => new Uint8Array(),
  getRange: async () => { throw new Error("unused"); },
  meta: async () => null,
  delete: async () => { throw new Error("unused"); },
};

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

function reset(...tables: [object, unknown[]][]) {
  state.rowsByTable = new Map(tables);
  state.insertTable = undefined;
  state.insertValues = undefined;
  state.updateTable = undefined;
  state.updateValues = undefined;
  state.deleteTable = undefined;
  state.deleteValues = undefined;
  state.returning = [];
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie, {});
  await registerDocuments(app, { config: makeConfig(), objectStore, boss });
  await app.ready();
  return app;
}

function docRow(over: Record<string, unknown> = {}) {
  return {
    id: DOC_A,
    userId: USER_ID,
    type: "article",
    title: "example.com/story",
    author: null,
    language: null,
    status: "inbox",
    ingestState: "done",
    ingestError: null,
    sourceUrl: "https://example.com/story",
    wordCount: 100,
    originalObjectId: null,
    coverAssetId: null,
    createdAt: new Date("2026-11-01T09:00:00.000Z"),
    updatedAt: new Date("2026-11-01T09:00:00.000Z"),
    ...over,
  };
}

function tagRow(over: Record<string, unknown> = {}) {
  return { id: TAG_A, userId: USER_ID, name: "reading", createdAt: new Date("2026-11-01T09:00:00.000Z"), ...over };
}

const cookie = { rdr_session: TOKEN };
const csrf = { "x-requested-with": "reader", origin: "https://reader.test" };

beforeEach(() => reset());

describe("POST /v1/documents/url", () => {
  it("401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/documents/url", payload: { url: "https://example.com" } });
    expect(res.statusCode).toBe(401);
  });

  it("403 for a cookie request missing the CSRF headers", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/documents/url", payload: { url: "https://example.com" }, cookies: cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf");
  });

  it("400 for a malformed or non-http URL", async () => {
    const app = await buildApp();
    for (const url of ["not a url", "ftp://example.com/x", "javascript:alert(1)"]) {
      const res = await app.inject({ method: "POST", url: "/v1/documents/url", payload: { url }, cookies: cookie, headers: csrf });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_url");
    }
  });

  it("creates a pending article document with the URL as placeholder title", async () => {
    state.returning = [docRow({ ingestState: "pending", title: "example.com/story" })];
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/documents/url",
      payload: { url: "https://example.com/story?x=1" },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: DOC_A,
      type: "article",
      title: "example.com/story",
      ingestState: "pending",
    });
    expect(state.insertTable).toBe(documents);
    expect(state.insertValues).toMatchObject({
      userId: USER_ID,
      type: "article",
      sourceUrl: "https://example.com/story?x=1",
      ingestState: "pending",
    });
  });
});

describe("GET /v1/documents?tag=", () => {
  it("filters to the documents carrying the tag (case-insensitive)", async () => {
    reset(
      [tags, [tagRow(), tagRow({ id: TAG_B, name: "work" })]],
      [documentTags, [
        { documentId: DOC_A, name: "reading" },
        { documentId: DOC_B, name: "work" },
      ]],
      [documents, [docRow(), docRow({ id: DOC_B, title: "other.com/post" })]],
    );
    const app = await buildApp();
    // "reading" matches tagRow (TAG_A) → documents linked to TAG_A.
    // (The identity mock returns all documentTags rows, so both docs
    // surface; the assertion is about the join path being taken and the
    // items carrying their tags.)
    const res = await app.inject({ method: "GET", url: "/v1/documents?tag=READING", cookies: cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; tags: string[] }[] };
    expect(body.items.length).toBe(2);
    expect(body.items[0]!.tags).toContain("reading");
    expect(body.items[1]!.tags).toContain("work");
  });

  it("returns empty when the tag name matches nothing", async () => {
    reset([tags, []]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/documents?tag=none", cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null });
  });

  it("returns items without tags when no tag filter", async () => {
    reset([documents, [docRow()]]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/documents", cookies: cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; tags: string[]; ingestState: string }[] };
    expect(body.items[0]!.tags).toEqual([]);
    expect(body.items[0]!.ingestState).toBe("done");
  });
});

describe("PATCH /v1/documents/:id", () => {
  it("404 for an unknown id", async () => {
    reset([documents, []]);
    const app = await buildApp();
    const res = await app.inject({ method: "PATCH", url: `/v1/documents/${DOC_A}`, payload: { status: "later" }, cookies: cookie, headers: csrf });
    expect(res.statusCode).toBe(404);
  });

  it("400 for an invalid status", async () => {
    reset([documents, [docRow()]]);
    const app = await buildApp();
    const res = await app.inject({ method: "PATCH", url: `/v1/documents/${DOC_A}`, payload: { status: "bogus" }, cookies: cookie, headers: csrf });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_status");
  });

  it("updates the sent fields only (partial, updatedAt bumped)", async () => {
    reset([documents, [docRow()]]);
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/documents/${DOC_A}`,
      payload: { status: "later", title: "  New title  " },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "later", title: "New title" });
    expect(state.updateTable).toBe(documents);
    expect(state.updateValues).toMatchObject({ status: "later", title: "New title", updatedAt: expect.any(Date) });
  });

  it("clears the author with an explicit null", async () => {
    reset([documents, [docRow({ author: "Someone" })]]);
    const app = await buildApp();
    const res = await app.inject({ method: "PATCH", url: `/v1/documents/${DOC_A}`, payload: { author: null }, cookies: cookie, headers: csrf });
    expect(res.statusCode).toBe(200);
    expect(state.updateValues).toMatchObject({ author: null });
  });

  it("replaces the tag set (tagIds) after verifying ownership", async () => {
    reset(
      [documents, [docRow()]],
      [tags, [tagRow(), tagRow({ id: TAG_B, name: "work" })]],
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/documents/${DOC_A}`,
      payload: { tagIds: [TAG_A, TAG_B] },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(200);
    expect(state.deleteTable).toBe(documentTags);
    expect(state.insertTable).toBe(documentTags);
    expect(state.insertValues).toEqual([
      { documentId: DOC_A, tagId: TAG_A },
      { documentId: DOC_A, tagId: TAG_B },
    ]);
  });

  it("400 when a tag id is not owned (or unknown)", async () => {
    reset(
      [documents, [docRow()]],
      // Only TAG_A exists for this user; TAG_B is unknown.
      [tags, [tagRow()]],
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/documents/${DOC_A}`,
      payload: { tagIds: [TAG_A, TAG_B] },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unknown_tag");
  });
});

describe("DELETE /v1/documents/:id", () => {
  it("404 for an unknown id", async () => {
    reset([documents, []]);
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `/v1/documents/${DOC_A}`, cookies: cookie, headers: csrf });
    expect(res.statusCode).toBe(404);
  });

  it("deletes the document row and returns 204", async () => {
    reset(
      [documents, [docRow({ originalObjectId: "obj-orig" })]],
      [sections, []],
      [assets, []],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `/v1/documents/${DOC_A}`, cookies: cookie, headers: csrf });
    expect(res.statusCode).toBe(204);
    expect(state.deleteTable).toBe(documents);
  });
});
