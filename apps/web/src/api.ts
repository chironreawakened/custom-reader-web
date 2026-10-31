import type {
  ApiError,
  DocumentMeta,
  GetDocumentResponse,
  GetSettingsResponse,
  ListDocumentsResponse,
  MeResponse,
  ProgressResponse,
  PutProgressBody,
  PutSettingsBody,
  SectionResponse,
  TocResponse,
  ListSectionsResponse,
} from "@reader/shared";

/** Thin fetch client for the /v1 API. Same-origin; cookies carry the session. */

async function unwrap<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as (T & ApiError) | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body as T;
}

const headers = { "X-Requested-With": "reader" };

/** Multipart upload of a single EPUB file. Origin header is implied by the
 *  same-origin request (CSRF check); we only add the X-Requested-With marker. */
function uploadFile(file: File) {
  const form = new FormData();
  form.append("file", file);
  return fetch("/v1/documents/upload", {
    method: "POST",
    headers,
    body: form,
  }).then((res) => unwrap<{ id: string; title: string; ingestState: string }>(res));
}

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

  // ---- documents (slice 2) -------------------------------------------------
  listDocuments(): Promise<ListDocumentsResponse> {
    return fetch("/v1/documents", { headers }).then((r) => unwrap<ListDocumentsResponse>(r));
  },
  getDocument(id: string): Promise<GetDocumentResponse> {
    return fetch(`/v1/documents/${id}`, { headers }).then((r) => unwrap<GetDocumentResponse>(r));
  },
  getToc(id: string): Promise<TocResponse> {
    return fetch(`/v1/documents/${id}/toc`, { headers }).then((r) => unwrap<TocResponse>(r));
  },
  listSections(id: string): Promise<ListSectionsResponse> {
    return fetch(`/v1/documents/${id}/sections`, { headers }).then((r) => unwrap<ListSectionsResponse>(r));
  },
  getSection(docId: string, sectionId: string): Promise<SectionResponse> {
    return fetch(`/v1/documents/${docId}/sections/${sectionId}`, { headers }).then((r) => unwrap<SectionResponse>(r));
  },
  upload(file: File): Promise<{ id: string; title: string; ingestState: string }> {
    return uploadFile(file);
  },

  // ---- progress + settings (slice 3) ---------------------------------------
  getProgress(docId: string): Promise<ProgressResponse> {
    return fetch(`/v1/progress/${docId}`, { headers }).then((r) => unwrap<ProgressResponse>(r));
  },
  putProgress(docId: string, body: PutProgressBody): Promise<ProgressResponse> {
    return fetch(`/v1/progress/${docId}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => unwrap<ProgressResponse>(r));
  },
  getSettings(): Promise<GetSettingsResponse> {
    return fetch("/v1/settings", { headers }).then((r) => unwrap<GetSettingsResponse>(r));
  },
  putSettings(body: PutSettingsBody): Promise<GetSettingsResponse> {
    return fetch("/v1/settings", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => unwrap<GetSettingsResponse>(r));
  },
};

export type { DocumentMeta };
