/**
 * Slice 5 tags route tests.
 *
 * The db mock follows the same identity-keyed pattern as highlights.test.ts:
 * `select().from(table)` returns that table's rows (where/orderBy/limit are
 * no-ops), so ownership + lookup assertions come down to which rows were
 * seeded. The tags routes do not use innerJoin.
 */
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tags } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { registerTags } from "./tags.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const TAG_A = "22222222-2222-2222-2222-222222222222";
const TOKEN = "good-token";

const state = {
  rowsByTable: new Map<object, unknown[]>(),
  /** Per-call select results (e.g. the race test: first lookup empty,
   *  re-lookup after the insert finds the winner). */
  selectSeq: new Map<object, unknown[][]>(),
  selectCall: new Map<object, number>(),
  insertTable: undefined as unknown,
  insertValues: undefined as unknown,
  deleteTable: undefined as unknown,
  returning: [] as unknown[],
  insertError: undefined as Error | undefined,
};

function rowsForSelect(t: object): unknown[] {
  const seq = state.selectSeq.get(t);
  if (seq) {
    const i = Math.min(state.selectCall.get(t) ?? 0, seq.length - 1);
    state.selectCall.set(t, (state.selectCall.get(t) ?? 0) + 1);
    return seq[i]!;
  }
  return state.rowsByTable.get(t) ?? [];
}

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
        where: () => chain(rowsForSelect(t)),
      }),
    }),
    insert: (t: unknown) => {
      state.insertTable = t;
      return {
        values: (v: unknown) => {
          state.insertValues = v;
          return {
            returning: async () => {
              if (state.insertError) throw state.insertError;
              return state.returning;
            },
          };
        },
      };
    },
    delete: (t: unknown) => {
      state.deleteTable = t;
      return {
        where: () => chain(rowsForSelect(t as object)),
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

function reset(...tables: [object, unknown[]][]) {
  state.rowsByTable = new Map(tables);
  state.selectSeq = new Map();
  state.selectCall = new Map();
  state.insertTable = undefined;
  state.insertValues = undefined;
  state.deleteTable = undefined;
  state.returning = [];
  state.insertError = undefined;
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie, {});
  await registerTags(app, { config: makeConfig() });
  await app.ready();
  return app;
}

function tagRow(over: Record<string, unknown> = {}) {
  return {
    id: TAG_A,
    userId: USER_ID,
    name: "reading",
    createdAt: new Date("2026-11-01T09:00:00.000Z"),
    ...over,
  };
}

const cookie = { rdr_session: TOKEN };
const csrf = { "x-requested-with": "reader", origin: "https://reader.test" };

beforeEach(() => reset());

describe("GET /v1/tags", () => {
  it("401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/tags" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the user's tags", async () => {
    reset([tags, [tagRow()]]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/tags", cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [{ id: TAG_A, name: "reading", createdAt: "2026-11-01T09:00:00.000Z" }],
    });
  });
});

describe("POST /v1/tags", () => {
  it("401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/tags", payload: { name: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("403 for a cookie request missing the CSRF headers", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/tags", payload: { name: "x" }, cookies: cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf");
  });

  it("400 for an empty or over-long name", async () => {
    const app = await buildApp();
    for (const name of ["", "x".repeat(65)]) {
      const res = await app.inject({ method: "POST", url: "/v1/tags", payload: { name }, cookies: cookie, headers: csrf });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_tag");
    }
    expect(state.insertTable).toBeUndefined();
  });

  it("inserts a new tag", async () => {
    // No existing rows → the idempotency lookup is empty → insert.
    state.returning = [tagRow()];
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/tags", payload: { name: "reading" }, cookies: cookie, headers: csrf });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: TAG_A, name: "reading", createdAt: "2026-11-01T09:00:00.000Z" });
    expect(state.insertTable).toBe(tags);
    expect(state.insertValues).toMatchObject({ userId: USER_ID, name: "reading" });
  });

  it("is idempotent: an existing tag is returned without inserting", async () => {
    reset([tags, [tagRow()]]);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/tags", payload: { name: "reading" }, cookies: cookie, headers: csrf });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: TAG_A, name: "reading", createdAt: "2026-11-01T09:00:00.000Z" });
    expect(state.insertTable).toBeUndefined();
  });

  it("returns the winner on a unique-index race", async () => {
    // First lookup (idempotency): empty. Insert throws the unique-violation.
    // Re-lookup after the race: the winner exists.
    state.selectSeq.set(tags, [[], [tagRow()]]);
    state.insertError = new Error('duplicate key value violates unique constraint "tags_user_name_unique"');
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/tags", payload: { name: "reading" }, cookies: cookie, headers: csrf });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(TAG_A);
  });
});

describe("DELETE /v1/tags/:id", () => {
  it("404 for an unknown tag", async () => {
    reset([tags, []]);
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `/v1/tags/${TAG_A}`, cookies: cookie, headers: csrf });
    expect(res.statusCode).toBe(404);
  });

  it("deletes and returns 204", async () => {
    reset([tags, [tagRow()]]);
    state.returning = [{ id: TAG_A }];
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: `/v1/tags/${TAG_A}`, cookies: cookie, headers: csrf });
    expect(res.statusCode).toBe(204);
    expect(state.deleteTable).toBe(tags);
  });
});
