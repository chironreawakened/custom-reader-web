import React from "react";
import ReactDOM from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "./api";
import type { DocumentMeta } from "./api";
import type { HighlightItem, TocEntryDto, TagItem, PatchDocumentBody } from "@reader/shared";
import type { SearchResponse } from "@reader/shared";
import type { PatchHighlightBody, PostHighlightBody } from "@reader/shared/highlights";
// Value imports go through subpaths: the shared barrel re-exports node-only
// crypto modules (rdr1, asset-url) that the browser bundle must not reach.
import {
  buildPdfAnchor,
  buildReflowAnchor,
  HIGHLIGHT_COLORS,
  resolveAnchor,
  resolvePdfAnchor,
  type CanonicalSelection,
  type HighlightColor,
} from "@reader/shared/anchors";
import { canonicalText, type CanonicalMap, type CTRoot } from "@reader/shared/canonical-text";
// Subpath import: the shared barrel re-exports node-only crypto modules
// (rdr1, asset-url) that the browser bundle must not reach.
import { DEFAULT_READER_PREFS, MAX_FONT_SIZE, MIN_FONT_SIZE, type ReaderTheme } from "@reader/shared/settings";
import { TTS_DEFAULT_VOICE, TTS_VOICES, sentenceSpans, type TtsChunksResponse, type TtsVoice } from "@reader/shared/tts";
// Slice 6: pdf.js (faithful PDF rendering). The worker file is emitted by
// Vite as an asset; `?url` keeps the path stable across dev/prod.
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, PDFPageProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** Structural view of a pdf.js text item (TextItem isn't re-exported in v6). */
interface PdfTextItem {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const queryClient = new QueryClient();

function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
}

function HealthLine() {
  const [text, setText] = React.useState("checking…");
  React.useEffect(() => {
    void fetch("/v1/health")
      .then((r) => r.json())
      .then((b: Record<string, unknown>) =>
        setText(`api ${b.api ?? "?"} / db ${b.db ?? "?"} / storage ${b.storage ?? "?"}`)
      )
      .catch(() => setText("api unreachable"));
  }, []);
  return <p id="health" style={{ opacity: 0.6, fontSize: 12 }}>{text}</p>;
}

function CodeInput({ onDone, error }: { onDone: (code: string) => void; error: string | null }) {
  const [digits, setDigits] = React.useState(["", "", "", "", "", ""]);
  const refs = React.useRef<Array<HTMLInputElement | null>>([]);
  React.useEffect(() => {
    refs.current[0]?.focus();
  }, []);
  const setDigit = (i: number, v: string) => {
    const d = v.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[i] = d;
    setDigits(next);
    if (d && i < 5) refs.current[i + 1]?.focus();
    if (next.every((x) => x !== "")) onDone(next.join(""));
  };
  const onKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus();
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={d}
            inputMode="numeric"
            aria-label={`digit ${i + 1}`}
            data-testid={i === 0 ? "code-first" : undefined}
            onChange={(e) => setDigit(i, e.target.value)}
            onKeyDown={(e) => onKey(i, e)}
            style={{ width: 44, height: 56, fontSize: 24, textAlign: "center", font: "24px/1.2 monospace" }}
          />
        ))}
      </div>
      {error ? <p style={{ color: "crimson" }} data-testid="code-error">{error}</p> : null}
    </div>
  );
}

function LoginForm() {
  const [email, setEmail] = React.useState("");
  const [stage, setStage] = React.useState<"email" | "code">("email");
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const req = useMutation({
    mutationFn: (e: string) => api.requestCode(e),
    onSuccess: () => {
      setError(null);
      setNote("If that address is allowed, a code is on its way.");
      setStage("code");
    },
    onError: (e: Error) => setError(e.message),
  });
  const verify = useMutation({
    mutationFn: (code: string) => api.verifyCode(email, code),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["me"] }),
    onError: (e: Error) => setError(e.message),
  });
  if (stage === "email") {
    return (
      <form
        data-testid="login-form"
        onSubmit={(e) => {
          e.preventDefault();
          const value = email.trim().toLowerCase();
          if (value) req.mutate(value);
        }}
      >
        <h2>Log in</h2>
        <p style={{ opacity: 0.8 }}>Sign in with the account email — we email you a 6-digit code.</p>
        <input
          data-testid="email-input"
          type="email"
          value={email}
          placeholder="you@example.com"
          onChange={(e) => setEmail(e.target.value)}
          style={{ fontSize: 16, padding: 8, width: 280 }}
        />
        <div>
          <button type="submit" disabled={req.isPending || !email.trim()} data-testid="request-btn">
            {req.isPending ? "Sending…" : "Send code"}
          </button>
        </div>
        {error ? <p style={{ color: "crimson" }} data-testid="email-error">{error}</p> : null}
        {note ? <p data-testid="email-note">{note}</p> : null}
      </form>
    );
  }
  return (
    <div>
      <h2>Enter the code</h2>
      <p style={{ opacity: 0.8 }}>We sent a 6-digit code to {email}. It expires in 10 minutes.</p>
      <CodeInput onDone={(code) => verify.mutate(code)} error={error} />
      <button onClick={() => setStage("email")} type="button">use a different address</button>
    </div>
  );
}

function IngestBadge({ state, error }: { state: DocumentMeta["ingestState"]; error: string | null }) {
  if (state === "ready") return <span data-testid="doc-state" style={{ opacity: 0.5, fontSize: 12 }}>ready</span>;
  if (state === "failed")
    return (
      <span data-testid="doc-state" style={{ color: "crimson", fontSize: 12 }} title={error ?? ""}>
        failed{error ? `: ${error}` : ""}
      </span>
    );
  if (state === "processing")
    return (
      <span data-testid="doc-state" style={{ opacity: 0.7, fontSize: 12 }}>
        processing…
      </span>
    );
  return (
    <span data-testid="doc-state" style={{ opacity: 0.7, fontSize: 12 }}>
      queued…
    </span>
  );
}

function UploadButton({ onUploaded }: { onUploaded: () => void }) {
  const qc = useQueryClient();
  const upload = useMutation({
    mutationFn: (f: File) => api.upload(f),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["documents"] });
      onUploaded();
    },
  });
  return (
    <label
      style={{
        display: "inline-block",
        padding: "8px 14px",
        border: "1px solid #ccc",
        borderRadius: 8,
        cursor: upload.isPending ? "progress" : "pointer",
        opacity: upload.isPending ? 0.7 : 1,
      }}
    >
      {upload.isPending ? "Uploading…" : "Upload"}
      <input
        type="file"
        accept="application/epub+zip,.epub,application/pdf,.pdf"
        data-testid="upload-input"
        disabled={upload.isPending}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = "";
        }}
      />
    </label>
  );
}

function AddUrlButton({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const add = useMutation({
    mutationFn: (u: string) => api.addUrl(u),
    onSuccess: () => {
      setOpen(false);
      setUrl("");
      setErr(null);
      onAdded();
    },
    onError: (e: Error) => setErr(e.message),
  });
  return (
    <span>
      <button
        type="button"
        data-testid="add-url-btn"
        onClick={() => setOpen(!open)}
        style={{ padding: "8px 14px", border: "1px dashed #ccc", borderRadius: 8, background: "none", cursor: "pointer" }}
      >
        + Add article URL
      </button>
      {open ? (
        <form
          data-testid="add-url-form"
          onSubmit={(e) => {
            e.preventDefault();
            const v = url.trim();
            if (v) add.mutate(v);
          }}
          style={{ display: "flex", gap: 6, marginTop: 8 }}
        >
          <input
            data-testid="add-url-input"
            type="url"
            value={url}
            placeholder="https://…"
            onChange={(e) => setUrl(e.target.value)}
            style={{ fontSize: 15, padding: 7, width: 320 }}
          />
          <button type="submit" disabled={add.isPending || !url.trim()} data-testid="add-url-go">
            {add.isPending ? "Adding…" : "Add"}
          </button>
        </form>
      ) : null}
      {err ? (
        <p style={{ color: "crimson", fontSize: 13, maxWidth: 340 }} data-testid="add-url-error">
          {err}
        </p>
      ) : null}
    </span>
  );
}

/** Slice 8: the ranked search results panel (SPECS §9). Documents and
 *  highlights open the parent document; sections deep-link to the exact
 *  section within the document. Each list is capped server-side. */
function SearchResults({
  q,
  data,
  loading,
  error,
  onOpenSection,
  onOpenDoc,
}: {
  q: string;
  data: SearchResponse | undefined;
  loading: boolean;
  error: string | null;
  onOpenSection: (docId: string, sectionId: string) => void;
  onOpenDoc: (docId: string) => void;
}) {
  const docs = data?.documents ?? [];
  const secs = data?.sections ?? [];
  const hls = data?.highlights ?? [];
  const total = docs.length + secs.length + hls.length;
  const box: React.CSSProperties = { background: "#f7f9ff", border: "1px solid #dbe3ff", borderRadius: 10, padding: 12, marginBottom: 16 };
  const heading: React.CSSProperties = { fontSize: 13, fontWeight: 600, opacity: 0.7, margin: "8px 0 6px", textTransform: "uppercase", letterSpacing: 0.4 };
  const row: React.CSSProperties = { display: "block", width: "100%", textAlign: "left", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: "8px 10px", cursor: "pointer", margin: "0 0 6px", fontSize: 14 };
  return (
    <div data-testid="search-results" style={box}>
      <div data-testid="search-results-count" style={{ fontSize: 14, marginBottom: 4 }}>
        {loading ? `Searching “${q}”…` : error ? `Search failed.` : `${total} result${total === 1 ? "" : "s"} for “${q}”`}
      </div>
      {error ? <p style={{ color: "crimson", margin: 4, fontSize: 13 }}>{error}</p> : null}
      {!loading && !error && total === 0 ? (
        <p style={{ opacity: 0.7, margin: 4, fontSize: 14 }}>No matches in your library, articles, or highlights.</p>
      ) : null}
      {docs.length > 0 ? (
        <>
          <div style={heading}>Documents</div>
          {docs.map((d) => (
            <button key={`doc-${d.id}`} type="button" style={row} data-testid="search-doc-hit" onClick={() => onOpenDoc(d.id)}>
              <strong>{d.title}</strong>
              {d.author ? <span style={{ opacity: 0.7 }}> — {d.author}</span> : null}
              <span style={{ opacity: 0.5, fontSize: 12 }}> · {d.type}</span>
            </button>
          ))}
        </>
      ) : null}
      {secs.length > 0 ? (
        <>
          <div style={heading}>Sections</div>
          {secs.map((s) => (
            <button key={`sec-${s.id}`} type="button" style={row} data-testid="search-section-hit" onClick={() => onOpenSection(s.documentId, s.id)}>
              <strong>{s.title ?? `Section ${s.idx}`}</strong>
              <span style={{ opacity: 0.6, display: "block", fontSize: 13 }}>in {s.documentTitle}</span>
            </button>
          ))}
        </>
      ) : null}
      {hls.length > 0 ? (
        <>
          <div style={heading}>Highlights</div>
          {hls.map((h) => (
            <button
              key={`hl-${h.id}`}
              type="button"
              style={row}
              data-testid="search-highlight-hit"
              onClick={() => (h.sectionId ? onOpenSection(h.documentId, h.sectionId) : onOpenDoc(h.documentId))}
            >
              <strong>“{h.exact.slice(0, 80)}{h.exact.length > 80 ? "…" : ""}”</strong>
              <span style={{ opacity: 0.6, display: "block", fontSize: 13 }}>in {h.documentTitle}</span>
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}

function Library({ onOpen }: { onOpen: (docId: string, sectionId?: string) => void }) {
  const queryClient = useQueryClient();
  const [filterTag, setFilterTag] = React.useState<string | null>(null);
  // Slice 8: full-text search (SPECS §9). Submits a query, lists the ranked
  // hits, and deep-links a section result into its document + section.
  const [searchInput, setSearchInput] = React.useState("");
  const [searchQ, setSearchQ] = React.useState<string | null>(null);
  const docs = useQuery({
    queryKey: ["documents", filterTag ?? ""],
    queryFn: () => api.listDocuments(filterTag ?? undefined),
    refetchInterval: 10_000,
  });
  const allTags = useQuery({ queryKey: ["tags"], queryFn: api.listTags, staleTime: 30_000 });
  const search = useQuery({
    queryKey: ["search", searchQ],
    queryFn: () => api.search(searchQ!),
    enabled: !!searchQ,
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["documents"] });
  const items = docs.data?.items ?? [];
  const tagNames = (allTags.data?.items ?? []).map((t) => t.name);
  const submitSearch = () => {
    const q = searchInput.trim();
    if (q) setSearchQ(q);
  };
  return (
    <div data-testid="library">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0" }}>
        <h2 style={{ margin: 0 }}>Library</h2>
        <span style={{ display: "inline-flex", gap: 8 }}>
          <AddUrlButton onAdded={() => invalidate()} />
          <UploadButton onUploaded={() => invalidate()} />
        </span>
      </div>
      {/* Slice 8 search box */}
      <form
        data-testid="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          submitSearch();
        }}
        style={{ display: "flex", gap: 8, marginBottom: 12 }}
      >
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search your books…"
          aria-label="Search your books"
          data-testid="search-input"
          style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid #ccc", fontSize: 14 }}
        />
        <button type="submit" disabled={searchInput.trim() === ""} data-testid="search-btn">
          Search
        </button>
      </form>
      {searchQ ? (
        <SearchResults
          q={searchQ}
          data={search.data}
          loading={search.isLoading}
          error={search.isError ? String(search.error) : null}
          onOpenSection={(docId, sectionId) => onOpen(docId, sectionId)}
          onOpenDoc={(docId) => onOpen(docId)}
        />
      ) : null}
      {tagNames.length > 0 ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }} data-testid="tag-filter">
          <button
            type="button"
            onClick={() => setFilterTag(null)}
            data-testid="tag-filter-all"
            style={chipStyle(filterTag === null)}
          >
            all
          </button>
          {tagNames.map((n) => (
            <button key={n} type="button" onClick={() => setFilterTag(n)} data-testid="tag-filter-chip" style={chipStyle(filterTag === n)}>
              {n}
            </button>
          ))}
        </div>
      ) : null}
      {docs.isError ? (
        <p style={{ color: "crimson" }} data-testid="library-error">{String(docs.error)}</p>
      ) : items.length === 0 ? (
        <p style={{ opacity: 0.7 }} data-testid="library-empty">
          No books yet. Upload an EPUB or PDF, or add an article URL, to get started.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
          {items.map((d) => (
            <DocRow key={d.id} doc={d} tags={allTags.data?.items ?? []} onOpen={() => onOpen(d.id)} onChanged={() => void queryClient.invalidateQueries({ queryKey: ["documents"] })} onTagsChanged={() => void queryClient.invalidateQueries({ queryKey: ["tags"] })} />
          ))}
        </ul>
      )}
    </div>
  );
}

const TAG_CHIP = "#eef3ff";

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: "3px 10px",
    borderRadius: 999,
    border: `1px solid ${active ? "#4a6cf7" : "#d8d8d8"}`,
    background: active ? "#4a6cf7" : "#fff",
    color: active ? "#fff" : "#333",
    fontSize: 12,
    cursor: "pointer",
  };
}

