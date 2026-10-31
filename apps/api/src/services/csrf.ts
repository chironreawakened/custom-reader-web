/**
 * CSRF guard for cookie-authenticated mutating requests (SPECS §4). Bearer
 * requests are exempt (no cookie in play). Requires X-Requested-With: reader
 * and an Origin matching the configured public origin.
 *
 * Shared by the auth routes (slice 1) and the documents/upload route (slice 2).
 */
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";

/** Full public origin for the Origin check. */
export function publicOrigin(config: AppConfig): string {
  return config.env === "ci" ? `http://${config.publicOrigin}` : `https://${config.publicOrigin}`;
}

export function csrfOk(req: FastifyRequest, config: AppConfig): boolean {
  if (req.headers["x-requested-with"] !== "reader") return false;
  const origin = req.headers["origin"];
  if (typeof origin !== "string") return false;
  const expected = publicOrigin(config);
  const o = origin.toLowerCase();
  return o === expected.toLowerCase() || o === expected.toLowerCase() + "/";
}
