import React from "react";
import ReactDOM from "react-dom/client";

async function health() {
  try {
    const res = await fetch("/v1/health");
    const body = await res.json();
    return body;
  } catch {
    return { api: "fail" as const };
  }
}

function App() {
  React.useEffect(() => {
    void health().then((h: any) => {
      document.getElementById("out")!.textContent =
        "api " + (h.api ?? "?") +
        " / db " + (h.db ?? "?") +
        " / storage " + (h.storage ?? "?");
    });
  }, []);
  return <main style={{ font: "16px/1.5 monospace", padding: 24 }}>
    <h1>Personal Reader</h1>
    <p id="out">checking…</p>
  </main>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