function DocRow({
  doc,
  tags,
  onOpen,
  onChanged,
  onTagsChanged,
}: {
  doc: DocumentMeta;
  /** Full tag list (names→ids map for PATCH tagIds), from the Library query. */
  tags: TagItem[];
  onOpen: () => void;
  onChanged: () => void;
  onTagsChanged: () => void;
}) {
  const [addingTag, setAddingTag] = React.useState(false);
  const [newTag, setNewTag] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patchDocument(doc.id, body as PatchDocumentBody),
    onSuccess: () => {
      setErr(null);
      setAddingTag(false);
      setNewTag("");
      onChanged();
      onTagsChanged();
    },
    onError: (e: Error) => setErr(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteDocument(doc.id),
    onSuccess: () => onChanged(),
    onError: (e: Error) => setErr(e.message),
  });
  const tagIdsFor = (names: string[]) => tags.filter((t) => names.includes(t.name)).map((t) => t.id);
  return (
    <li data-testid="doc-row-card" style={{ border: "1px solid #e0e0e0", borderRadius: 10, background: "#fff", padding: 10 }}>
      <button
        onClick={onOpen}
        data-testid="doc-row"
        style={{ display: "block", width: "100%", border: "none", background: "none", cursor: "pointer", textAlign: "left", padding: 0 }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {doc.title || "Untitled"}
              {doc.type === "pdf" ? (
                <span style={{ opacity: 0.5, fontSize: 12, marginLeft: 6 }}>pdf</span>
              ) : doc.type === "article" ? (
                <span style={{ opacity: 0.5, fontSize: 12, marginLeft: 6 }}>article</span>
              ) : null}
            </div>
            {doc.author ? <div style={{ opacity: 0.7, fontSize: 13 }}>{doc.author}</div> : null}
            {doc.tags.length > 0 ? (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                {doc.tags.map((t) => (
                  <span key={t} style={{ fontSize: 11, padding: "1px 8px", borderRadius: 999, background: TAG_CHIP, color: "#2a3f8f" }} data-testid="doc-tag">
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <IngestBadge state={doc.ingestState} error={doc.ingestError} />
        </div>
      </button>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        <select
          data-testid="doc-status"
          value={doc.status}
          onChange={(e) => patch.mutate({ status: e.target.value })}
          style={{ fontSize: 12, padding: "2px 4px" }}
        >
          <option value="inbox">inbox</option>
          <option value="later">later</option>
          <option value="archive">archive</option>
        </select>
        <button
          type="button"
          data-testid="doc-add-tag"
          onClick={() => setAddingTag(!addingTag)}
          style={{ fontSize: 12, padding: "2px 8px", border: "1px dashed #ccc", borderRadius: 999, background: "none", cursor: "pointer", opacity: 0.7 }}
        >
          + tag
        </button>
        {addingTag ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = newTag.trim();
              if (!v) return;
              void api
                .createTag(v)
                .then((tag) => patch.mutate({ tagIds: [...new Set([...tagIdsFor(doc.tags), tag.id])] }))
                .catch((e2: Error) => setErr(e2.message));
            }}
            style={{ display: "flex", gap: 4 }}
          >
            <input
              data-testid="doc-tag-input"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder="tag name"
              style={{ fontSize: 12, padding: "2px 6px", width: 110 }}
            />
          </form>
        ) : null}
        <button
          type="button"
          data-testid="doc-delete"
          onClick={() => {
            if (window.confirm(`Delete "${doc.title}"?`)) remove.mutate();
          }}
          style={{ fontSize: 12, padding: "2px 8px", border: "1px solid #e5c8c8", borderRadius: 999, background: "none", color: "#a33", cursor: "pointer", marginLeft: "auto" }}
        >
          delete
        </button>
      </div>
      {err ? <p style={{ color: "crimson", fontSize: 12 }} data-testid="doc-row-error">{err}</p> : null}
    </li>
  );
}

function Reader({ docId, initialSectionId, onBack }: { docId: string; initialSectionId?: string | null; onBack: () => void }) {
  const qc = useQueryClient();
  const doc = useQuery({ queryKey: ["doc", docId], queryFn: () => api.getDocument(docId), refetchInterval: 8_000 });
  const toc = useQuery({
    queryKey: ["toc", docId],
    queryFn: () => api.getToc(docId),
    enabled: doc.data?.ingestState === "ready",
  });
  const sections = useQuery({
    queryKey: ["sections", docId],
    queryFn: () => api.listSections(docId),
    enabled: doc.data?.ingestState === "ready",
  });
  const progress = useQuery({
    queryKey: ["progress", docId],
    queryFn: () => api.getProgress(docId),
    enabled: doc.data?.ingestState === "ready" && !!sections.data,
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const saveSettings = useMutation({
    mutationFn: (prefs: { theme?: ReaderTheme; fontSize?: number; ttsVoice?: TtsVoice }) =>
      api.putSettings({
        ...(prefs.theme !== undefined && prefs.fontSize !== undefined && {
          readerPrefs: { theme: prefs.theme, fontSize: prefs.fontSize },
        }),
        ...(prefs.ttsVoice !== undefined && { ttsVoice: prefs.ttsVoice }),
      }),
    onSuccess: (res) => void qc.setQueryData(["settings"], res),
  });

  const [sectionId, setSectionId] = React.useState<string | null>(initialSectionId ?? null);
  const restoredRef = React.useRef(false);
  const [pendingScroll, setPendingScroll] = React.useState<number | null>(null);

  // Progress restore (slice 3): once the section list + saved spot are known,
  // open the saved section and scroll to the saved offset — once per book open.
  // A search deep-link (initialSectionId) is an explicit navigation and wins
  // over the saved spot, so restore is skipped when one was provided.
  React.useEffect(() => {
    if (restoredRef.current || !sections.data || !progress.data) return;
    restoredRef.current = true;
    if (initialSectionId) return; // deep link from search — don't override
    const loc = progress.data.locator;
    if (!loc || loc.kind !== "reflow") return;
    const idx = sections.data.items.findIndex((s) => s.id === loc.sectionId);
    if (idx === -1) return; // saved spot points at a stale section
    setSectionId(loc.sectionId);
    if (loc.offset > 0) setPendingScroll(loc.offset);
  }, [sections.data, progress.data, initialSectionId]);

  // Default to the first section once the list is loaded and nothing was restored.
  React.useEffect(() => {
    if (!sectionId && !progress.data && sections.data?.items.length) setSectionId(sections.data.items[0]!.id);
  }, [sections.data, sectionId, progress.data]);

  const section = useQuery({
    queryKey: ["section", docId, sectionId],
    queryFn: () => api.getSection(docId, sectionId!),
    enabled: !!sectionId,
  });

  const percentFor = React.useCallback(
    (sid: string) => {
      const items = sections.data?.items;
      if (!items?.length) return 0;
      const i = items.findIndex((s) => s.id === sid);
      return Math.min(1, (i + 1) / items.length);
    },
    [sections.data],
  );

  const saveProgress = React.useCallback(
    async (sid: string, offset: number) => {
      const locator = { kind: "reflow" as const, sectionId: sid, offset, percent: percentFor(sid) };
      const updatedAt = new Date().toISOString();
      try {
        await api.putProgress(docId, { locator, updatedAt });
        void qc.setQueryData(["progress", docId], { locator, updatedAt });
      } catch {
        // 409 = another device wrote a newer spot (last write wins) — pick it up.
        void qc.invalidateQueries({ queryKey: ["progress", docId] });
      }
    },
    [docId, percentFor, qc],
  );

  // Autosave: section change (offset 0) + debounced scroll position.
  React.useEffect(() => {
    if (!sectionId || !section.data) return;
    if (pendingScroll !== null) {
      // This navigation restored a saved spot — re-save it (idempotent) after
      // the scroll lands, so a quick reload still lands on the same spot.
      void saveProgress(sectionId, pendingScroll);
      setPendingScroll(null);
      window.scrollTo(0, pendingScroll);
      return;
    }
    window.scrollTo(0, 0);
    void saveProgress(sectionId, 0);
  }, [sectionId, section.data, pendingScroll, saveProgress]);

  React.useEffect(() => {
    if (!sectionId || !section.data || pendingScroll !== null) return;
    let t: number | undefined;
    const onScroll = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => void saveProgress(sectionId, Math.round(window.scrollY)), 500);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("scroll", onScroll);
    };
  }, [sectionId, section.data, pendingScroll, saveProgress]);

  // ---- slice 7: TTS ----------------------------------------------------------
  const [ttsOn, setTtsOn] = React.useState(false);
  const [chunks, setChunks] = React.useState<TtsChunksResponse | null>(null);
  const [idx, setIdx] = React.useState(0);
  const [curChunk, setCurChunk] = React.useState<number | null>(null);
  const [ttsUrl, setTtsUrl] = React.useState<string | null>(null);
  const [ttsError, setTtsError] = React.useState<string | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const pollRef = React.useRef<number | null>(null);

  // Stop everything (polling + audio) — helper for toggle-off and cleanup.
  const stopTts = React.useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setTtsUrl(null);
    setCurChunk(null);
  }, []);

  React.useEffect(() => () => stopTts(), [stopTts]);

  const toggleTts = React.useCallback(
    (on: boolean) => {
      setTtsOn(on);
      if (on) return;
      stopTts();
      if (sectionRef.current) clearMarks(sectionRef.current, "tts-mark");
      setChunks(null);
      setIdx(0);
      setTtsError(null);
    },
    [stopTts],
  );

  // Fetch the chunk list for the open section (canonical offsets; no text).
  React.useEffect(() => {
    if (!ttsOn || !sectionId || !section.data) return;
    setChunks(null);
    setIdx(0);
    setTtsError(null);
    void api.getTtsChunks(docId, sectionId).then(setChunks).catch(() => setChunks(null));
  }, [ttsOn, sectionId, section.data, docId]);

  // Build the HTMLAudioElement for a ready chunk: wires onended to advance to
  // the next chunk (the play effect re-runs on idx) and stores it in audioRef.
  const makeAudio = React.useCallback(
    (url: string, chunk: number) => {
      const audio = new Audio(url);
      audio.onended = () => {
        if (!ttsOn || audioRef.current !== audio) return;
        if (chunk + 1 >= (chunks?.chunks.length ?? 0)) return; // last chunk — stop
        setCurChunk(null);
        setIdx(chunk + 1);
      };
      audioRef.current = audio;
      return audio;
    },
    [ttsOn, chunks],
  );

  // Play the current chunk: POST /v1/tts, then poll while the worker (re)generates
  // it (202 "processing"). A cache hit answers 200 immediately — a replay makes
  // no second OpenAI call (PLAN slice 7 verify).
  React.useEffect(() => {
    if (!ttsOn || !sectionId || !section.data || !chunks) return;
    if (idx >= chunks.chunks.length) return;
    let alive = true;
    const target = idx;
    const play = async () => {
      try {
        const res = await api.postTts(docId, sectionId, target);
        if (!alive) return;
        if (res.status === "ready" && res.url) {
          setCurChunk(target);
          setTtsUrl(res.url);
          await makeAudio(res.url, target).play().catch(() => {
            /* autoplay may be blocked — the panel stays usable */
          });
          return;
        }
        // 202 processing — poll until the worker finishes.
        pollRef.current = window.setInterval(() => {
          void api.postTts(docId, sectionId, target).then((r2) => {
            if (!alive) return;
            if (r2.status === "ready" && r2.url) {
              if (pollRef.current !== null) {
                window.clearInterval(pollRef.current);
                pollRef.current = null;
              }
              setCurChunk(target);
              setTtsUrl(r2.url);
              void makeAudio(r2.url, target).play().catch(() => {
                /* see above */
              });
            }
          }).catch(() => {
            /* transient network error — the interval retries */
          });
        }, 2000);
      } catch (err) {
        if (!alive) return;
        // no_openai_key (409) or other failure: surface it, stop the queue.
        setTtsError((err as Error).message ?? "TTS failed");
      }
    };
    void play();
    return () => {
      alive = false;
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      audioRef.current?.pause();
    };
  }, [ttsOn, sectionId, section.data, chunks, idx, docId, makeAudio]);

  // Sentence highlight: while a chunk plays, wrap its FIRST sentence in the
  // rendered section (tts-mark; distinct from the slice-4 hl-mark so the two
  // never clobber each other). Chunk spans are relative to the chunk text,
  // which starts at `startOffset` in the section's canonical text.
  React.useEffect(() => {
    const root = sectionRef.current;
    if (!ttsOn || curChunk === null || !chunks || !root) return;
    const ch = chunks.chunks[curChunk];
    if (!ch) return;
    const { text, map } = canonicalText(root as unknown as CTRoot);
    const chunkText = text.slice(ch.startOffset, ch.endOffset);
    const first = sentenceSpans(chunkText)[0];
    if (!first) return;
    const ranges: PlacedRange[] = [
      {
        hlId: "tts-sentence",
        color: null,
        note: null,
        start: ch.startOffset + first.start,
        end: ch.startOffset + first.end,
        markId: "tts-mark",
        bg: "#7ec8ff44",
      },
    ];
    try {
      clearMarks(root, "tts-mark");
      placeRanges(root, map, ranges);
    } catch {
      /* section re-rendered mid-map — the next chunk start retries */
    }
  }, [ttsOn, curChunk, chunks, section.data]);

  // Next/prev chunk.
  const stepChunk = React.useCallback(
    (delta: number) => {
      setCurChunk(null);
      if (audioRef.current) audioRef.current.pause();
      setIdx((i) => Math.max(0, Math.min((chunks?.chunks.length ?? 1) - 1, i + delta)));
    },
    [chunks],
  );

  // ---- slice 4: highlights ---------------------------------------------------
  const [showHighlights, setShowHighlights] = React.useState(false);
  const sectionRef = React.useRef<HTMLElement | null>(null);
  const highlights = useQuery({
    queryKey: ["highlights", docId],
    queryFn: () => api.listHighlights(docId),
    enabled: doc.data?.ingestState === "ready",
  });
  const [pendingSel, setPendingSel] = React.useState<{ start: number; end: number; text: string } | null>(null);
  const createHighlight = useMutation({
    mutationFn: (body: PostHighlightBody) => api.createHighlight(body),
    onSuccess: () => {
      setPendingSel(null);
      void qc.invalidateQueries({ queryKey: ["highlights", docId] });
    },
  });
  const patchHighlight = useMutation({
    mutationFn: (a: { id: string; body: PatchHighlightBody }) => api.patchHighlight(a.id, a.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["highlights", docId] }),
  });
  const deleteHighlight = useMutation({
    mutationFn: (id: string) => api.deleteHighlight(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["highlights", docId] }),
  });

  // A non-collapsed selection released inside the section text → the floating
  // save bar. Offsets are canonical (shared canonicalText), so they match the
  // server's view of the section byte-for-byte.
  const onMouseUp = React.useCallback(() => {
    if (!sectionRef.current) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      if (sel) sel.removeAllRanges();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!sectionRef.current.contains(range.commonAncestorContainer)) {
      sel.removeAllRanges();
      return;
    }
    const sec = section.data;
    if (!sec) return;
    const { text, map } = canonicalText(sectionRef.current as unknown as CTRoot);
    const a = { node: range.startContainer, offset: range.startOffset, isEnd: false };
    const b = { node: range.endContainer, offset: range.endOffset, isEnd: true };
    const c1 = pointToCanonical(a.node, a.offset, a.isEnd, map);
    const c2 = pointToCanonical(b.node, b.offset, b.isEnd, map);
    if (c1 === null || c2 === null) return;
    let start = Math.min(c1, c2);
    let end = Math.max(c1, c2);
    // Trim invisible block separators from the edges so `exact` is exactly
    // what the user visually selected (anchors still resolve — separators
    // sit between characters, never inside the selected run).
    while (start < end && text[start] === "\n") start++;
    while (end > start && text[end - 1] === "\n") end--;
    if (end <= start) {
      sel.removeAllRanges();
      return;
    }
    setPendingSel({ start, end, text: text.slice(start, end) });
  }, [section.data]);

  // Re-render stored highlights on top of the section whenever the section or
  // the highlight list changes: clear old marks, re-resolve anchors (SPECS §7
  // ladder), wrap each resolved range in a <mark>.
  React.useEffect(() => {
    const root = sectionRef.current;
    const sec = section.data;
    if (!root || !sec) return;
    clearMarks(root);
    const items = (highlights.data?.items ?? []).filter((h) => h.sectionId === sec.id);
    if (items.length === 0) return;
    const { text, map } = canonicalText(root as unknown as CTRoot);
    const ranges: PlacedRange[] = [];
    for (const h of items) {
      if (h.anchor.kind !== "reflow") continue;
      const res = resolveAnchor(h.anchor, text);
      if (res.status !== "resolved") continue; // orphaned: listed, not drawn
      ranges.push({ hlId: h.id, color: h.color, note: h.note, start: res.start, end: res.end });
    }
    placeRanges(root, map, ranges);
  }, [section.data, highlights.data]);

  if (doc.isError) return <ErrorBox message={String(doc.error)} onBack={onBack} />;
  if (!doc.data) return <p data-testid="reader-loading">Loading…</p>;

  const d = doc.data;
  if (d.ingestState === "failed")
    return (
      <div>
        <BackBar onBack={onBack} title={d.title} />
        <p style={{ color: "crimson" }}>Couldn't process this book: {d.ingestError ?? "unknown error"}</p>
      </div>
    );
  if (d.ingestState !== "ready")
    return (
      <div>
        <BackBar onBack={onBack} title={d.title} />
        <p data-testid="processing">Processing your book… this usually takes a few seconds.</p>
      </div>
    );

  const prefs = settings.data?.readerPrefs ?? DEFAULT_READER_PREFS;
  const theme = THEME_STYLES[prefs.theme];
  const setTheme = (t: ReaderTheme) => saveSettings.mutate({ theme: t, fontSize: prefs.fontSize });
  const stepFont = (delta: number) =>
    saveSettings.mutate({ theme: prefs.theme, fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, prefs.fontSize + delta)) });

  return (
    <div
      data-testid="reader"
      data-theme={prefs.theme}
      style={{ background: theme.bg, color: theme.fg, borderRadius: 12, padding: 16, transition: "background 120ms" }}
    >
      <BackBar
        onBack={onBack}
        title={d.title}
        onHighlights={() => setShowHighlights(true)}
        onTts={() => toggleTts(!ttsOn)}
        ttsActive={ttsOn}
      />
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        {d.coverUrl ? (
          <img
            data-testid="reader-cover"
            src={d.coverUrl}
            alt="cover"
            style={{ width: 120, height: 170, objectFit: "cover", borderRadius: 6, flexShrink: 0, border: "1px solid #ddd" }}
          />
        ) : null}
        <div>
          <h1 style={{ margin: "0 0 4px" }}>{d.title}</h1>
          {d.author ? <p style={{ opacity: 0.7, margin: "0 0 4px" }}>{d.author}</p> : null}
          {d.wordCount ? <p style={{ opacity: 0.5, fontSize: 13, margin: 0 }}>{d.wordCount} words</p> : null}
          <ReaderControls
            theme={prefs.theme}
            fontSize={prefs.fontSize}
            onTheme={setTheme}
            onFont={(d2) => stepFont(d2)}
          />
          {toc.data?.items.length ? (
            <details data-testid="toc" style={{ marginTop: 8 }} open>
              <summary style={{ cursor: "pointer", fontSize: 14 }}>Contents</summary>
              <TocTree entries={toc.data.items} onPick={(sid) => setSectionId(sid)} />
            </details>
          ) : null}
        </div>
      </div>

      {ttsOn ? (
        <div
          data-testid="tts-panel"
          style={{
            marginTop: 16,
            padding: "10px 14px",
            background: theme.bg === "#ffffff" ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.08)",
            borderRadius: 10,
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            alignItems: "center",
            fontSize: 14,
          }}
        >
          {ttsError ? (
            <span data-testid="tts-error" style={{ color: "crimson", flex: 1 }}>
              {ttsError}{" "}
              <a href="#" onClick={(e) => e.preventDefault()} data-testid="tts-settings-link">
                Set your OpenAI key in Settings
              </a>
            </span>
          ) : null}
          {chunks ? (
            <span data-testid="tts-progress" style={{ opacity: 0.8 }}>
              Chunk {Math.min(idx + 1, chunks.chunks.length)} / {chunks.chunks.length}
            </span>
          ) : (
            <span data-testid="tts-loading">Loading chunks…</span>
          )}
          {curChunk !== null ? (
            <span data-testid="tts-state">Reading…</span>
          ) : null}
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
            <button
              type="button"
              data-testid="tts-prev-btn"
              disabled={!chunks || idx <= 0}
              onClick={() => stepChunk(-1)}
              style={{ padding: "4px 10px", borderRadius: 8 }}
            >
              ⏮
            </button>
            <button
              type="button"
              data-testid="tts-next-btn"
              disabled={!chunks || idx >= (chunks?.chunks.length ?? 0) - 1}
              onClick={() => stepChunk(1)}
              style={{ padding: "4px 10px", borderRadius: 8 }}
            >
              ⏭
            </button>
            <button
              type="button"
              data-testid="tts-stop-btn"
              onClick={() => toggleTts(false)}
              style={{ padding: "4px 10px", borderRadius: 8 }}
            >
              ⏹ Stop
            </button>
          </span>
        </div>
      ) : null}

      <div id="content" style={{ marginTop: 20, lineHeight: 1.7, fontSize: `${prefs.fontSize}px` }} onMouseUp={onMouseUp}>
        {section.isError ? (
          <ErrorBox message={String(section.error)} onBack={() => setSectionId(null)} />
        ) : section.data ? (
          <article
            data-testid="section"
            ref={sectionRef}
            // Server-side sanitized (slice 1 sanitizer) with asset URLs rewritten to signed URLs.
            // Slice 4: highlights are drawn on top as <mark> by an effect.
            dangerouslySetInnerHTML={{ __html: section.data.html }}
          />
        ) : (
          <p data-testid="section-loading">Loading section…</p>
        )}
      </div>

      {pendingSel ? (
        <div
          data-testid="save-highlight-bar"
          style={{
            position: "sticky",
            bottom: 8,
            margin: "12px 0 0",
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "8px 12px",
            background: "rgba(0,0,0,0.75)",
            color: "#fff",
            borderRadius: 10,
            fontSize: 14,
          }}
        >
          <span data-testid="save-highlight-preview" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            “{pendingSel.text.slice(0, 80)}{pendingSel.text.length > 80 ? "…" : ""}”
          </span>
          <button
            data-testid="save-highlight-btn"
            disabled={createHighlight.isPending}
            onClick={() => {
              const sid = section.data!.id;
              const { text } = canonicalText(sectionRef.current! as unknown as CTRoot);
              const anchor = buildReflowAnchor(sid, { start: pendingSel.start, end: pendingSel.end }, text);
              createHighlight.mutate({ documentId: docId, anchor, exact: anchor.exact, color: null, note: null });
            }}
          >
            {createHighlight.isPending ? "Saving…" : "Highlight"}
          </button>
          <button data-testid="cancel-highlight-btn" onClick={() => { setPendingSel(null); window.getSelection()?.removeAllRanges(); }}>
            Cancel
          </button>
        </div>
      ) : null}

      {showHighlights ? (
        <HighlightsPanel
          docId={docId}
          items={highlights.data?.items ?? []}
          onClose={() => setShowHighlights(false)}
          onColor={(id, color) => patchHighlight.mutate({ id, body: { color } })}
          onNote={(id, note) => patchHighlight.mutate({ id, body: { note } })}
          onDelete={(id) => deleteHighlight.mutate(id)}
          deleting={deleteHighlight.isPending}
        />
      ) : null}

      <Pager
        prevId={section.data?.prevSectionId ?? null}
        nextId={section.data?.nextSectionId ?? null}
        onNav={setSectionId}
      />
    </div>
  );
}

