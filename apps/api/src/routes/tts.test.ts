/**
 * Slice 7 TTS route tests: GET …/tts-chunks, POST /v1/tts, and the signed
 * GET /v1/tts-audio/:cacheKey. Same identity-keyed db mock as the other
 * route tests; objectStore/boss are fakes.
 */
import { createHash } from "node:crypto";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASSET_URL_LABEL, deriveSubkey, signAsset } from "@reader/shared";
import { documents, sections, ttsCache, userSettings } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import type { Boss } from "../jobs/boss.js";
import type { ObjectStore } from "../storage/object-store.js";
import { registerTts } from "./tts.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const DOC_A = "22222222-2222-2222-2222-222222222222";
const SECTION_1 = "44444444-4444-4444-4444-444444444444";
const OBJECT_ID = "66666666-6666-6666-6666-666666666666";
const TOKEN = "good-token";
const MASTER_KEY = new Uint8Array(32).fill(7);

const state = {
  rowsByTable: new Map<object, unknown[]>(),
  bossSend: { queue: undefined as string | undefined, data: undefined as unknown, opts: undefined as unknown },
  objectStore: {
    get: async (_id: string) => new TextEncoder().encode("<p>One. Two! Three? Four.</p>"),
    meta: async (_id: string) => ({ wrappedDek: new Uint8Array(32), plainSize: 100, keyVersion: 1 }) as never,
    getRange: async (_id: string, start: number, end: number) => new Uint8Array([1, 2, 3]).subarray(0, end - start),
  },
};

function chain(rows: unknown[]) {
  const arr = [...rows] as unknown[] & { limit: () => unknown };
  arr.limit = () => arr;
  return arr;
}

vi.mock("../db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: (t: object) => ({
        where: () => chain(state.rowsByTable.get(t) ?? []),
        limit: () => chain(state.rowsByTable.get(t) ?? []),
      }),
    }),
  }),
}));

vi.mock("../services/session.js", () => ({
  SESSION_COOKIE: "rdr_session",
  authenticate: async (token: string) =>
    token === TOKEN
      ? { user: { id: USER_ID, email: "a@b.c", createdAt: new Date(0) }, sessionId: "sess-1", kind: "web", expiresAt: new Date(Date.now() + 86400_000) }
      : null,
}));

/** Deterministic stand-in for the section HTML → canonical text walk. */
const FAKE_CANONICALIZE = (_html: string) => "One.\nTwo!\nThree?\nFour.";

function fakeBoss(): Boss {
  return {
    send: async (queue: string, data: unknown, opts?: unknown) => {
      state.bossSend = { queue, data, opts };
    },
  } as unknown as Boss;
}

