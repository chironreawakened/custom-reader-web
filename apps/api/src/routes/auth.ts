import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import {
  deriveSubkey,
  OTP_HMAC_LABEL,
  requestCodeBody,
  verifyCodeBody,
  type MeResponse,
} from "@reader/shared";
import type { Mailer } from "../services/mailer.js";
import { createMailer } from "../services/mailer.js";
import { SlidingWindowLimiter } from "../services/rate-limit.js";
import { csrfOk } from "../services/csrf.js";
import {
  requestCode as otpRequest,
  verifyCode as otpVerify,
  findUserByEmail,
} from "../services/otp.js";
import {
  authenticate,
  createSession,
  revokeById,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "../services/session.js";

/** Uniform error shape (SPECS §12): { error: { code, message } }. */
function err(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

export interface AuthContext {
  config: AppConfig;
  /** Injected for unit tests; production leaves it undefined to use config's mailer. */
  mailer?: Mailer;
  /** Injected to make rate-limit/session windows deterministic in tests. */
  now?: () => number;
}

export async function registerAuth(app: FastifyInstance, ctx: AuthContext) {
  const config = ctx.config;
  const otpSubkey = deriveSubkey(config.masterKey, OTP_HMAC_LABEL);

  const reqIp = new SlidingWindowLimiter(5, 15 * 60 * 1000); // 5 / 15 min per IP
  const reqEmail = new SlidingWindowLimiter(5, 60 * 60 * 1000); // 5 / hour per email
  const verifyIp = new SlidingWindowLimiter(20, 15 * 60 * 1000); // 20 / 15 min per IP
  const now = () => (ctx.now ? ctx.now() : Date.now());

  // Create the mailer once at startup (async nodemailer load in production).
  const mailer: Mailer = ctx.mailer ?? (await createMailer(config));

  // Periodic prune keeps the limiter maps bounded.
  const pruner = setInterval(() => {
    reqIp.prune();
    reqEmail.prune();
    verifyIp.prune();
  }, 60_000);
  pruner.unref?.();
  app.addHook("onClose", async () => clearInterval(pruner));

  // ---- POST /v1/auth/request-code ------------------------------------------
  app.post("/v1/auth/request-code", async (req, reply) => {
    const parsed = requestCodeBody.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, "invalid_request", "email is required");
    const email = parsed.data.email;
    const ip = req.ip;

    // Rate limits are checked before any email lookup so the response shape is
    // identical for allowed / disallowed / rate-limited cases (SPECS §4).
    if (!reqIp.hit(ip).allowed || !reqEmail.hit(email).allowed) {
      return reply.status(202).send({ sent: true });
    }

    // Find-or-create the user. Only the allowed email may create a user, so
    // probing with random addresses never floods app.users. Then issue a code
    // and email it. A disallowed, userless email does nothing but returns the
    // same 202 either way.
    await getDb().transaction(async (tx) => {
      const existing = await tx.select().from(users).where(eq(users.email, email)).limit(1);
      let user = existing[0];
      if (!user) {
        if (email !== config.allowedEmail) return;
        const created = await tx.insert(users).values({ id: crypto.randomUUID(), email }).returning();
        user = created[0]!;
      }
      const newCode = await otpRequest({ db: tx, otpSubkey, now }, user, ip);
      await mailer.send(email, "Your Personal Reader code", `Your login code is ${newCode.code}. It expires in 10 minutes.`);
    });

    // Uniform 202; nothing reveals whether the email is allowed.
    return reply.status(202).send({ sent: true });
  });

  // ---- POST /v1/auth/verify-code ------------------------------------------
  app.post("/v1/auth/verify-code", async (req, reply) => {
    const parsed = verifyCodeBody.safeParse(req.body);
    if (!parsed.success) return err(reply, 400, "invalid_request", "email, a 6-digit code and client are required");
    const { email, code, client } = parsed.data;

    // CSRF for the cookie flow. Bearer is exempt.
    if (client === "web" && !csrfOk(req, config)) return err(reply, 403, "csrf", "origin check failed");
    if (!verifyIp.hit(req.ip).allowed) return err(reply, 429, "rate_limited", "too many attempts");

    const user = await findUserByEmail({ db: getDb() }, email);
    const result = user
      ? await otpVerify({ db: getDb(), otpSubkey, now }, user, code)
      : ({ ok: false, reason: "none" } as const);

    if (!result.ok || !user) return err(reply, 401, "invalid_code", "invalid or expired code");

    const created = await createSession(user.id, client, req.headers["user-agent"] as string | undefined, now);
    if (client === "web") {
      // NOTE: never `await reply.setCookie(...)` — Fastify's reply is thenable
      // (reply.then resolves on socket end), so awaiting it deadlocks the
      // handler until the client gives up. setCookie/clearCookie are sync.
      reply.setCookie(SESSION_COOKIE, created.token, {
        ...SESSION_COOKIE_OPTIONS,
        secure: config.env !== "ci",
        expires: created.expiresAt,
      });
      return reply.status(204).send();
    }
    return reply.status(200).send({ token: created.token });
  });

  // ---- POST /v1/auth/logout -------------------------------------------------
  app.post("/v1/auth/logout", async (req, reply) => {
    const token = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    if (!token) return err(reply, 401, "unauthorized", "not signed in");
    if (!csrfOk(req, config)) return err(reply, 403, "csrf", "origin check failed");
    const authed = await authenticate(token, now);
    if (authed) await revokeById(authed.sessionId, now);
    // Sync (never awaited — see the verify-code note above).
    reply.clearCookie(SESSION_COOKIE, { ...SESSION_COOKIE_OPTIONS, secure: config.env !== "ci" });
    return reply.status(204).send();
  });

  // ---- GET /v1/me -----------------------------------------------------------
  app.get("/v1/me", async (req, reply) => {
    const token =
      (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE] ?? bearerToken(req.headers);
    if (!token) return err(reply, 401, "unauthorized", "not signed in");
    const authed = await authenticate(token, now);
    if (!authed) return err(reply, 401, "unauthorized", "not signed in");
    const body: MeResponse = { email: authed.user.email, createdAt: authed.user.createdAt.toISOString() };
    return reply.status(200).send(body);
  });
}

function bearerToken(headers: Record<string, unknown>): string | null {
  const h = headers["authorization"];
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]! : null;
}