const THEME_STYLES: Record<ReaderTheme, { bg: string; fg: string }> = {
  light: { bg: "#ffffff", fg: "#111111" },
  sepia: { bg: "#f4ecd8", fg: "#3a3226" },
  dark: { bg: "#161616", fg: "#d8d8d8" },
};

function ReaderControls({
  theme,
  fontSize,
  onTheme,
  onFont,
}: {
  theme: ReaderTheme;
  fontSize: number;
  onTheme: (t: ReaderTheme) => void;
  onFont: (delta: number) => void;
}) {
  const btn: React.CSSProperties = { padding: "2px 10px", borderRadius: 6, border: "1px solid #9996", cursor: "pointer" };
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "6px 0", fontSize: 13, opacity: 0.85 }} data-testid="reader-controls">
      <label>
        Theme{" "}
        <select data-testid="theme-select" value={theme} onChange={(e) => onTheme(e.target.value as ReaderTheme)} style={{ fontSize: 13 }}>
          <option value="light">light</option>
          <option value="sepia">sepia</option>
          <option value="dark">dark</option>
        </select>
      </label>
      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
        Text size{" "}
        <button type="button" data-testid="font-minus-btn" onClick={() => onFont(-1)} disabled={fontSize <= MIN_FONT_SIZE} style={btn}>
          A−
        </button>
        <span data-testid="font-size" style={{ minWidth: 20, textAlign: "center" }}>
          {fontSize}
        </span>
        <button type="button" data-testid="font-plus-btn" onClick={() => onFont(1)} disabled={fontSize >= MAX_FONT_SIZE} style={btn}>
          A+
        </button>
      </span>
    </div>
  );
}

