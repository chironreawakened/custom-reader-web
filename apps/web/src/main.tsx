import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./api";

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
  return <p id="health" style={{ opacity: 0.6 }}>{text}</p>;
}

function CodeInput({
  onDone,
  error,
}: {
  onDone: (code: string) => void;
  error: string | null;
}) {
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
            style={{
              width: 44,
              height: 56,
              fontSize: 24,
              textAlign: "center",
              font: "24px/1.2 monospace",
            }}
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
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

function SignedIn() {
  const me = useMe();
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["me"] }),
  });

  if (me.data) {
    return (
      <div data-testid="signed-in">
        <h2 id="hello">Hello {me.data.email}</h2>
        <p style={{ opacity: 0.8 }}>Member since {new Date(me.data.createdAt).toLocaleDateString()}</p>
        <button onClick={() => logout.mutate()} disabled={logout.isPending} data-testid="logout-btn">
          Log out
        </button>
      </div>
    );
  }
  return <p data-testid="loading">…</p>;
}

function App() {
  const me = useMe();
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 480, margin: "8vh auto", padding: 24 }}>
      <h1 style={{ fontSize: 28 }}>Personal Reader</h1>
      <HealthLine />
      {me.data ? <SignedIn /> : <LoginForm />}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
