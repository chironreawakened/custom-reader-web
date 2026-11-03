/**
 * Slice 5 e2e fixture: a tiny loopback server that serves a single article
 * page (mirroring the extract unit-test fixture) plus one 1x1 PNG. The
 * worker runs with RDR_ENV=ci, where safe-fetch vetoes loopback in prod but
 * allows it here (SPECS §12: ci stacks host the fixture on loopback).
 *
 * Started by e2e/article-server.ts (ensureArticleServer) — idempotent: if
 * something is already listening on the port it is left alone.
 */
import http from "node:http";

export const ARTICLE_PORT = Number(process.env.E2E_ARTICLE_PORT ?? 3210);

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ARTICLE_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Test Article Headline — E2E News</title>
  <meta name="author" content="E2E Author">
</head>
<body>
  <header><nav><a href="/">Home</a></nav></header>
  <article>
    <h1>Test Article Headline</h1>
    <p class="byline">By E2E Author, November 3, 2026</p>
    <p>The lighthouse keeper walked the spiral stairs at night, counting every
    step so that the lamp would keep turning through the fog. Below, the sea
    moved slowly against the black rocks, and the only sound on the headland
    was the creak of the old railing.</p>
    <figure><img src="/pixel.png" alt="a test pixel" /></figure>
    <p>When the storm cleared in the morning, the harbour was full of boats
    again, and the keeper went down to the coffee queue with everyone else,
    his coat still wet from the gallery deck.</p>
  </article>
  <footer><p>E2E News</p></footer>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/article.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(ARTICLE_HTML);
  } else if (req.url === "/pixel.png") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from(PIXEL_PNG, "base64"));
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(ARTICLE_PORT, "127.0.0.1", () => {
  console.log(`[article-fixture] listening on http://127.0.0.1:${ARTICLE_PORT}/article.html`);
});