/** Renders the flat TOC list (parent refs) as a nested tree. Entries without
 *  a sectionId (or with an unknown parent) fall back to the top level. */
function TocTree({ entries, onPick }: { entries: TocEntryDto[]; onPick: (sectionId: string) => void }) {
  const byParent = React.useMemo(() => {
    const ids = new Set(entries.map((e) => e.id));
    const map = new Map<string | null, TocEntryDto[]>();
    for (const e of entries) {
      const key = e.parentId && ids.has(e.parentId) ? e.parentId : null;
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }
    return map;
  }, [entries]);

  const render = (parentId: string | null): React.ReactNode => {
    const kids = byParent.get(parentId) ?? [];
    if (!kids.length) return null;
    return (
      <ul style={{ margin: "4px 0", paddingLeft: 18, fontSize: 14 }}>
        {kids.map((t) => (
          <li key={t.id} style={{ marginBottom: 2 }}>
            {t.sectionId ? (
              <a href={`#sec-${t.sectionId}`} onClick={(e) => { e.preventDefault(); onPick(t.sectionId!); }}>
                {t.label}
              </a>
            ) : (
              <span style={{ opacity: 0.6 }}>{t.label}</span>
            )}
            {render(t.id)}
          </li>
        ))}
      </ul>
    );
  };

  return <div>{render(null)}</div>;
}

function Pager({
  prevId,
  nextId,
  onNav,
  middle,
}: {
  prevId: string | null;
  nextId: string | null;
  onNav: (id: string) => void;
  /** Optional center content (e.g. the PDF page indicator). */
  middle?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24, gap: 12, alignItems: "center" }}>
      <button disabled={!prevId} onClick={() => prevId && onNav(prevId)} data-testid="prev-btn">
        ← Previous
      </button>
      {middle ?? null}
      <button disabled={!nextId} onClick={() => nextId && onNav(nextId)} data-testid="next-btn">
        Next →
      </button>
    </div>
  );
}

