import type {
  ApiError,
  DocumentMeta,
  DocumentOriginalResponse,
  GetDocumentResponse,
  GetSettingsResponse,
  ListDocumentsResponse,
  ListHighlightsResponse,
  HighlightItem,
  MeResponse,
  PatchDocumentBody,
  PatchHighlightBody,
  PostHighlightBody,
  ProgressResponse,
  PutProgressBody,
  PutSettingsBody,
  SectionResponse,
  TocResponse,
  ListSectionsResponse,
  ListTagsResponse,
  PatchDocumentResponse,
  PostUrlResponse,
  TagItem,
  TtsChunksResponse,
  PostTtsResponse,
  PutOpenAiKeyBody,
  SearchResponse,
} from "@reader/shared";

/** Thin fetch client for the /v1 API. Same-origin; cookies carry the session. */

async function unwrap<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as (T & ApiError) | null;
  if (!res.ok) {
    const e = new Error(body?.error?.message ?? `HTTP ${res.status}`);
    // Attach the API error code (e.g. "no_openai_key") for callers that need
    // to branch on it; the message alone can't be matched reliably.
    const code = body?.error?.code;
    if (code !== undefined) (e as Error & { code?: string }).code = code;
    throw e;
  }
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
  listDocuments(tag?: string): Promise<ListDocumentsResponse> {
    const q = tag ? `?tag=${encodeURIComponent(tag)}` : "";
    return fetch(`/v1/documents${q}`, { headers }).then((r) => unwrap<ListDocumentsResponse>(r));
  },
  // ---- search (slice 8) ----------------------------------------------------
  // Full-text search across the corpus (SPECS §9): one combined, OR'd
  // websearch tsquery across the english/finnish/simple FTS configs; each list
  // is ranked by ts_rank. Returns documents, sections, and highlights.
  search(q: string): Promise<SearchResponse> {
    return fetch(`/v1/search?q=${encodeURIComponent(q)}`, { headers }).then((r) => unwrap<SearchResponse>(r));
  },
  getDocument(id: string): Promise<GetDocumentResponse> {
    return fetch(`/v1/documents/${id}`, { headers }).then((r) => unwrap<GetDocumentResponse>(r));
  },
  getToc(id: string): Promise<TocResponse> {
    return fetch(`/v1/documents/${id}/toc`, { headers }).then((r) => unwrap<TocResponse>(r));
  },
  /** Slice 6: the signed range-capable URL of the original PDF (pdf.js). */
  getDocumentOriginal(id: string): Promise<DocumentOriginalResponse> {
    return fetch(`/v1/documents/${id}/original`, { headers }).then((r) => unwrap<DocumentOriginalResponse>(r));
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
  /** Slice 5: fetch + ingest an article (async — the document starts pending). */
  addUrl(url: string): Promise<PostUrlResponse> {
    return fetch("/v1/documents/url", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }).then((r) => unwrap<PostUrlResponse>(r));
  },
  /** Slice 5: partial update — omit = unchanged, null = clear; tagIds is a
   *  full replacement set. */
  patchDocument(id: string, body: PatchDocumentBody): Promise<PatchDocumentResponse> {
    return fetch(`/v1/documents/${id}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => unwrap<PatchDocumentResponse>(r));
  },
  deleteDocument(id: string): Promise<void> {
    return fetch(`/v1/documents/${id}`, { method: "DELETE", headers }).then((r) => unwrap<void>(r));
  },
  // ---- tags (slice 5) -------------------------------------------------------
  listTags(): Promise<ListTagsResponse> {
    return fetch("/v1/tags", { headers }).then((r) => unwrap<ListTagsResponse>(r));
  },
  /** Idempotent: an existing tag (case-insensitive) is returned as-is. */
  createTag(name: string): Promise<TagItem> {
    return fetch("/v1/tags", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => unwrap<TagItem>(r));
  },
  deleteTag(id: string): Promise<void> {
    return fetch(`/v1/tags/${id}`, { method: "DELETE", headers }).then((r) => unwrap<void>(r));
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
  /** Slice 7: store/replace the user's OpenAI key (409-free; response echoes last4). */
  putOpenAiKey(body: PutOpenAiKeyBody): Promise<GetSettingsResponse> {
    return fetch("/v1/settings/openai-key", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => unwrap<GetSettingsResponse>(r));
  },
  deleteOpenAiKey(): Promise<GetSettingsResponse> {
    return fetch("/v1/settings/openai-key", { method: "DELETE", headers }).then((r) => unwrap<GetSettingsResponse>(r));
  },

  // ---- TTS (slice 7) --------------------------------------------------------
  /** Chunk list for a section: canonical offsets only (no text). */
  getTtsChunks(docId: string, sectionId: string): Promise<TtsChunksResponse> {
    return fetch(`/v1/documents/${docId}/sections/${sectionId}/tts-chunks`, { headers }).then((r) =>
      unwrap<TtsChunksResponse>(r),
    );
  },
  /** Request one chunk's audio. 200 = ready now (cache hit, url present);
   *  202 = queued — re-call until status flips to ready. */
  postTts(docId: string, sectionId: string, chunkIndex: number): Promise<PostTtsResponse> {
    return fetch("/v1/tts", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ documentId: docId, sectionId, chunkIndex }),
    }).then((r) => unwrap<PostTtsResponse>(r));
  },

  // ---- highlights (slice 4) ------------------------------------------------
  listHighlights(docId: string): Promise<ListHighlightsResponse> {
    return fetch(`/v1/highlights?documentId=${docId}`, { headers }).then((r) => unwrap<ListHighlightsResponse>(r));
  },
  createHighlight(body: PostHighlightBody): Promise<HighlightItem> {
    return fetch("/v1/highlights", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => unwrap<HighlightItem>(r));
  },
  patchHighlight(id: string, body: PatchHighlightBody): Promise<HighlightItem> {
    return fetch(`/v1/highlights/${id}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => unwrap<HighlightItem>(r));
  },
  deleteHighlight(id: string): Promise<void> {
    return fetch(`/v1/highlights/${id}`, { method: "DELETE", headers }).then((r) => unwrap<void>(r));
  },
  /** Same-origin download link — the cookie carries the session. */
  exportHighlightsUrl(docId: string): string {
    return `/v1/export/highlights.md?documentId=${docId}`;
  },
};

export type { DocumentMeta };
