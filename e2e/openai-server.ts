// Idempotent starter for the slice 7 mock OpenAI speech server (loopback).
// The CI worker runs with OPENAI_API_BASE_URL=http://127.0.0.1:PORT so the
// TTS chunk job's /v1/audio/speech call is answered locally — the same
// pattern as HIPPUS_ENDPOINT → s3mock. Started once per e2e run; if a
// listener already answers on the port, this is a no-op.
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

export const OPENAI_MOCK_PORT = Number(process.env.E2E_OPENAI_PORT ?? 3220);
export const OPENAI_MOCK_URL = `http://127.0.0.1:${OPENAI_MOCK_PORT}`;

let proc: ChildProcess | null = null;

function portOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port: OPENAI_MOCK_PORT });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureOpenAiMock(): Promise<void> {
  if (await portOpen()) return;
  const root = process.env.REPO_ROOT;
  if (!root) throw new Error("REPO_ROOT not set");
  proc = spawn("node", ["e2e/tools/openai-mock.mjs"], {
    cwd: root,
    stdio: "ignore",
    detached: true,
  });
  proc.unref();
  for (let i = 0; i < 40; i++) {
    if (await portOpen()) return;
    await sleep(250);
  }
  throw new Error("openai mock server did not start");
}
