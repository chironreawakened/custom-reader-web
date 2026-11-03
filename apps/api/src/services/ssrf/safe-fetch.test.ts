import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { isBlockedAddress, resolveVettedAddress, safeFetch, SsrfError } from "./safe-fetch.js";

const servers: Array<ReturnType<typeof createServer>> = [];
function startServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise((r) => s.close(r));
  }
});

describe("isBlockedAddress", () => {
  it("blocks RFC1918, loopback, link-local, CGNAT and reserved IPv4", () => {
    for (const ip of [
      "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", "100.64.0.1", "100.127.255.255",
      "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    ]) {
      expect(isBlockedAddress(ip, false), ip).toBe(true);
    }
  });
  it("allows public IPv4", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "203.0.112.2"]) {
      expect(isBlockedAddress(ip, false), ip).toBe(false);
    }
  });
  it("blocks loopback unless allowLoopback (RDR_ENV=ci)", () => {
    expect(isBlockedAddress("127.0.0.1", false)).toBe(true);
    expect(isBlockedAddress("127.0.0.1", true)).toBe(false);
    expect(isBlockedAddress("::1", false)).toBe(true);
    expect(isBlockedAddress("::1", true)).toBe(false);
  });
  it("blocks ULA, link-local, multicast and v4-mapped loopback in IPv6", () => {
    for (const ip of [
      "fc00::1", "fd12:3456::1", "fe80::1", "ff02::2", "fe80::",
      "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::",
    ]) {
      expect(isBlockedAddress(ip, false), ip).toBe(true);
    }
  });
  it("allows public IPv6", () => {
    expect(isBlockedAddress("2001:4860:4860::8888", false)).toBe(false);
    expect(isBlockedAddress("2606:4700:4700::1111", false)).toBe(false);
  });
  it("treats unparseable input as blocked", () => {
    expect(isBlockedAddress("not-an-ip", false)).toBe(true);
    expect(isBlockedAddress("1.2.3", false)).toBe(true);
    expect(isBlockedAddress("1.2.3.4.5", false)).toBe(true);
  });
});

describe("resolveVettedAddress", () => {
  it("returns IP literals (public) as-is", async () => {
    await expect(resolveVettedAddress("93.184.216.34", false)).resolves.toBe("93.184.216.34");
  });
  it("rejects IP literals in blocked ranges without DNS", async () => {
    await expect(resolveVettedAddress("169.254.169.254", false)).rejects.toThrow(SsrfError);
    await expect(resolveVettedAddress("[::1]", false)).rejects.toThrow(SsrfError);
  });
  it("vetoes when ANY resolved address is blocked (rebinding / split view)", async () => {
    await expect(
      resolveVettedAddress("evil.example", false, async () => [
        { address: "1.2.3.4" },
        { address: "10.0.0.1" },
      ]),
    ).rejects.toThrow(/blocked address 10\.0\.0\.1/);
  });
  it("pins to the first address when all are public", async () => {
    await expect(
      resolveVettedAddress("ok.example", false, async () => [
        { address: "9.9.9.9" },
        { address: "8.8.8.8" },
      ]),
    ).resolves.toBe("9.9.9.9");
  });
  it("surfaces DNS failures as SsrfError", async () => {
    await expect(
      resolveVettedAddress("nope.example", false, async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(SsrfError);
  });
  it("vetoes empty answers", async () => {
    await expect(
      resolveVettedAddress("empty.example", false, async () => []),
    ).rejects.toThrow(SsrfError);
  });
});

describe("safeFetch", () => {
  it("fetches a plain HTTP page (loopback allowed in ci mode)", async () => {
    const port = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>hello</body></html>");
    });
    const r = await safeFetch(`http://127.0.0.1:${port}/`, { allowLoopback: true, timeoutMs: 5_000 });
    expect(r.status).toBe(200);
    expect(r.bytes.toString()).toContain("hello");
    expect(r.contentType).toBe("text/html");
  });

  it("refuses loopback when ci mode is off (the prod posture)", async () => {
    const port = await startServer((req, res) => {
      res.end("nope");
    });
    await expect(safeFetch(`http://127.0.0.1:${port}/`, { timeoutMs: 5_000 })).rejects.toThrow(SsrfError);
  });

  it("follows redirects and re-vets each hop (blocked hop stops the chain)", async () => {
    const target = await startServer((req, res) => {
      res.writeHead(200);
      res.end("final");
    });
    const hop1 = await startServer((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target}/final` });
      res.end();
    });
    const r = await safeFetch(`http://127.0.0.1:${hop1}/one`, { allowLoopback: true, timeoutMs: 5_000 });
    expect(r.finalUrl).toContain(`:${target}`);
    expect(r.bytes.toString()).toBe("final");
  });

  it("enforces the response size cap on chunked bodies", async () => {
    const port = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("0123456789");
      res.end("0123456789");
    });
    await expect(
      safeFetch(`http://127.0.0.1:${port}/`, { allowLoopback: true, maxBytes: 10, timeoutMs: 5_000 }),
    ).rejects.toThrow(/size limit/);
  });

  it("maps non-2xx to SsrfError", async () => {
    const port = await startServer((req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    await expect(
      safeFetch(`http://127.0.0.1:${port}/`, { allowLoopback: true, timeoutMs: 5_000 }),
    ).rejects.toThrow(/status 500/);
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(safeFetch("file:///etc/passwd", { allowLoopback: true })).rejects.toThrow(/http\(s\)/);
    await expect(safeFetch("ftp://1.2.3.4/x", { allowLoopback: true })).rejects.toThrow(/http\(s\)/);
  });

  it("caps redirect hops", async () => {
    let n = 0;
    const port = await startServer((_req, res) => {
      // Each hop goes to a NEW url (loop detection only fires on exact repeats).
      res.writeHead(302, { location: `http://127.0.0.1:${port}/hop/${++n}` });
      res.end();
    });
    await expect(
      safeFetch(`http://127.0.0.1:${port}/hop/0`, { allowLoopback: true, maxRedirects: 3, timeoutMs: 5_000 }),
    ).rejects.toThrow(/too many redirects/);
  });
});