// Slice 4 — the highlights page: every highlight in this document (newest
// first, as the API returns it), with colour, note and delete inline, plus
// the Markdown export. Orphaned items (anchor no longer resolves in the
// section text) are listed, flagged, never hidden.
function NoteEditor({
  value,
  onCommit,
  disabled,
}: {
  value: string | null;
  onCommit: (note: string | null) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = React.useState(value ?? "");
  React.useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <input
      data-testid="note-input"
      value={draft}
      placeholder="Add a note…"
      disabled={disabled}
      style={{ width: "100%", fontSize: 13, padding: 4, boxSizing: "border-box" }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.trim() === "" ? null : draft.trim();
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function HighlightsPanel({
  docId,
  items,
  onClose,
  onColor,
  onNote,
  onDelete,
  deleting,
}: {
  docId: string;
  items: HighlightItem[];
  onClose: () => void;
  onColor: (id: string, color: HighlightColor | null) => void;
  onNote: (id: string, note: string | null) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  return (
    <div
      data-testid="highlights-panel"
      style={{
        marginTop: 16,
        border: "1px solid #ddd8",
        borderRadius: 12,
        padding: 12,
        background: "#00000008",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Highlights ({items.length})</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <a
            data-testid="export-highlights-btn"
            href={api.exportHighlightsUrl(docId)}
            style={{ fontSize: 13 }}
          >
            Export .md
          </a>
          <button type="button" onClick={onClose} data-testid="highlights-close-btn" style={{ fontSize: 13 }}>
            Close
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <p style={{ opacity: 0.7, fontSize: 14, margin: 0 }}>
          No highlights yet — select text in a chapter to save one.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10 }}>
          {items.map((h) => (
            <li
              key={h.id}
              data-testid="highlight-item"
              data-orphaned={h.orphaned ? "true" : "false"}
              style={{ padding: 10, borderRadius: 8, border: "1px solid #e0e0e0", background: "#fff" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <span
                  data-testid="highlight-text"
                  style={{ background: HIGHLIGHT_BG[h.color ?? "yellow"], borderRadius: 3, padding: "0 3px" }}
                >
                  {h.exact.length > 160 ? h.exact.slice(0, 160) + "…" : h.exact}
                </span>
                {h.orphaned ? (
                  <span data-testid="orphaned-badge" style={{ fontSize: 12, opacity: 0.7 }} title="This text is no longer in the book.">
                    (orphaned)
                  </span>
                ) : null}
              </div>
              <div style={{ opacity: 0.5, fontSize: 12, margin: "4px 0" }}>{h.sectionTitle ?? "unknown section"}</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 6 }} data-testid="color-picker">
                {HIGHLIGHT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    data-testid={`color-btn-${c}`}
                    title={h.color === c ? "Click to remove" : c}
                    aria-pressed={h.color === c}
                    onClick={() => onColor(h.id, h.color === c ? null : c)}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      border: h.color === c ? "2px solid #333" : "1px solid #9998",
                      background: HIGHLIGHT_BG[c],
                      cursor: "pointer",
                    }}
                  />
                ))}
              </div>
              <NoteEditor value={h.note} onCommit={(note) => onNote(h.id, note)} disabled={deleting} />
              <div style={{ marginTop: 6, textAlign: "right" }}>
                <button
                  type="button"
                  data-testid="delete-highlight-btn"
                  disabled={deleting}
                  onClick={() => onDelete(h.id)}
                  style={{ fontSize: 12, color: "crimson" }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BackBar({
  onBack,
  title,
  onHighlights,
  onTts,
  ttsActive,
}: {
  onBack: () => void;
  title: string;
  onHighlights?: () => void;
  onTts?: () => void;
  ttsActive?: boolean;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <button onClick={onBack} type="button" data-testid="back-btn" style={{ padding: "6px 12px", borderRadius: 8 }}>
        ← Library
      </button>
      <span style={{ opacity: 0.5, fontSize: 13, marginLeft: 10 }}>{title}</span>
      {onHighlights ? (
        <button
          type="button"
          data-testid="highlights-btn"
          onClick={onHighlights}
          style={{ marginLeft: 10, padding: "6px 12px", borderRadius: 8 }}
        >
          Highlights
        </button>
      ) : null}
      {onTts ? (
        <button
          type="button"
          data-testid="tts-toggle-btn"
          aria-pressed={ttsActive}
          onClick={onTts}
          style={{ marginLeft: 10, padding: "6px 12px", borderRadius: 8 }}
        >
          {ttsActive ? "⏹ Stop reading" : "🔊 Listen"}
        </button>
      ) : null}
    </div>
  );
}

// ===========================================================================
// Slice 4 — highlights (select → anchor → save → re-render → panel)
//
// The section HTML is rendered via dangerouslySetInnerHTML; highlights are
// drawn on top with a walk that wraps the canonical ranges in <mark> tags.
// Selection → anchor uses the same shared canonicalText() the server runs,
// so offsets match byte-for-byte (SPECS §6/§7).
// ===========================================================================

const HIGHLIGHT_BG: Record<HighlightColor, string> = {
  yellow: "#ffe97a",
  green: "#b6f0b6",
  blue: "#a9d4ff",
  pink: "#ffc4de",
};

const IGNORED_TAGS = new Set(["script", "style", "rt", "rp", "template"]);

/** First text node under `root` in document order, skipping ignored tags. */
function firstTextNode(root: Node | null): Text | null {
  if (!root) return null;
  if (root.nodeType === Node.TEXT_NODE) {
    const t = root as Text;
    return t.data === "" ? null : t;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return null;
  const e = root as HTMLElement;
  if (IGNORED_TAGS.has(e.tagName.toLowerCase()) || e.hasAttribute("data-rdr-ignore")) return null;
  for (let i = 0; i < e.childNodes.length; i++) {
    const t = firstTextNode(e.childNodes[i]!);
    if (t) return t;
  }
  return null;
}

/** Last text node under `root` in document order, skipping ignored tags. */
function lastTextNode(root: Node | null): Text | null {
  if (!root) return null;
  if (root.nodeType === Node.TEXT_NODE) {
    const t = root as Text;
    return t.data === "" ? null : t;
  }
  const e = root as HTMLElement;
  if (IGNORED_TAGS.has(e.tagName.toLowerCase()) || e.hasAttribute("data-rdr-ignore")) return null;
  for (let i = e.childNodes.length - 1; i >= 0; i--) {
    const t = lastTextNode(e.childNodes[i]!);
    if (t) return t;
  }
  return null;
}

/**
 * A DOM point (range anchor) → canonical text offset via the shared map.
 * A point inside a text node at offset k sits just BEFORE character k; when
 * it sits at the END of the node (k == len) it is one canonical char past the
 * node's last character — `toCanonical` only knows the last char's position,
 * so add +1 in that case. For element containers the start point maps to the
 * first character inside, the end point to one past the last.
 */
function pointToCanonical(
  container: Node,
  offset: number,
  isEnd: boolean,
  map: CanonicalMap,
): number | null {
  let node: Text | null = null;
  let off = 0;
  let atNodeEnd = false;
  if (container.nodeType === Node.TEXT_NODE) {
    node = container as Text;
    off = offset;
    atNodeEnd = off >= node.data.length;
  } else {
    const target = isEnd ? container.childNodes[offset - 1] ?? null : container.childNodes[offset] ?? null;
    node = isEnd ? lastTextNode(target) : firstTextNode(target);
    off = isEnd && node ? node.data.length : 0;
    atNodeEnd = isEnd;
  }
  if (!node) return null;
  let c = map.toCanonical(node as unknown as { nodeType: 3; nodeName: string; data: string }, off);
  if (atNodeEnd) c += 1;
  return c;
}

interface PlacedRange {
  hlId: string;
  color: HighlightColor | null;
  note: string | null;
  start: number;
  end: number;
  /** mark data-testid (slice 4: 'hl-mark'; slice 7 TTS: 'tts-mark'). */
  markId?: string;
  /** Explicit background (slice 7 TTS); defaults to the highlight color. */
  bg?: string;
}

/** Remove marks previously placed by this module (unwrap, keep text).
 *  `markId` = the data-testid attribute: 'hl-mark' (user highlights) or
 *  'tts-mark' (the slice-7 sentence highlight) — each clears only its own. */
function clearMarks(root: HTMLElement, markId = "hl-mark"): void {
  const marks = root.querySelectorAll(`mark[data-testid='${markId}']`);
  marks.forEach((m) => {
    while (m.firstChild) m.parentNode!.insertBefore(m.firstChild, m);
    m.remove();
  });
  root.normalize();
}

/**
 * The text-node segment containing canonical offset `off`: the node whose
 * canonical span brackets off, with the local offset for a DOM Range
 * boundary. (node, off) is the position just BEFORE the character that
 * starts at `off` — exactly what Range.setStart/setEnd want. When `off`
 * falls on an unmapped block separator, snap to the nearest mapped
 * character (the shared `toNode` does the same), which is visually a
 * no-op — separators sit between blocks.
 */
function pointAtCanonical(root: HTMLElement, off: number, map: CanonicalMap): { node: Text; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segs: { node: Text; s: number; e: number }[] = [];
  let cur: Text | null;
  while ((cur = walker.nextNode() as Text | null)) {
    const c = cur as unknown as { nodeType: 3; nodeName: string; data: string };
    const s = map.toCanonical(c, 0);
    const e = map.toCanonical(c, cur.data.length) + 1;
    // Whitespace-only nodes whose characters are all trimmed at block
    // boundaries contribute no canonical chars, so toCanonical falls back to
    // offset 0 for them. Left in, such a node brackets offset 0 and would be
    // treated as inside any range starting there, producing empty <mark>
    // runs (regression: a chapter opening at offset 0 got two phantom marks
    // around its first heading, 2026-11-11). They carry no text; skip them.
    if (c.data.trim() === "" && s === 0 && e === 1) continue;
    segs.push({ node: cur, s, e });
  }
  for (const sg of segs) if (off >= sg.s && off < sg.e) return { node: sg.node, offset: off - sg.s };
  // Off on a separator: prefer the node BEFORE it (a selection that ends
  // just after a separator then ends at the previous node's end — correct).
  // Forward-snap only when there is nothing before (separator at offset 0
  // of a selection's start). Mirrors the shared toNode's walk-out order.
  let prev: (typeof segs)[number] | null = null;
  for (const sg of segs) {
    if (sg.e <= off) prev = sg;
    else break;
  }
  if (prev) return { node: prev.node, offset: prev.e - prev.s };
  for (const sg of segs) if (sg.s > off) return { node: sg.node, offset: 0 };
  // No mapped text at all (should not happen for a rendered section).
  throw new Error("pointAtCanonical: no mapped text in document");
}

/**
 * Draw each resolved canonical [start, end) range as
 * `<mark data-testid="hl-mark">` runs. A range may span block boundaries
 * (cross-paragraph highlight), so it is split at the text nodes it covers
 * and each covered slice is wrapped in its own <mark>. Splitting text
 * nodes first keeps every mark's range inside a single text node, so
 * `surroundContents` succeeds and block structure (separate <p>s) is
 * preserved. Marks share the same hlId — consumers query by id.
 */
function splitAt(node: Text, off: number): Text {
  return off > 0 && off < node.data.length ? node.splitText(off) : node;
}

function placeRanges(root: HTMLElement, map: CanonicalMap, ranges: PlacedRange[]): void {
  // Canonical span of every text node. Two consecutive nodes can share a
  // boundary offset when a block separator sits between them; the overlap is
  // harmless because a range boundary at that offset marks nothing extra.
  const segs = (() => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const out: { node: Text; s: number; e: number }[] = [];
    let cur: Node | null;
    while ((cur = walker.nextNode())) {
      const c = cur as unknown as { nodeType: 3; nodeName: string; data: string };
      const s = map.toCanonical(c, 0);
      const e = map.toCanonical(c, c.data.length) + 1;
      // Same degenerate-node filter as pointAtCanonical: whitespace-only,
      // fully-trimmed nodes would be marked as empty runs.
      if (c.data.trim() === "" && s === 0 && e === 1) continue;
      out.push({ node: cur as Text, s, e });
    }
    return out;
  })();
  // (canonical offset → the node whose segment brackets it) for the range
  // boundaries — pointAtCanonical does the separator snapping.
  const at = (off: number) => pointAtCanonical(root, off, map);

  for (const r of ranges) {
    const s = at(r.start);
    const e = at(r.end);
    // Walk the text nodes in document order; wrap each slice of each node
    // that overlaps [r.start, r.end) in a <mark>. Decisions are made from
    // each node's canonical span — never "everything from here on" — so a
    // boundary mid-paragraph stops the mark there instead of swallowing the
    // rest of the chapter (regression found in live use, 2026-11-02).
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    let seenStart = false;
    while ((n = w.nextNode())) {
      const t = n as Text;
      const seg = segs.find((x) => x.node === t);
      if (!seg) continue;
      if (seg.e <= r.start) continue; // ends before (or at) the range start
      if (!seenStart) {
        if (t !== s.node) continue; // not yet reached the start node
        seenStart = true;
      }
      if (seg.s >= r.end) break; // range is over
      // Overlap of this node with the range, in the node's own coordinates.
      const from = t === s.node ? s.offset : Math.max(0, r.start - seg.s);
      const to = t === e.node ? e.offset : Math.min(t.data.length, r.end - seg.s);
      if (to - from <= 0) continue;
      // Carve the covered slice out of the node: split off the unmarked
      // prefix and tail, then wrap the remainder in a <mark>. splitText
      // only touches leaf text nodes, so the walker's path is undisturbed.
      let node = t;
      if (from > 0) node = splitAt(node, from);
      if (to - from < node.data.length) splitAt(node, to - from);
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, node.data.length);
      const mark = document.createElement("mark");
      mark.setAttribute("data-testid", r.markId ?? "hl-mark");
      mark.setAttribute("data-highlight-id", r.hlId);
      mark.style.background = r.bg ?? HIGHLIGHT_BG[r.color ?? "yellow"];
      mark.style.borderRadius = "2px";
      if (r.note) mark.setAttribute("title", r.note);
      range.surroundContents(mark);
    }
  }
}

function ErrorBox({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div>
      <p style={{ color: "crimson" }} data-testid="error">{message}</p>
      <button onClick={onBack} type="button">← Back to library</button>
    </div>
  );
}

// ===========================================================================
// Slice 6 — PDF faithful reader (pdf.js canvas + text-layer highlights)
//
// The ORIGINAL bytes load through the signed range-capable URL (GET
// /v1/documents/:id/original → /v1/assets/:id), so a large PDF opens
// without a full download (SPECS §3). Highlights use the page's text-layer
// string (shared `pdfPageText` is the anchor's coordinate system, SPECS §7):
// a selection's start/end DOM points are mapped to offsets in that string,
// an anchor is built, and on re-render `resolvePdfAnchor` re-locates the
// range for the <mark> overlay.
// ===========================================================================

/** Concatenate the text layer's string (the shared pdfPageText rule): text
 *  nodes in document order, "\n" after each <br> the layer inserted. */
function walkTextLayer(el: HTMLElement, parts: string[]): void {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) {
      parts.push((n as Text).data);
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const e = n as HTMLElement;
      if (e.tagName.toLowerCase() === "br") {
        parts.push("\n");
      } else {
        walkTextLayer(e, parts);
      }
    }
  }
}

/** Text nodes in the layer, each with its [start, end) span in the string.
 *  `brAfter` = the layer put a <br> right after this node. */
function collectTextNodes(root: HTMLElement): Array<{ node: Text; start: number; end: number; brAfter: boolean }> {
  const out: Array<{ node: Text; start: number; end: number; brAfter: boolean }> = [];
  let off = 0;
  const walk = (el: HTMLElement) => {
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n as Text;
        if (t.data.length === 0) continue;
        out.push({ node: t, start: off, end: off + t.data.length, brAfter: false });
        off += t.data.length;
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const e = n as HTMLElement;
        if (e.tagName.toLowerCase() === "br") {
          off += 1;
          if (out.length > 0) out[out.length - 1]!.brAfter = true;
        } else {
          walk(e);
        }
      }
    }
  };
  walk(root);
  return out;
}

/** A DOM point (selection anchor) → offset in the layer string, or null. */
function pointToLayerString(container: Node, offset: number, isEnd: boolean, segs: Array<{ node: Text; start: number; end: number; brAfter: boolean }>): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const t = container as Text;
    if (t.data.length === 0) return null;
    const idx = segs.findIndex((s) => s.node === t);
    if (idx === -1) return null;
    return segs[idx]!.start + offset;
  }
  if (container.nodeType !== Node.ELEMENT_NODE) return null;
  const el = container as HTMLElement;
  if (el.tagName.toLowerCase() === "br") {
    const idx = segs.findIndex((s) => s.brAfter);
    // The <br> sits after the node at idx-1 (brAfter marks it).
    const brIdx = segs.findIndex((s) => s.brAfter && el === s.node.nextSibling);
    if (brIdx !== -1) return segs[brIdx]!.start;
    return idx >= 0 ? segs[idx]!.end : null;
  }
  const child = isEnd ? el.childNodes[offset - 1] ?? null : el.childNodes[offset] ?? null;
  const findFirst = (n: Node | null): Text | null => {
    if (!n) return null;
    if (n.nodeType === Node.TEXT_NODE && (n as Text).data.length > 0) return n as Text;
    for (const c of Array.from(n.childNodes)) {
      const r = findFirst(c);
      if (r) return r;
    }
    return null;
  };
  const findLast = (n: Node | null): Text | null => {
    if (!n) return null;
    for (let i = n.childNodes.length - 1; i >= 0; i--) {
      const r = findLast(n.childNodes[i] ?? null);
      if (r) return r;
    }
    if (n.nodeType === Node.TEXT_NODE && (n as Text).data.length > 0) return n as Text;
    return null;
  };
  const node = isEnd ? findLast(child) : findFirst(child);
  if (!node) return null;
  const idx = segs.findIndex((s) => s.node === node);
  if (idx === -1) return null;
  if (isEnd) {
    // Boundary at this node's end; a <br> after it belongs to "end" too.
    return segs[idx]!.brAfter ? segs[idx]!.end + 1 : segs[idx]!.end;
  }
  return segs[idx]!.start;
}

