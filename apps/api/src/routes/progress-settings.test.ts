import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readingProgress, userSettings } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { registerProgressSettings } from "./progress-settings.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const DOC_A = "22222222-2222-2222-2222-222222222222";
const DOC_B = "33333333-3333-3333-3333-333333333333";
const SECTION_1 = "44444444-4444-4444-4444-444444444444";
const SECTION_2 = "55555555-5555-5555-5555-555555555555";
const TOKEN = "good-token";

/** Mutable fake standing in for the drizzle db (getDb is mocked). */
const state = {
  rows: [] as unknown[],
  from: undefined as unknown,
  where: undefined as unknown,
  insertTable: undefined as unknown,
  insertValues: undefined as unknown,
  onConflict: undefined as unknown,
};

vi.mock("../db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: (t: unknown) => {
        state.from = t;
        return {
          where: async (w: unknown) => {
            state.where = w;
            return state.rows;
          },
        };
      },
    }),
    insert: (t: unknown) => {
      state.insertTable = t;
      return {
        values: (v: unknown) => {
          state.insertValues = v;
          return {
            onConflictDoUpdate: (o: unknown) => {
              state.onConflict = o;
              return { then: (res: (v?: unknown) => unknown) => Promise.resolve().then(() => res?.()) };
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

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie, {});
  await registerProgressSettings(app, { config: makeConfig() });
  await app.ready();
  return app;
}

function reset(rows: unknown[] = []) {
  state.rows = rows;
  state.from = undefined;
  state.where = undefined;
  state.insertTable = undefined;
  state.insertValues = undefined;
  state.onConflict = undefined;
}

const cookie = { rdr_session: TOKEN };
const bearer = { authorization: `Bearer ${TOKEN}` };
const csrf = { "x-requested-with": "reader", origin: "https://reader.test" };

beforeEach(() => reset());

describe("GET /v1/progress/:documentId", () => {
  it("401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/progress/${DOC_A}` });
    expect(res.statusCode).toBe(401);
  });

  it("400 for a non-uuid documentId", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/progress/not-a-uuid", cookies: cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("returns nulls when the document was never opened", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/progress/${DOC_A}`, cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ locator: null, updatedAt: null });
  });

  it("returns the stored locator and updatedAt", async () => {
    reset([
      {
        userId: USER_ID,
        documentId: DOC_A,
        locator: { kind: "reflow", sectionId: SECTION_1, offset: 12, percent: 0.4 },
        updatedAt: new Date("2026-10-30T12:00:00.000Z"),
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/progress/${DOC_A}`, cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      locator: { kind: "reflow", sectionId: SECTION_1, offset: 12, percent: 0.4 },
      updatedAt: "2026-10-30T12:00:00.000Z",
    });
  });
});

describe("PUT /v1/progress/:documentId", () => {
  const body = {
    locator: { kind: "reflow", sectionId: SECTION_2, offset: 7, percent: 0.55 },
    updatedAt: "2026-10-31T10:00:00.000Z",
  };

  it("401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "PUT", url: `/v1/progress/${DOC_A}`, payload: body });
    expect(res.statusCode).toBe(401);
  });

  it("403 for a cookie request missing the CSRF headers", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "PUT", url: `/v1/progress/${DOC_A}`, payload: body, cookies: cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf");
  });

  it("400 for a malformed locator body", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/progress/${DOC_A}`,
      payload: { locator: { kind: "reflow", sectionId: SECTION_2 }, updatedAt: "2026-10-31T10:00:00.000Z" },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(400);
  });

  it("409 when the stored progress is newer (last write wins)", async () => {
    reset([
      {
        userId: USER_ID,
        documentId: DOC_A,
        locator: { kind: "reflow", sectionId: "s9", offset: 1, percent: 99 },
        updatedAt: new Date("2026-10-31T11:00:00.000Z"), // newer than the request
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/progress/${DOC_A}`,
      payload: body,
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
    expect(state.insertTable).toBeUndefined();
  });

  it("upserts on a fresh write (cookie + CSRF)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/progress/${DOC_A}`,
      payload: body,
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ locator: body.locator, updatedAt: "2026-10-31T10:00:00.000Z" });
    expect(state.insertTable).toBe(readingProgress);
    expect(state.insertValues).toMatchObject({ userId: USER_ID, documentId: DOC_A, locator: body.locator });
    expect(state.onConflict).toMatchObject({ target: [readingProgress.userId, readingProgress.documentId] });
  });

  it("exempts bearer-only requests from CSRF", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/progress/${DOC_B}`,
      payload: body,
      headers: bearer,
    });
    expect(res.statusCode).toBe(200);
    expect(state.insertValues).toMatchObject({ documentId: DOC_B });
  });
});

describe("GET /v1/settings", () => {
  it("401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/settings" });
    expect(res.statusCode).toBe(401);
  });

  it("returns DEFAULT_READER_PREFS when no row exists", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/settings", cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ readerPrefs: { theme: "light", fontSize: 16 } });
  });

  it("returns the stored readerPrefs", async () => {
    reset([{ userId: USER_ID, readerPrefs: { theme: "sepia", fontSize: 18 } }]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/settings", cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ readerPrefs: { theme: "sepia", fontSize: 18 } });
  });
});

describe("PUT /v1/settings", () => {
  it("403 for a cookie request missing the CSRF headers", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings",
      payload: { readerPrefs: { theme: "dark", fontSize: 100 } },
      cookies: cookie,
    });
    expect(res.statusCode).toBe(403);
  });

  it("400 for an invalid theme or font size", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings",
      payload: { readerPrefs: { theme: "neon", fontSize: 16 } },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(400);
  });

  it("upserts and echoes the prefs (cookie + CSRF)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/settings",
      payload: { readerPrefs: { theme: "dark", fontSize: 20 } },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ readerPrefs: { theme: "dark", fontSize: 20 } });
    expect(state.insertTable).toBe(userSettings);
    expect(state.insertValues).toMatchObject({ userId: USER_ID, readerPrefs: { theme: "dark", fontSize: 20 } });
    expect(state.onConflict).toMatchObject({ target: [userSettings.userId] });
  });
});
