import { test, expect, type Page, type Response } from "@playwright/test";
import { login } from "./mailbox.js";
import { ensureOpenAiMock, OPENAI_MOCK_URL } from "./openai-server.js";

// Slice 7 e2e: the full TTS loop through the real UI + real worker + a
// loopback mock of OpenAI's speech endpoint (CI never calls the real API):
//
//   1. open the fixture book WITHOUT an OpenAI key -> toggle TTS -> the panel
//      shows the no-key error (409 no_openai_key) with a link to Settings.
//   2. save a (fake) key in the Settings modal -> toggle TTS again -> the
//      chunk list loads, POST /v1/tts queues a job, the worker asks the mock
//      for audio, and the chunk's text is wrapped in a tts-mark highlight.
//   3. stepping to the next chunk synthesizes ONE more mock call; stopping and
//      re-enabling replays BOTH chunks from cache: the mock's request counter
//      must NOT increase (the cache hit is the point).
//
// Chunk layout: the reader's section canonical text splits on blocks, so
// Chapter One ("The first chapter begins here…" chapter) has exactly THREE
// chunks: the <h2> heading, then the two <p>s (the <img> contributes no
// text). The <audio> elements request their signed MP3 URLs through the page
// context, so the network log proves the signed-URL audio path was exercised.
//
// The worker (RDR_ENV=ci) runs with OPENAI_API_BASE_URL pointed at the mock
// (started here; the mock is loopback, allowed in ci like the article
// fixture). The fixture book is the same one documents.spec.ts uploaded
// earlier in the run — no re-upload (no dedup on upload; a second copy would
// duplicate the library row).

// Fake key: a synthetic e2e fixture (no real credential). It must match
// looksLikeOpenAiKey (^sk-(proj-)?[A-Za-z0-9_-]{16,}$) or the API rejects it
// with 400 before it is ever stored; the mock ignores auth entirely.
const FAKE_KEY = "***";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await ensureOpenAiMock();
});

async function mockSpeechRequests(page: Page): Promise<number> {
  return page
    .request
    .get(`${OPENAI_MOCK_URL}/stats`)
    .then((r) => r.json())
    .then((j: { speechRequests: number }) => j.speechRequests);
}

/** Resolve once the page receives an audio/* response (the <audio> element
 *  fetching its signed /v1/tts-audio MP3) or reject after the timeout. */
function expectAudioFetched(page: Page, timeoutMs = 45_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      page.off("response", onResp);
      reject(new Error("no audio response (signed TTS URL) was fetched"));
    }, timeoutMs);
    const onResp = (r: Response) => {
      void r
        .headerValue("content-type")
        .then((ct) => {
          if (ct.startsWith("audio/") && r.status() < 500) {
            clearTimeout(timer);
            page.off("response", onResp);
            resolve();
          }
        })
        .catch(() => undefined);
    };
    page.on("response", onResp);
  });
}

