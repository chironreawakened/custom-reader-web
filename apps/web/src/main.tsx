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

function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const docs = useQuery({ queryKey: ["documents"], queryFn: api.listDocuments, refetchInterval: 10_000 });
  const queryClient = useQueryClient();
  const items = docs.data?.items ?? [];
  return (
    <div data-testid="library">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "12px 0" }}>
        <h2 style={{ margin: 0 }}>Library</h2>
        <UploadButton onUploaded={() => void queryClient.invalidateQueries({ queryKey: ["documents"] })} />
      </div>
      {docs.isError ? (
        <p style={{ color: "crimson" }} data-testid="library-error">{String(docs.error)}</p>
      ) : items.length === 0 ? (
        <p style={{ opacity: 0.7 }} data-testid="library-empty">
          No books yet. Upload an EPUB to get started.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
          {items.map((d) => (
            <li key={d.id}>
              <button
                onClick={() => onOpen(d.id)}
                data-testid="doc-row"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  width: "100%",
                  padding: "12px 14px",
                  border: "1px solid #e0e0e0",
                  borderRadius: 10,
                  background: "#fff",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{d.title || "Untitled"}</div>
                  {d.author ? <div style={{ opacity: 0.7, fontSize: 13 }}>{d.author}</div> : null}
                </div>
                <IngestBadge state={d.ingestState} error={d.ingestError} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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

  const [sectionId, setSectionId] = React.useState<string | null>(null);
  // Default to the first section once the list is loaded.
  React.useEffect(() => {
    if (!sectionId && sections.data?.items.length) setSectionId(sections.data.items[0]!.id);
  }, [sections.data, sectionId]);

  const section = useQuery({
    queryKey: ["section", docId, sectionId],
    queryFn: () => api.getSection(docId, sectionId!),
    enabled: !!sectionId,
  });

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

  return (
    <div data-testid="reader">
      <BackBar onBack={onBack} title={d.title} />
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
          {toc.data?.items.length ? (
            <details data-testid="toc" style={{ marginTop: 8 }} open>
              <summary style={{ cursor: "pointer", fontSize: 14 }}>Contents</summary>
              <ul style={{ margin: "6px 0", paddingLeft: 18, fontSize: 14 }}>
                {toc.data.items.map((t) => (
                  <li key={t.id} style={{ marginBottom: 2 }}>
                    {t.sectionId ? (
                      <a href={`#sec-${t.sectionId}`} onClick={(e) => { e.preventDefault(); setSectionId(t.sectionId!); }}>
                        {t.label}
                      </a>
                    ) : (
                      <span style={{ opacity: 0.6 }}>{t.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </div>

      <div id="content" style={{ marginTop: 20, lineHeight: 1.7 }}>
        {section.isError ? (
          <ErrorBox message={String(section.error)} onBack={() => setSectionId(null)} />
        ) : section.data ? (
          <article
            data-testid="section"
            // Server-side sanitized (slice 1 sanitizer) with asset URLs rewritten to signed URLs.
            dangerouslySetInnerHTML={{ __html: section.data.html }}
          />
        ) : (
          <p data-testid="section-loading">Loading section…</p>
        )}
      </div>

      <Pager
        prevId={section.data?.prevSectionId ?? null}
        nextId={section.data?.nextSectionId ?? null}
        onNav={setSectionId}
      />
    </div>
  );
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

function BackBar({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <button onClick={onBack} type="button" data-testid="back-btn" style={{ padding: "6px 12px", borderRadius: 8 }}>
        ← Library
      </button>
      <span style={{ opacity: 0.5, fontSize: 13, marginLeft: 10 }}>{title}</span>
    </div>
  );
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