/** DOM position for a string offset (where a mark boundary goes). */
function layerStringToDom(off: number, segs: Array<{ node: Text; start: number; end: number }>): { node: Text; offset: number } | null {
  for (const s of segs) {
    if (off >= s.start && off <= s.end) {
      // A boundary on the br-after gap snaps to this node's end.
      return { node: s.node, offset: Math.min(s.end - s.start, off - s.start) };
    }
  }
  // In a <br> gap: prefer the node before it.
  let prev: (typeof segs)[number] | null = null;
  for (const s of segs) {
    if (s.end <= off) prev = s;
    else break;
  }
  if (prev) return { node: prev.node, offset: prev.end - prev.start };
  for (const s of segs) if (s.start > off) return { node: s.node, offset: 0 };
  return null;
}

interface PdfPlacedMark {
  hlId: string;
  color: HighlightColor | null;
  note: string | null;
  start: number;
  end: number;
}

/** Wrap each [start, end) slice of the text layer in <mark data-testid>. */
function placePdfMarks(root: HTMLElement, marks: PdfPlacedMark[]): void {
  const segs = collectTextNodes(root);
  for (const m of marks) {
    const s = layerStringToDom(m.start, segs);
    const e = layerStringToDom(m.end, segs);
    if (!s || !e) continue;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    let seen = false;
    while ((n = w.nextNode())) {
      const t = n as Text;
      const idx = segs.findIndex((x) => x.node === t);
      if (idx === -1) continue;
      const sg = segs[idx]!;
      if (sg.end <= m.start) continue;
      if (!seen) {
        if (t !== s.node) continue;
        seen = true;
      }
      if (sg.start >= m.end) break;
      const from = t === s.node ? s.offset : m.start - sg.start;
      const to = t === e.node ? e.offset : m.end - sg.start;
      if (to - from <= 0) continue;
      let node = t;
      if (from > 0) node = node.splitText(from);
      const len = to - from;
      if (len < node.data.length) node.splitText(len);
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, node.data.length);
      const mark = document.createElement("mark");
      mark.setAttribute("data-testid", "hl-mark");
      mark.setAttribute("data-highlight-id", m.hlId);
      mark.style.background = HIGHLIGHT_BG[m.color ?? "yellow"];
      mark.style.borderRadius = "2px";
      // The text-layer spans are color:transparent (the canvas is the ink).
      // The UA stylesheet gives <mark> color:black, which would turn the
      // highlighted glyphs opaque — invisible to the e2e text assertions but
      // very visible to the reader. Keep them transparent; only the
      // background may differ from the surrounding text.
      mark.style.color = "transparent";
      if (m.note) mark.setAttribute("title", m.note);
      range.surroundContents(mark);
    }
  }
}

/**
 * Render one page's text layer into `layer` and return the page's
 * text-layer string (the anchor coordinate system). The canvas render is
 * done by the caller (it is the race-prone, cancellation-sensitive part —
 * see the render effect) so a cancelled render never leaves a stale layer.
 *
 * The text layer mirrors pdf.js's own TextLayer positioning (transform the
 * item matrix by the page transform, place a span at the resulting % with a
 * font size from the matrix's y-scale) but is written by hand so we own the
 * DOM (needed to map selections → offsets and to wrap highlights in <mark>).
 * Font is a generic sans-serif, the same family the canvas metrics assume.
 */
const TEXT_LAYER_FONT = "sans-serif";

async function buildPdfTextLayer(
  page: PDFPageProxy,
  viewport: { width: number; height: number },
  layer: HTMLElement,
  scale: number,
): Promise<string> {
  layer.innerHTML = "";
  const content = await page.getTextContent();
  // Reusable off-screen ctx to measure each item's natural width (for
  // per-item horizontal scaling, exactly like pdf.js's TextLayer).
  const measureCtx = document.createElement("canvas").getContext("2d")!;
  const pageW = viewport.width;
  const pageH = viewport.height;
  let str = "";
  const append = (text: string) => {
    str += text;
  };

  for (const item of content.items) {
    if (!("str" in item)) continue; // skip marked-content
    const it = item as PdfTextItem;
    // transform is the item matrix in *viewport* units? No — it's in the
    // page's own coordinate space; the page transform (viewport = scale *
    // base) scales it. pdf.js applies `this.#transform` (the page→viewport
    // transform). Compute it from the viewport.
    const t = it.transform as number[];
    // Item matrix is in page units; the page→viewport transform for scale
    // `s` scales it (viewport = s × base). Compose: [a,b,c,d,e,f] → px.
    const s = scale;
    const a = (t[0] ?? 0) * s;
    const b = (t[1] ?? 0) * s;
    const d = (t[3] ?? 0) * s;
    const e = (t[4] ?? 0) * s;
    const f = (t[5] ?? 0) * s;
    const angle = Math.atan2(b, a);
    // pdf.js: fontHeight = Math.hypot(tx[2], tx[3]) of the composed
    // (page × item) matrix; for horizontal text tx[2]≈0 so ≈|d| (viewport px).
    const fh = Math.hypot((t[2] ?? 0) * s, d);
    const span = document.createElement("span");
    span.textContent = it.str;
    span.dir = it.dir;
    span.style.position = "absolute";
    span.style.whiteSpace = "pre";
    span.style.fontFamily = TEXT_LAYER_FONT;
    span.style.color = "transparent";
    span.style.cursor = "text";
    span.style.lineHeight = "1";
    span.style.fontWeight = "normal";
    span.style.fontSize = `${fh.toFixed(2)}px`;
    // left/top: pdf.js uses tx[4], tx[5] (viewport px) minus ascent.
    let left = e;
    let top = f;
    // Ascent: pdf.js multiplies fontHeight by the font's ascent ratio.
    // We approximate with 0.8 (typical Latin ascent) which aligns closely
    // enough for overlaying highlights; selection mapping is by DOM offset,
    // not pixel position, so the exact baseline is not critical.
    const ascent = fh * 0.8;
    if (angle === 0) {
      left = e;
      top = f - ascent;
    } else {
      left = e + ascent * Math.sin(angle);
      top = f - ascent * Math.cos(angle);
    }
    span.style.left = `${(100 * left / pageW).toFixed(3)}%`;
    span.style.top = `${(100 * top / pageH).toFixed(3)}%`;
    // Horizontal scale to match the canvas width of this item.
    if (it.str.length > 1 && it.width > 0 && fh > 0) {
      measureCtx.font = `${fh}px ${TEXT_LAYER_FONT}`;
      const natW = measureCtx.measureText(it.str).width;
      if (natW > 0) {
        span.style.transformOrigin = "0 0";
        const sx = (it.width * s) / natW;
        span.style.transform = `scaleX(${sx.toFixed(4)})`;
      }
    }
    layer.appendChild(span);
    append(it.str);
    if (it.hasEOL) {
      const br = document.createElement("br");
      layer.appendChild(br);
      append("\n");
    }
  }
  return str;
}

