// Idempotent starter for the slice 5 article fixture server (loopback,
// allowed for the worker only under RDR_ENV=ci). Started once per e2e run;
// if a listener already answers on the port, this is a no-op.
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

export const ARTICLE_PORT = Number(process.env.E2E_ARTICLE_PORT ?? 3210);
export const ARTICLE_URL = `http://127.0.0.1:${ARTICLE_PORT}/article.html`;

let proc: ChildProcess | null = null;

function portOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port: ARTICLE_PORT });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureArticleServer(): Promise<void> {
  if (await portOpen()) return;
  const root = process.env.REPO_ROOT;
  if (!root) throw new Error("REPO_ROOT not set");
  proc = spawn("node", ["e2e/tools/article-server.mjs"], {
    cwd: root,
    stdio: "ignore",
    detached: true,
  });
  proc.unref();
  for (let i = 0; i < 40; i++) {
    if (await portOpen()) return;
    await sleep(250);
  }
  throw new Error("article fixture server did not start");
}
