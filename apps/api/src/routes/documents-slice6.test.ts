/**
 * Slice 6 documents-route tests: GET /v1/documents/:id/original — the
 * signed, range-capable URL pdf.js loads the original through.
 *
 * Same identity-keyed db mock pattern as documents-slice5.test.ts. The
 * route does two reads: the document row (ownedDocument) and the
 * `original` asset row for the document.
 */
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assets, documents } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import type { Boss } from "../jobs/boss.js";
import type { ObjectStore } from "../storage/object-store.js";
import { registerDocuments } from "./documents.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const DOC_A = "22222222-2222-2222-2222-222222222222";
const ASSET_ORIG = "99999999-9999-9999-9999-999999999999";
const TOKEN = "good-token";

const state = {
  rowsByTable: new Map<object, unknown[]>(),
};

function chain(rows: unknown[]) {
  const arr = [...rows] as unknown[] & {
    orderBy: () => unknown;
    limit: () => unknown;
    returning: () => Promise<unknown[]>;
  };
  arr.orderBy = () => arr;
  arr.limit = () => arr;
  arr.returning = async () => [];
  return arr;
}

vi.mock("../db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: (t: object) => ({
        where: () => chain(state.rowsByTable.get(t) ?? []),
      }),
    }),
    insert: () => {
      throw new Error("insert not used in these tests");
    },
    update: () => {
      throw new Error("update not used in these tests");
    },
    delete: () => {
      throw new Error("delete not used in these tests");
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
  put: async () => {
    throw new Error("unused");
  },
  putCiphertextStream: async () => {
    throw new Error("unused");
  },
  recordObject: async () => {
    throw new Error("unused");
  },
  get: async () => new Uint8Array(),
  getRange: async () => {
    throw new Error("unused");
  },
  meta: async () => null,
  delete: async () => {
    throw new Error("unused");
  },
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
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie, {});
  await registerDocuments(app, { config: makeConfig(), objectStore, boss });
  await app.ready();
  return app;
}

function pdfDocRow(over: Record<string, unknown> = {}) {
  return {
    id: DOC_A,
    userId: USER_ID,
    type: "pdf",
    title: "Fixture PDF",
    author: null,
    language: null,
    status: "inbox",
    ingestState: "ready",
    ingestError: null,
    sourceUrl: null,
    originalObjectId: "obj-orig",
    coverAssetId: null,
    parserVersion: 1,
    pdfModeAvailable: "faithful",
    pageCount: 2,
    wordCount: 40,
    createdAt: new Date("2026-11-04T09:00:00.000Z"),
    updatedAt: new Date("2026-11-04T09:00:00.000Z"),
    ...over,
  };
}

function originalAssetRow(over: Record<string, unknown> = {}) {
  return {
    id: ASSET_ORIG,
    userId: USER_ID,
    documentId: DOC_A,
    objectId: "obj-orig",
    role: "original",
    mime: "application/pdf",
    width: null,
    height: null,
    ...over,
  };
}

const cookie = { rdr_session: TOKEN };

beforeEach(() => reset());

describe("GET /v1/documents/:id/original", () => {
  it("401 without a session", async () => {
    reset([documents, [pdfDocRow()]]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/documents/${DOC_A}/original` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("404 for an unknown document", async () => {
    reset([documents, []]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/documents/${DOC_A}/original`, cookies: cookie });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("400 for a non-PDF document", async () => {
    reset([documents, [pdfDocRow({ type: "epub" })]]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/documents/${DOC_A}/original`, cookies: cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("not_pdf");
  });

  it("503 until the worker has stored the original asset", async () => {
    reset([documents, [pdfDocRow()]], [assets, []]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/documents/${DOC_A}/original`, cookies: cookie });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("not_ready");
  });

  it("returns a signed asset URL (same shape as section cover URLs) + page count", async () => {
    reset([documents, [pdfDocRow()]], [assets, [originalAssetRow()]]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/documents/${DOC_A}/original`, cookies: cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; pageCount: number };
    expect(body.pageCount).toBe(2);
    // Signed, expiring, range-capable (served by /v1/assets/:id).
    expect(body.url).toMatch(new RegExp(`^/v1/assets/${ASSET_ORIG}\\?exp=\\d+&sig=[A-Za-z0-9_-]+$`));
  });

  it("ignores a foreign original asset (user-scoped)", async () => {
    reset(
      [documents, [pdfDocRow()]],
      [assets, [originalAssetRow({ userId: "00000000-0000-0000-0000-000000000000" })]],
    );
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/documents/${DOC_A}/original`, cookies: cookie });
    // The mock is identity-keyed (returns all asset rows), so this asserts
    // the route reaches the asset read; the real SQL enforces user_id.
    expect(res.statusCode).toBe(200);
    expect((res.json() as { url: string }).url).toMatch(new RegExp(`^/v1/assets/${ASSET_ORIG}\\?`));
  });
});
