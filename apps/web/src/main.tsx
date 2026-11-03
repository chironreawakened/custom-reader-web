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
import type { PatchHighlightBody, PostHighlightBody } from "@reader/shared/highlights";
// Value imports go through subpaths: the shared barrel re-exports node-only
// crypto modules (rdr1, asset-url) that the browser bundle must not reach.
import {
  buildReflowAnchor,
  HIGHLIGHT_COLORS,
  resolveAnchor,
  type CanonicalSelection,
  type HighlightColor,
} from "@reader/shared/anchors";
import { canonicalText, type CanonicalMap, type CTRoot } from "@reader/shared/canonical-text";
// Subpath import: the shared barrel re-exports node-only crypto modules
// (rdr1, asset-url) that the browser bundle must not reach.
import { DEFAULT_READER_PREFS, MAX_FONT_SIZE, MIN_FONT_SIZE, type ReaderTheme } from "@reader/shared/settings";

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
      {upload.isPending ? "Uploading…" : "Upload EPUB"}
      <input
        type="file"
        accept="application/epub+zip,.epub"
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

function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [filterTag, setFilterTag] = React.useState<string | null>(null);
  const docs = useQuery({
    queryKey: ["documents", filterTag ?? ""],
    queryFn: () => api.listDocuments(filterTag ?? undefined),
    refetchInterval: 10_000,
  });
  const allTags = useQuery({ queryKey: ["tags"], queryFn: api.listTags, staleTime: 30_000 });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["documents"] });
  const items = docs.data?.items ?? [];
  const tagNames = (allTags.data?.items ?? []).map((t) => t.name);
  return (
    <div data-testid="library">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0" }}>
        <h2 style={{ margin: 0 }}>Library</h2>
        <span style={{ display: "inline-flex", gap: 8 }}>
          <AddUrlButton onAdded={() => invalidate()} />
          <UploadButton onUploaded={() => invalidate()} />
        </span>
      </div>
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
          No books yet. Upload an EPUB or add an article URL to get started.
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
              {doc.type === "article" ? <span style={{ opacity: 0.5, fontSize: 12, marginLeft: 6 }}>article</span> : null}
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

function Reader({ docId, onBack }: { docId: string; onBack: () => void }) {
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
    mutationFn: (prefs: { theme: ReaderTheme; fontSize: number }) =>
      api.putSettings({ readerPrefs: prefs }),
    onSuccess: (res) => void qc.setQueryData(["settings"], res),
  });

  const [sectionId, setSectionId] = React.useState<string | null>(null);
  const restoredRef = React.useRef(false);
  const [pendingScroll, setPendingScroll] = React.useState<number | null>(null);

  // Progress restore (slice 3): once the section list + saved spot are known,
  // open the saved section and scroll to the saved offset — once per book open.
  React.useEffect(() => {
    if (restoredRef.current || !sections.data || !progress.data) return;
    restoredRef.current = true;
    const loc = progress.data.locator;
    if (!loc || loc.kind !== "reflow") return;
    const idx = sections.data.items.findIndex((s) => s.id === loc.sectionId);
    if (idx === -1) return; // saved spot points at a stale section
    setSectionId(loc.sectionId);
    if (loc.offset > 0) setPendingScroll(loc.offset);
  }, [sections.data, progress.data]);

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
      <BackBar onBack={onBack} title={d.title} onHighlights={() => setShowHighlights(true)} />
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
          <button data-testid="cancel-highlight-btn" onClick={() => setPendingSel(null)}>
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
}: {
  prevId: string | null;
  nextId: string | null;
  onNav: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24, gap: 12 }}>
      <button disabled={!prevId} onClick={() => prevId && onNav(prevId)} data-testid="prev-btn">
        ← Previous
      </button>
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

function BackBar({ onBack, title, onHighlights }: { onBack: () => void; title: string; onHighlights?: () => void }) {
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
}

/** Remove hl-marks previously placed by this module (unwrap, keep text). */
function clearMarks(root: HTMLElement): void {
  const marks = root.querySelectorAll("mark[data-testid='hl-mark']");
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
    segs.push({ node: cur, s: map.toCanonical(c, 0), e: map.toCanonical(c, cur.data.length) + 1 });
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
      out.push({ node: cur as Text, s: map.toCanonical(c, 0), e: map.toCanonical(c, c.data.length) + 1 });
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
      mark.setAttribute("data-testid", "hl-mark");
      mark.setAttribute("data-highlight-id", r.hlId);
      mark.style.background = HIGHLIGHT_BG[r.color ?? "yellow"];
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

function SignedIn() {
  const me = useMe();
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
  const [openDoc, setOpenDoc] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (openDoc) window.scrollTo(0, 0);
  }, [openDoc]);

  if (me.data) {
    return (
      <div data-testid="signed-in" style={{ width: "min(720px, 92vw)", margin: "4vh auto", padding: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h1 style={{ fontSize: 26, margin: 0 }}>Personal Reader</h1>
          <span id="hello" style={{ opacity: 0.7, fontSize: 14 }}>Hello {me.data.email}</span>
          <button onClick={() => logout.mutate()} disabled={logout.isPending} data-testid="logout-btn" style={{ opacity: 0.7 }}>
            Log out
          </button>
        </div>
        <HealthLine />
        {openDoc ? (
          <Reader docId={openDoc} onBack={() => setOpenDoc(null)} />
        ) : (
          <Library onOpen={setOpenDoc} />
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