function PdfReader({ docId, onBack }: { docId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const doc = useQuery({ queryKey: ["doc", docId], queryFn: () => api.getDocument(docId), refetchInterval: 8_000 });
  const toc = useQuery({
    queryKey: ["toc", docId],
    queryFn: () => api.getToc(docId),
    enabled: doc.data?.ingestState === "ready",
  });
  const highlights = useQuery({
    queryKey: ["highlights", docId],
    queryFn: () => api.listHighlights(docId),
    enabled: doc.data?.ingestState === "ready",
  });
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const layerRef = React.useRef<HTMLDivElement | null>(null);
  const docRef = React.useRef<PDFDocumentProxy | null>(null);
  const renderSeq = React.useRef(0);
  // Promise chain serializing canvas renders (see the render effect).
  const renderChain = React.useRef<Promise<unknown>>(Promise.resolve());
  const [docVersion, setDocVersion] = React.useState(0);
  const [pdfUrl, setPdfUrl] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pageNo, setPageNo] = React.useState(1);
  const [pageText, setPageText] = React.useState<string | null>(null);
  const [pendingSel, setPendingSel] = React.useState<{ start: number; end: number; text: string } | null>(null);
  const restoredRef = React.useRef(false);

  // Fetch the signed URL of the original (pdf.js loads it with range requests).
  React.useEffect(() => {
    if (doc.data?.ingestState !== "ready") return;
    let live = true;
    api
      .getDocumentOriginal(docId)
      .then((r) => {
        if (live) setPdfUrl(r.url);
      })
      .catch((e: Error) => {
        if (live) setLoadError(e.message);
      });
    return () => {
      live = false;
    };
  }, [doc.data?.ingestState, docId]);

  // Open the document (pdf.js) once the signed URL is known. pdf.js v6:
  // getDocument takes an init object ({url}); teardown is task.destroy().
  React.useEffect(() => {
    if (!pdfUrl) return;
    let live = true;
    setLoadError(null);
    const task: PDFDocumentLoadingTask = getDocument({ url: pdfUrl });
    let doc: PDFDocumentProxy | undefined;
    task.promise
      .then((d) => {
        if (!live) return;
        doc = d;
        docRef.current = d;
        // New document: start a fresh render chain (a long chain from a
        // previous doc must not delay this one's first paint).
        renderChain.current = Promise.resolve();
        setDocVersion((v) => v + 1);
      })
      .catch((e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
      docRef.current = null;
      if (doc) void doc.cleanup().catch(() => {});
      task.destroy().catch(() => {});
    };
  }, [pdfUrl]);

  // Progress restore: a pdf locator { page, percent } → open that page.
  const progress = useQuery({
    queryKey: ["progress", docId],
    queryFn: () => api.getProgress(docId),
    enabled: doc.data?.ingestState === "ready",
  });
  React.useEffect(() => {
    if (restoredRef.current || !progress.data) return;
    restoredRef.current = true;
    const loc = progress.data.locator;
    // Stored 0-based (saveProgress sends n - 1); pageNo is 1-based.
    if (loc && loc.kind === "pdf" && loc.page > 0) setPageNo(loc.page);
  }, [progress.data]);

  const total = doc.data?.pageCount ?? 1;
  const percentFor = React.useCallback(
    (n: number) => Math.min(1, n / Math.max(1, total)),
    [total],
  );

  const saveProgress = React.useCallback(
    async (n: number) => {
      const locator = { kind: "pdf" as const, page: n - 1, percent: percentFor(n) };
      const updatedAt = new Date().toISOString();
      try {
        await api.putProgress(docId, { locator, updatedAt });
        void qc.setQueryData(["progress", docId], { locator, updatedAt });
      } catch {
        void qc.invalidateQueries({ queryKey: ["progress", docId] });
      }
    },
    [docId, percentFor, qc],
  );

  // Render the current page (canvas + text layer); save progress on change.
  // Renders are SERIALIZED through `renderChain`: each render awaits the
  // previous one and then bails if a newer request superseded it. Without
  // this, a second `page.render()` started while the first is still in flight
  // on the same canvas is rejected by pdf.js (concurrent render on one
  // canvas), so the newer page never painted and the text layer stayed stuck
  // on the previous page's content.
  React.useEffect(() => {
    const d = docRef.current;
    const canvas = canvasRef.current;
    const layer = layerRef.current;
    if (!d || !canvas || !layer) return;
    let live = true;
    const seq = ++renderSeq.current;
    renderChain.current = renderChain.current.then(async () => {
      if (!live || seq !== renderSeq.current) return; // superseded before our turn
      try {
        const p = Math.min(Math.max(1, pageNo), Math.max(1, d.numPages));
        const page = await d.getPage(p);
        if (!live || seq !== renderSeq.current) return;
        const scale = 1.4;
        const viewport = page.getViewport({ scale });
        const ratio = window.devicePixelRatio || 1;
        const cssW = Math.floor(viewport.width);
        const cssH = Math.floor(viewport.height);
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        layer.style.width = `${cssW}px`;
        layer.style.height = `${cssH}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        canvas.style.visibility = "hidden";
        const renderTask = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        });
        await renderTask.promise;
        canvas.style.visibility = "visible";
        if (!live || seq !== renderSeq.current) return; // superseded mid-render
        const text = await buildPdfTextLayer(page, viewport, layer, scale);
        if (!live || seq !== renderSeq.current) return;
        setPageText(text);
        void saveProgress(p);
      } catch (e) {
        if (live && seq === renderSeq.current)
          setLoadError(e instanceof Error ? e.message : String(e));
      }
    });
    return () => {
      live = false;
    };
  }, [pdfUrl, pageNo, docVersion, saveProgress, doc.data?.ingestState]);

  // Re-render stored highlights for the current page: resolve each pdf
  // anchor against this page's text-layer string, wrap the range in <mark>.
  // Full reconciliation: the previous run's marks are unwrapped first — a
  // page render rebuilds the layer (innerHTML=""), but highlights-list
  // changes (create/patch/delete) keep the same DOM, so without this a color
  // change double-wraps the text and a delete leaves a stale mark.
  React.useEffect(() => {
    const root = layerRef.current;
    if (!root || pageText === null) return;
    for (const mark of [...root.querySelectorAll("mark[data-testid='hl-mark']")]) {
      mark.replaceWith(...mark.childNodes);
    }
    root.normalize(); // merge the fragments left by the previous run's splits
    const marks: PdfPlacedMark[] = [];
    for (const h of highlights.data?.items ?? []) {
      if (h.anchor.kind !== "pdf" || h.anchor.page !== pageNo) continue;
      const res = resolvePdfAnchor(h.anchor, pageText);
      if (res.status !== "resolved") continue; // orphaned: listed, not drawn
      marks.push({ hlId: h.id, color: h.color, note: h.note, start: res.start, end: res.end });
    }
    if (marks.length > 0) placePdfMarks(root, marks);
  }, [highlights.data, pageNo, pageText]);

  // A selection released inside the text layer → floating save bar. Offsets
  // are in the page's text-layer string (SPECS §7: the anchor's coordinate).
  const onMouseUp = React.useCallback(() => {
    const root = layerRef.current;
    if (!root || pageText === null) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      if (sel) sel.removeAllRanges();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      sel.removeAllRanges();
      return;
    }
    const segs = collectTextNodes(root);
    const a = pointToLayerString(range.startContainer, range.startOffset, false, segs);
    const b = pointToLayerString(range.endContainer, range.endOffset, true, segs);
    if (a === null || b === null) return;
    let start = Math.min(a, b);
    let end = Math.max(a, b);
    while (start < end && pageText[start] === "\n") start++;
    while (end > start && pageText[end - 1] === "\n") end--;
    if (end <= start) {
      sel.removeAllRanges();
      return;
    }
    setPendingSel({ start, end, text: pageText.slice(start, end) });
  }, [pageText]);

  const createHighlight = useMutation({
    mutationFn: (body: PostHighlightBody) => api.createHighlight(body),
    onSuccess: () => {
      setPendingSel(null);
      window.getSelection()?.removeAllRanges();
      void qc.invalidateQueries({ queryKey: ["highlights", docId] });
    },
  });
  const patchHighlight = useMutation({
    mutationFn: (a: { id: string; body: PatchHighlightBody }) => api.patchHighlight(a.id, a.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["highlights", docId] }),
  });
  const deleteHighlight = useMutation({
    mutationFn: (id: string) => api.deleteHighlight(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["highlights", docId] }),
  });

  const [showHighlights, setShowHighlights] = React.useState(false);

  const d = doc.data;
  if (doc.isError) return <ErrorBox message={String(doc.error)} onBack={onBack} />;
  if (!d) return <p data-testid="reader-loading">Loading…</p>;
  if (d.ingestState === "failed")
    return (
      <div>
        <BackBar onBack={onBack} title={d.title} />
        <p style={{ color: "crimson" }}>Couldn't process this PDF: {d.ingestError ?? "unknown error"}</p>
      </div>
    );
  if (d.ingestState !== "ready")
    return (
      <div>
        <BackBar onBack={onBack} title={d.title} />
        <p data-testid="processing">Processing your PDF… this usually takes a few seconds.</p>
      </div>
    );

  const goPage = (n: number) => setPageNo(Math.min(Math.max(1, n), Math.max(1, total)));

  return (
    <div data-testid="reader" style={{ background: "#f2f2f2", borderRadius: 12, padding: 16 }}>
      <BackBar onBack={onBack} title={d.title} onHighlights={() => setShowHighlights(true)} />
      <h1 style={{ margin: "0 0 4px", fontSize: 20 }}>{d.title}</h1>
      {d.pageCount ? (
        <p style={{ opacity: 0.5, fontSize: 13, margin: 0 }} data-testid="pdf-page-count">
          {d.pageCount} pages
        </p>
      ) : null}
      {d.pdfHasText === false ? (
        <p
          data-testid="pdf-no-text"
          style={{
            margin: "8px 0 0",
            padding: "10px 12px",
            background: "#fff8e1",
            border: "1px solid #ffe082",
            borderRadius: 8,
            fontSize: 14,
          }}
        >
          This PDF has no text layer (it looks scanned), so highlights are disabled. You can still
          page through it below.
        </p>
      ) : null}
      {toc.data?.items.length ? (
        <details data-testid="toc" style={{ marginTop: 8 }} open>
          <summary style={{ cursor: "pointer", fontSize: 14 }}>Contents</summary>
          <PdfTocTree
            entries={toc.data.items}
            onPick={(page) => {
              if (page) goPage(page);
            }}
          />
        </details>
      ) : null}

      <div
        data-testid="pdf-page"
        style={{ position: "relative", margin: "16px auto", width: "fit-content", boxShadow: "0 2px 12px #0003" }}
      >
        <canvas
          data-testid="pdf-canvas"
          ref={canvasRef}
          style={{ display: "block", background: "#fff" }}
        />
        <div
          data-testid="pdf-text-layer"
          className="textLayer"
          onMouseUp={onMouseUp}
          // Overlay the canvas (spans inside are absolutely positioned by
          // buildPdfTextLayer; the parent .pdf-page is position:relative).
          style={{ position: "absolute", inset: 0, overflow: "hidden", cursor: "text" }}
          ref={layerRef}
        />
      </div>
      {loadError ? (
        <p style={{ color: "crimson", margin: "12px 0 0" }} data-testid="pdf-error">
          {loadError}
        </p>
      ) : null}

      {pendingSel ? (
        <div
          data-testid="save-highlight-bar"
          style={{
            position: "sticky",
            bottom: 8,
            margin: "12px 0 0",
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "8px 12px",
            background: "rgba(0,0,0,0.75)",
            color: "#fff",
            borderRadius: 10,
            fontSize: 14,
          }}
        >
          <span data-testid="save-highlight-preview" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            “{pendingSel.text.slice(0, 80)}{pendingSel.text.length > 80 ? "…" : ""}”
          </span>
          <button
            data-testid="save-highlight-btn"
            disabled={createHighlight.isPending}
            onClick={() => {
              const anchor = buildPdfAnchor(pageNo, { start: pendingSel.start, end: pendingSel.end }, pageText!);
              createHighlight.mutate({ documentId: docId, anchor, exact: anchor.exact, color: null, note: null });
            }}
          >
            {createHighlight.isPending ? "Saving…" : "Highlight"}
          </button>
          <button data-testid="cancel-highlight-btn" onClick={() => { setPendingSel(null); window.getSelection()?.removeAllRanges(); }}>
            Cancel
          </button>
        </div>
      ) : null}

      {showHighlights ? (
        <HighlightsPanel
          docId={docId}
          items={highlights.data?.items ?? []}
          onClose={() => setShowHighlights(false)}
          onColor={(id, color) => patchHighlight.mutate({ id, body: { color } })}
          onNote={(id, note) => patchHighlight.mutate({ id, body: { note } })}
          onDelete={(id) => deleteHighlight.mutate(id)}
          deleting={deleteHighlight.isPending}
        />
      ) : null}

      <Pager
        prevId={pageNo > 1 ? "prev" : null}
        nextId={pageNo < total ? "next" : null}
        onNav={(dir) => goPage(dir === "prev" ? pageNo - 1 : pageNo + 1)}
        middle={
          <span data-testid="pdf-page-indicator" style={{ fontSize: 14 }}>
            Page {pageNo} / {total}
          </span>
        }
      />
    </div>
  );
}

/** The PDF outline (toc_entries with page destinations) as a clickable tree. */
function PdfTocTree({ entries, onPick }: { entries: TocEntryDto[]; onPick: (page: number) => void }) {
  const byParent = React.useMemo(() => {
    const ids = new Set(entries.map((e) => e.id));
    const map = new Map<string | null, TocEntryDto[]>();
    for (const e of entries) {
      const key = e.parentId && ids.has(e.parentId) ? e.parentId : null;
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }
    return map;
  }, [entries]);

  const render = (parentId: string | null): React.ReactNode => {
    const kids = byParent.get(parentId) ?? [];
    if (!kids.length) return null;
    return (
      <ul style={{ margin: "4px 0", paddingLeft: 18, fontSize: 14 }}>
        {kids.map((t) => (
          <li key={t.id} style={{ marginBottom: 2 }}>
            {t.page ? (
              <a
                href="#pdf-page"
                data-testid="toc-page-link"
                onClick={(e) => {
                  e.preventDefault();
                  onPick(t.page!);
                }}
              >
                {t.label}
              </a>
            ) : (
              <span style={{ opacity: 0.6 }}>{t.label}</span>
            )}
            {render(t.id)}
          </li>
        ))}
      </ul>
    );
  };
  return <div>{render(null)}</div>;
}

function OpenDocView({ docId, initialSectionId, onBack }: { docId: string; initialSectionId?: string | null; onBack: () => void }) {
  // Fetch the document (light) to know which reader to mount: PDFs go to
  // the faithful pdf.js reader, epub/article to the reflow reader.
  const doc = useQuery({ queryKey: ["doc", docId], queryFn: () => api.getDocument(docId) });
  if (doc.isError) return <ErrorBox message={String(doc.error)} onBack={onBack} />;
  if (!doc.data) return <p data-testid="reader-loading">Loading…</p>;
  if (doc.data.type === "pdf") return <PdfReader docId={docId} onBack={onBack} />;
  return <Reader docId={docId} initialSectionId={initialSectionId ?? null} onBack={onBack} />;
}

/**
 * Slice 7 settings: the OpenAI key (required for TTS) and the TTS voice.
 * The key is stored server-side encrypted (RDR1) and never returned — only
 * the last-4 digits show. Voice/model changes apply to future TTS requests
 * (the cache key includes model+voice, so old audio is still served).
 */
function SettingsModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const [keyInput, setKeyInput] = React.useState("");
  const [keyMsg, setKeyMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const putKey = useMutation({
    mutationFn: (key: string) => api.putOpenAiKey({ key }),
    onSuccess: (res) => {
      void qc.setQueryData(["settings"], res);
      setKeyInput("");
      setKeyMsg({ ok: true, text: `Key saved (…${res.openaiKeyLast4}). TTS is ready.` });
    },
    onError: (err) => setKeyMsg({ ok: false, text: (err as Error).message }),
  });
  const delKey = useMutation({
    mutationFn: api.deleteOpenAiKey,
    onSuccess: (res) => {
      void qc.setQueryData(["settings"], res);
      setKeyMsg({ ok: true, text: "Key removed." });
    },
  });
  const setVoice = useMutation({
    mutationFn: (voice: TtsVoice) => api.putSettings({ ttsVoice: voice }),
    onSuccess: (res) => void qc.setQueryData(["settings"], res),
  });
  const s = settings.data;
  return (
    <div
      role="dialog"
      aria-label="Settings"
      data-testid="settings-modal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={{ background: "#fff", color: "#111", borderRadius: 12, padding: 20, width: "min(480px, 92vw)", boxShadow: "0 8px 30px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>Settings</h2>
          <button type="button" onClick={onClose} data-testid="settings-close" style={{ border: "none", background: "none", fontSize: 20, cursor: "pointer" }}>
            ✕
          </button>
        </div>

        <h3 style={{ margin: "14px 0 6px", fontSize: 15 }}>Text-to-speech (OpenAI)</h3>
        <p style={{ fontSize: 13, opacity: 0.7, margin: "0 0 8px" }}>
          TTS needs your own OpenAI API key. It is stored encrypted on your account and used only for your requests.
        </p>
        {s?.openaiKeyLast4 ? (
          <p style={{ fontSize: 14 }}>
            Current key: <code>…{s.openaiKeyLast4}</code>{" "}
            <button type="button" data-testid="settings-delkey" disabled={delKey.isPending} onClick={() => delKey.mutate()} style={{ fontSize: 13 }}>
              Remove
            </button>
          </p>
        ) : (
          <p style={{ fontSize: 14, color: "#8a5a00" }}>No key saved yet — TTS won't work until you add one.</p>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            data-testid="settings-key"
            type="password"
            placeholder="sk-…"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            style={{ flex: 1, padding: "6px 10px", borderRadius: 8, border: "1px solid #ccc" }}
          />
          <button
            type="button"
            data-testid="settings-savekey"
            disabled={!keyInput.trim() || putKey.isPending}
            onClick={() => putKey.mutate(keyInput.trim())}
            style={{ padding: "6px 14px", borderRadius: 8 }}
          >
            {putKey.isPending ? "Saving…" : "Save key"}
          </button>
        </div>
        {keyMsg ? (
          <p data-testid="settings-keymsg" style={{ fontSize: 13, marginTop: 6, color: keyMsg.ok ? "#1a7f37" : "#c0392b" }}>
            {keyMsg.text}
          </p>
        ) : null}

        <h3 style={{ margin: "18px 0 6px", fontSize: 15 }}>Voice</h3>
        <select
          data-testid="settings-voice"
          value={s?.ttsVoice ?? TTS_DEFAULT_VOICE}
          disabled={setVoice.isPending}
          onChange={(e) => setVoice.mutate(e.target.value as TtsVoice)}
          style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #ccc" }}
        >
          {TTS_VOICES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        {s ? (
          <p style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>
            Model: {s.ttsModel} · Audio format: mp3
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SignedIn() {
  const me = useMe();
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
  const [openDoc, setOpenDoc] = React.useState<{ id: string; sectionId?: string | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  React.useEffect(() => {
    if (openDoc) window.scrollTo(0, 0);
  }, [openDoc]);

  if (me.data) {
    return (
      <div data-testid="signed-in" style={{ width: openDoc ? "min(900px, 96vw)" : "min(720px, 92vw)", margin: "4vh auto", padding: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h1 style={{ fontSize: 26, margin: 0 }}>Personal Reader</h1>
          <span id="hello" style={{ opacity: 0.7, fontSize: 14 }}>Hello {me.data.email}</span>
          <button onClick={() => setSettingsOpen(true)} disabled={settingsOpen} data-testid="settings-btn" style={{ opacity: 0.7, marginRight: 12 }}>
            Settings
          </button>
          <button onClick={() => logout.mutate()} disabled={logout.isPending} data-testid="logout-btn" style={{ opacity: 0.7 }}>
            Log out
          </button>
        </div>
        {settingsOpen ? <SettingsModal onClose={() => setSettingsOpen(false)} /> : null}
        <HealthLine />
        {openDoc ? (
          <OpenDocView docId={openDoc.id} initialSectionId={openDoc.sectionId ?? null} onBack={() => setOpenDoc(null)} />
        ) : (
          <Library onOpen={(id, sectionId) => setOpenDoc({ id, sectionId: sectionId ?? null })} />
        )}
      </div>
    );
  }
  return <p data-testid="loading">…</p>;
}

function App() {
  const me = useMe();
  return (
    <main style={{ fontFamily: "system-ui, sans-serif" }}>
      {me.data ? (
        <SignedIn />
      ) : (
        <div style={{ maxWidth: 480, margin: "8vh auto", padding: 24 }}>
          <h1 style={{ fontSize: 28 }}>Personal Reader</h1>
          <HealthLine />
          <LoginForm />
        </div>
      )}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