function makeConfig(): AppConfig {
  return {
    masterKey: MASTER_KEY,
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
  await registerTts(app, {
    config: makeConfig(),
    objectStore: state.objectStore as unknown as ObjectStore,
    boss: fakeBoss(),
    canonicalize: FAKE_CANONICALIZE,
  });
  await app.ready();
  return app;
}

function reset(...tables: [object, unknown[]][]) {
  state.rowsByTable = new Map(tables);
  state.bossSend = { queue: undefined, data: undefined, opts: undefined };
}

const cookie = { rdr_session: TOKEN };
const bearer = { authorization: `Bearer ${TOKEN}` };
const csrf = { "x-requested-with": "reader", origin: "https://reader.test" };

const READY_DOC = { id: DOC_A, ingestState: "ready", userId: USER_ID };
const SECTION_ROW = {
  id: SECTION_1,
  documentId: DOC_A,
  userId: USER_ID,
  htmlObjectId: OBJECT_ID,
  title: "S",
  order: 0,
};

function cacheKeyOf(text: string, model = "gpt-4o-mini-tts", voice = "alloy") {
  return createHash("sha256").update(`1|${model}|${voice}|${text}`, "utf8").digest("hex");
}

beforeEach(() => reset());

describe("GET /v1/documents/:id/sections/:sid/tts-chunks", () => {
  it("401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/documents/${DOC_A}/sections/${SECTION_1}/tts-chunks` });
    expect(res.statusCode).toBe(401);
  });

  it("404 for a document that is not ready", async () => {
    reset([documents, [{ ...READY_DOC, ingestState: "processing" }]], [sections, [SECTION_ROW]]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/documents/${DOC_A}/sections/${SECTION_1}/tts-chunks`,
      cookies: cookie,
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists chunk offsets (never the text) with the user's model/voice", async () => {
    reset([documents, [READY_DOC]], [sections, [SECTION_ROW]]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/v1/documents/${DOC_A}/sections/${SECTION_1}/tts-chunks`,
      cookies: cookie,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe("gpt-4o-mini-tts");
    expect(body.voice).toBe("alloy");
    expect(body.chunks.length).toBe(4);
    for (const c of body.chunks) {
      expect(c).toHaveProperty("index");
      expect(c).toHaveProperty("startOffset");
      expect(c).toHaveProperty("endOffset");
      expect(c).not.toHaveProperty("text");
    }
    // The spans must cover the canonical text "One.\nTwo!\nThree?\nFour."
    expect(body.chunks[0]).toMatchObject({ index: 0, startOffset: 0, endOffset: 4 });
    expect(body.chunks[3]).toMatchObject({ index: 3, startOffset: 17, endOffset: 22 });
  });
});

describe("POST /v1/tts", () => {
  const CHUNK = "One.";

  it("401 without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/tts",
      payload: { documentId: DOC_A, sectionId: SECTION_1, chunkIndex: 0 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400 for a body without a sectionId", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/tts",
      payload: { documentId: DOC_A, chunkIndex: 0 },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(400);
  });

  it("409 when the user has no OpenAI key", async () => {
    reset([documents, [READY_DOC]], [sections, [SECTION_ROW]], [userSettings, [{ userId: USER_ID }]]);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/tts",
      payload: { documentId: DOC_A, sectionId: SECTION_1, chunkIndex: 0 },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("no_openai_key");
  });

  it("returns the signed url on a cache hit", async () => {
    const key = cacheKeyOf(CHUNK);
    reset(
      [documents, [READY_DOC]],
      [sections, [SECTION_ROW]],
      [userSettings, [{ userId: USER_ID, openaiKeyEnc: "enc", openaiKeyLast4: "abcd" }]],
      [ttsCache, [{ cacheKey: key, userId: USER_ID, objectId: OBJECT_ID, createdAt: new Date() }]],
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/tts",
      payload: { documentId: DOC_A, sectionId: SECTION_1, chunkIndex: 0 },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ready");
    expect(body.url).toContain(`/v1/tts-audio/${key}?exp=`);
    expect(body.url).toContain("sig=");
    expect(state.bossSend.queue).toBeUndefined();
  });

  it("queues a tts.chunk job with the cache key as singleton key", async () => {
    reset(
      [documents, [READY_DOC]],
      [sections, [SECTION_ROW]],
      [userSettings, [{ userId: USER_ID, openaiKeyEnc: "enc", openaiKeyLast4: "abcd" }]],
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/tts",
      payload: { documentId: DOC_A, sectionId: SECTION_1, chunkIndex: 0 },
      cookies: cookie,
      headers: csrf,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "processing" });
    const key = cacheKeyOf(CHUNK);
    expect(state.bossSend.queue).toBe("tts.chunk");
    expect(state.bossSend.data).toMatchObject({
      userId: USER_ID,
      cacheKey: key,
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      chunkText: CHUNK,
    });
    expect(state.bossSend.opts).toMatchObject({ singletonKey: key, singletonMinutes: expect.any(Number) });
  });
});

describe("GET /v1/tts-audio/:cacheKey", () => {
  const key = cacheKeyOf("One.");

  it("403 for an unknown cache key", async () => {
    reset([ttsCache, []]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/tts-audio/${key}?exp=123&sig=x` });
    expect(res.statusCode).toBe(403);
  });

  it("403 for a bad signature", async () => {
    reset([ttsCache, [{ cacheKey: key, userId: USER_ID, objectId: OBJECT_ID, createdAt: new Date() }]]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/v1/tts-audio/${key}?exp=123&sig=x` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("bad_signature");
  });

  it("503 when the row exists but has no object yet", async () => {
    reset([ttsCache, [{ cacheKey: key, userId: USER_ID, objectId: null, createdAt: new Date() }]]);
    const app = await buildApp();
    // A VALID signature (bound to key + USER_ID) is needed to get past the
    // 403 check and reach the not-ready branch.
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sig = signAsset(key, USER_ID, exp, deriveSubkey(MASTER_KEY, ASSET_URL_LABEL));
    const res = await app.inject({ method: "GET", url: `/v1/tts-audio/${key}?exp=${exp}&sig=${sig}` });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("not_ready");
  });
});