test("tts: no-key error, synthesize via worker, sentence highlight, cache hit", async ({ page }) => {
  await login(page);

  // Open the book documents.spec.ts uploaded earlier in the run.
  const docRow = page.getByTestId("doc-row").filter({ hasText: "Night Fixture Book" }).first();
  await expect(docRow.getByTestId("doc-state")).toHaveText("ready", { timeout: 30_000 });
  await docRow.click();
  await expect(page.getByTestId("reader")).toBeVisible();

  // progress.spec (earlier in the run) saved this book's reading position at
  // Chapter One, so the reader restores there; fall back to the TOC if it
  // ever lands elsewhere.
  const section = page.getByTestId("section");
  await expect(section).toBeVisible();
  const inChapterOne = await (async () => {
    try {
      await expect
        .poll(async () => (await section.allTextContents()).join(" ").includes("first chapter begins here"), {
          timeout: 15_000,
          intervals: [300],
        })
        .toBe(true);
      return true;
    } catch {
      return false;
    }
  })();
  if (!inChapterOne) {
    await page.getByTestId("toc").getByRole("link", { name: "Chapter One" }).click();
  }
  await expect(section).toContainText("first chapter begins here");

  // ---- 1. No key yet: toggling TTS surfaces the 409 with a Settings link.
  await page.getByTestId("tts-toggle-btn").click();
  await expect(page.getByTestId("tts-panel")).toBeVisible();
  await expect(page.getByTestId("tts-error")).toContainText("OpenAI");
  await expect(page.getByTestId("tts-settings-link")).toBeVisible();
  // Nothing may have been sent to OpenAI.
  expect(await mockSpeechRequests(page)).toBe(0);

  // ---- 2. Save a key in the Settings modal (top-bar Settings button).
  await page.getByTestId("settings-btn").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.getByTestId("settings-key").fill(FAKE_KEY);
  // TEMP debug (slice 7 e2e): what did the input actually end up with?
  console.log("TTS-DEBUG input value length:", (await page.getByTestId("settings-key").inputValue()).length);
  await page.getByTestId("settings-savekey").click();
  await expect(page.getByTestId("settings-keymsg")).toBeVisible({ timeout: 10_000 });
  console.log("TTS-DEBUG keymsg:", await page.getByTestId("settings-keymsg").textContent());
  await expect(page.getByTestId("settings-keymsg")).toContainText("Key saved", { timeout: 10_000 });
  // The voice select lists the shared voice list (13 options).
  await expect(page.getByTestId("settings-voice").locator("option")).toHaveCount(13);
  await page.getByTestId("settings-close").click();

  // Re-enable TTS: the panel loads the chunk list (three chunks: heading +
  // two paragraphs) and plays chunk 1. (Stop first — the panel is still on
  // from step 1, so a single toggle click would just turn it off.)
  await page.getByTestId("tts-stop-btn").click();
  await page.getByTestId("tts-toggle-btn").click();
  await expect(page.getByTestId("tts-panel")).toBeVisible();
  await expect(page.getByTestId("tts-error")).toHaveCount(0);
  await expect(page.getByTestId("tts-progress")).toContainText("Chunk 1 / 3", { timeout: 30_000 });
  // Chunk 1 is the <h2>; the worker synthesizes via the mock and the first
  // sentence of the chunk gets the tts-mark highlight.
  await expect(page.locator('[data-testid="tts-mark"]')).toHaveCount(1, { timeout: 45_000 });
  await expect(page.locator('[data-testid="tts-mark"]')).toHaveText("Chapter One");
  await expectAudioFetched(page);
  // Exactly one speech call so far.
  await expect.poll(() => mockSpeechRequests(page), { timeout: 15_000, intervals: [500] }).toBe(1);

  // ---- Step to chunk 2 (the first paragraph): one more mock call.
  await page.getByTestId("tts-next-btn").click();
  await expect(page.getByTestId("tts-progress")).toContainText("Chunk 2 / 3");
  await expect(page.locator('[data-testid="tts-mark"]')).toHaveCount(1, { timeout: 45_000 });
  // The highlight wraps the chunk's FIRST sentence (SPECS §10 sentence
  // highlighting), not the whole paragraph.
  await expect(page.locator('[data-testid="tts-mark"]')).toHaveText("The first chapter begins here.");
  await expectAudioFetched(page);
  await expect.poll(() => mockSpeechRequests(page), { timeout: 30_000, intervals: [500] }).toBe(2);

  // ---- 3. Stop and re-enable: chunk 1 replays from cache.
  await page.getByTestId("tts-stop-btn").click();
  await expect(page.getByTestId("tts-panel")).toHaveCount(0);
  await page.getByTestId("tts-toggle-btn").click();
  await expect(page.getByTestId("tts-panel")).toBeVisible();
  await expect(page.getByTestId("tts-progress")).toContainText("Chunk 1 / 3", { timeout: 30_000 });
  await expect(page.locator('[data-testid="tts-mark"]')).toHaveCount(1, { timeout: 45_000 });
  await expect(page.locator('[data-testid="tts-mark"]')).toHaveText("Chapter One");
  // (No expectAudioFetched here: the replay reuses the SAME signed URL the
  //  browser already fetched, so Chromium may serve it from its disk cache
  //  without a network response — the counter below is the real assertion.)
  // Wait a beat for any (wrong) replay to reach the mock, then assert none did.
  await expect.poll(() => mockSpeechRequests(page), { timeout: 10_000, intervals: [500] }).toBe(2);
  // Still exactly two requests ever: the replay was served from the cache.
  await new Promise((r) => setTimeout(r, 3_000));
  expect(await mockSpeechRequests(page)).toBe(2);
});
