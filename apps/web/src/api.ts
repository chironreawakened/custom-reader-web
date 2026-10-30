import type { ApiError, MeResponse } from "@reader/shared";

/** Thin fetch client for the /v1 API. Same-origin; cookies carry the session. */

async function unwrap<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as (T & ApiError) | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body as T;
}

const headers = { "X-Requested-With": "reader" };

export const api = {
  /** null = not signed in (401). */
  async me(): Promise<MeResponse | null> {
    const res = await fetch("/v1/me", { headers });
    if (res.status === 401) return null;
    return unwrap<MeResponse>(res);
  },
  /** Always resolves (202) — the response reveals nothing about the address. */
  requestCode(email: string): Promise<void> {
    return fetch("/v1/auth/request-code", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }).then(() => undefined);
  },
  verifyCode(email: string, code: string): Promise<void> {
    return fetch("/v1/auth/verify-code", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ email, code, client: "web" }),
    }).then(unwrap<void>);
  },
  logout(): Promise<void> {
    return fetch("/v1/auth/logout", { method: "POST", headers }).then(unwrap<void>);
  },
};
