/**
 * SSRF-safe fetch (PLAN slice 5: URL articles).
 *
 * The worker fetches a URL chosen by the user. A naive `fetch()` would let
 * `http://169.254.169.254/…` or `http://127.0.0.1:54329/…` read the cloud
 * metadata service or the VPS's own services (postgres, s3mock, mattermost).
 *
 * Defence in depth, applied to the initial URL AND every redirect hop:
 *   1. scheme check — only http: / https:;
 *   2. the hostname is resolved with `dns.lookup` and EVERY resolved address
 *      is checked against the blocked ranges (RFC1918, loopback, link-local,
 *      ULA fc00::/7, CGNAT 100.64/10, IETF-reserved, and the AWS/GCP/Azure
 *      metadata addresses);
 *   3. the connection then goes through an undici `Client` whose connector
 *      pins DNS to the vetted address (a `lookup()` override that rejects any
 *      other name) — so a DNS-rebinding response between the check and the
 *      connect cannot swap in a blocked address;
 *   4. redirects are followed manually (never by the stack), each hop
 *      re-vetted, with a hop cap and a loop set;
 *   5. response bodies are hard-capped by byte count even when the server
 *      sends no Content-Length.
 *
 * Loopback (127.0.0.0/8, ::1) is additionally allowed when `RDR_ENV=ci`:
 * the CI / local-verify stacks host the article fixture server on
 * 127.0.0.1, and the worker in those environments is not internet-facing.
 * Production (default `RDR_ENV=prod`) is strict.
 */
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { Client, buildConnector } from "undici";
import type { Dispatcher } from "undici";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export interface SafeFetchOptions {
  /** Cap on response body bytes (redirect hops excluded). Default 5 MB. */
  maxBytes?: number;
  /** Per-hop total timeout (connect + headers + body). Default 30 s. */
  timeoutMs?: number;
  /** Max redirect hops before giving up. Default 5. */
  maxRedirects?: number;
  /** Allow 127.0.0.0/8 and ::1 (RDR_ENV=ci only — see module docs). */
  allowLoopback?: boolean;
}

export interface SafeFetchResult {
  status: number;
  /** Final URL after redirects. */
  finalUrl: string;
  bytes: Buffer;
  contentType: string | null;
}

// ---------------------------------------------------------------------------
// Blocked-address check
// ---------------------------------------------------------------------------

function ipToBigInt(ip: string): { v: bigint; family: 4 | 6 } | null {
  if (ip.includes(":")) {
    const v = parseIPv6(ip);
    return v === null ? null : { v, family: 6 };
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    v = (v << 8n) | BigInt(Number(p));
  }
  return { v, family: 4 };
}

/** One IPv6 group; an embedded IPv4 tail ("…:1.2.3.4") counts as two. */
function parseIPv6Group(g: string): bigint[] | null {
  if (g.includes(".")) {
    const i = g.indexOf(".");
    const hex = g.slice(0, i);
    if (!/^[0-9a-fA-F]{0,4}$/.test(hex)) return null;
    const v4 = ipToBigInt(g.slice(i + 1));
    if (!v4) return null;
    const n = Number(v4.v);
    return [
      BigInt(hex ? parseInt(hex, 16) : 0),
      BigInt((n >> 16) & 0xffff),
      BigInt(n & 0xffff),
    ];
  }
  if (!/^[0-9a-fA-F]{0,4}$/.test(g)) return null;
  return [BigInt(g ? parseInt(g, 16) : 0)];
}

/** Expand a (possibly `::`-compressed) IPv6 literal to its 128-bit value. */
function parseIPv6(ip: string): bigint | null {
  const s = ip.split("%")[0]!; // zone index — never expected, but cheap
  if (!s.includes(":")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups: bigint[] = [];
  let gapAt = -1;
  const push = (half: string, isAfterGap: boolean): boolean => {
    if (isAfterGap) gapAt = groups.length; // gap goes BEFORE the trailing groups
    for (const part of half === "" ? [] : half.split(":")) {
      const parsed = parseIPv6Group(part);
      if (!parsed) return false;
      groups.push(...parsed);
    }
    return true;
  };
  if (halves.length === 1) {
    if (!push(halves[0]!, false)) return null;
  } else if (!push(halves[0]!, false) || !push(halves[1]!, true)) {
    return null;
  }
  const total = groups.length;
  if (gapAt === -1) {
    if (total !== 8) return null;
  } else {
    if (total >= 8) return null;
    for (let i = 0; i < 8 - total; i++) groups.splice(gapAt, 0, 0n);
  }
  let v = 0n;
  for (const g of groups) v = (v << 16n) | g;
  return v;
}

/** True when the address must never be fetched. */
export function isBlockedAddress(ip: string, allowLoopback: boolean): boolean {
  const parsed = ipToBigInt(ip);
  if (!parsed) return true; // unparseable = treat as blocked
  const { v, family } = parsed;
  if (family === 4) {
    // Mask BOTH sides — bases like 172.16.0.0/12 are not /12-aligned.
    const net = (base: bigint, bits: bigint) => {
      const mask = ~((1n << (32n - bits)) - 1n) & 0xffff_ffffn;
      return (v & mask) === (base & mask);
    };
    const isLoopback = net(0x7f00_0000n, 8n); // 127.0.0.0/8
    const alwaysBlocked =
      net(0n, 8n) || // 0.0.0.0/8
      net(0x0a00_0000n, 8n) || // 10.0.0.0/8
      net(0xa9fe_0000n, 16n) || // 169.254.0.0/16 (link-local + cloud metadata)
      net(0xac10_0000n, 12n) || // 172.16.0.0/12
      net(0xc0a8_0000n, 16n) || // 192.168.0.0/16
      net(0x6440_0000n, 10n) || // 100.64.0.0/10 (CGNAT)
      net(0xc000_0000n, 24n) || // 192.0.0.0/24
      net(0xc000_0200n, 24n) || // 192.0.2.0/24 (TEST-NET-1)
      net(0xc612_0000n, 15n) || // 198.18.0.0/15 (benchmarking)
      net(0xc633_6400n, 24n) || // 198.51.100.0/24 (TEST-NET-2)
      net(0xcb00_7100n, 24n) || // 203.0.113.0/24 (TEST-NET-3)
      net(0xe000_0000n, 4n) || // 224.0.0.0/4 (multicast)
      net(0xf000_0000n, 4n); // 240.0.0.0/4 (reserved)
    if (alwaysBlocked) return true;
    return isLoopback && !allowLoopback;
  }
  // IPv6
  if (v === 0n) return true; // :: (unspecified)
  if (v === 1n) return !allowLoopback; // ::1 (loopback)
  // v4-mapped ::ffff:0:0/96 — judge the embedded IPv4 address.
  if ((v >> 96n) === 0xffffn) {
    return isBlockedAddress(v4MappedToDotted(v), allowLoopback);
  }
  if ((v >> 121n) === 0x7en) return true; // fc00::/7 (ULA) — top 7 bits 1111110
  if ((v >> 118n) === 0x3fan) return true; // fe80::/10 (link-local) — top 10 bits 1111111010
  if ((v >> 120n) === 0xffn) return true; // ff00::/8 (multicast) — top 8 bits all 1
  return false;
}

function v4MappedToDotted(v: bigint): string {
  const n = Number(v & 0xffff_ffffn);
  return [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255].join(".");
}

// ---------------------------------------------------------------------------
// Resolution + pinning
// ---------------------------------------------------------------------------

/**
 * Resolve `hostname` and return a single vetted address to pin.
 * IP literals skip DNS but are still checked.
 */
/** Injected in tests to fake DNS; production uses node:dns. */
type DnsLookup = (hostname: string) => Promise<Array<{ address: string }>>;
const defaultLookup: DnsLookup = (hostname) => dns.promises.lookup(hostname, { all: true });

export async function resolveVettedAddress(
  hostname: string,
  allowLoopback: boolean,
  lookup: DnsLookup = defaultLookup,
): Promise<string> {
  const literal = ipToBigInt(hostname.replace(/^\[|\]$/g, ""));
  if (literal) {
    if (isBlockedAddress(hostname, allowLoopback)) {
      throw new SsrfError(`blocked address ${hostname}`);
    }
    return hostname.replace(/^\[|\]$/g, "");
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(hostname);
  } catch (e) {
    throw new SsrfError(`could not resolve ${hostname}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (addrs.length === 0) throw new SsrfError(`no addresses for ${hostname}`);
  // Vet EVERY address (a single poisoned answer must sink the whole lookup);
  // then pin to the first public one if any exist, else the first vetted.
  for (const a of addrs) {
    if (isBlockedAddress(a.address, allowLoopback)) {
      throw new SsrfError(`blocked address ${a.address} for ${hostname}`);
    }
  }
  return addrs[0]!.address;
}

/** undici Client that connects to `pinnedIp` no matter what DNS says. */
function pinnedClient(url: URL, pinnedIp: string, timeoutMs: number): Client {
  const family: 4 | 6 = pinnedIp.includes(":") ? 6 : 4;
  // Client origin must be a bare origin — no path.
  const origin = new URL(url.origin);
  const connector = buildConnector({
    timeout: timeoutMs,
    // This client is dedicated to one vetted address: every lookup on it must
    // resolve to the pinned IP (a real DNS answer between the vet and the
    // connect would enable rebinding). Node may call with `all: true`.
    lookup: ((_hostname: string, opts, cb) => {
      if (opts?.all) cb(null, [{ address: pinnedIp, family }]);
      else cb(null, pinnedIp, family);
    }) as LookupFunction,
  });
  return new Client(origin, {
    connect: connector,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

import { fetch as undiciFetch } from "undici";

async function fetchWithPinned(
  url: URL,
  pinnedIp: string,
  opts: Required<Pick<SafeFetchOptions, "maxBytes" | "timeoutMs">>,
): Promise<{ client: Client; status: number; location: string | null; bytes: Buffer; contentType: string | null }> {
  const client = pinnedClient(url, pinnedIp, opts.timeoutMs);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const res = await undiciFetch(url.toString(), {
      dispatcher: client as Dispatcher,
      redirect: "manual",
      signal: ac.signal,
    });
    let location: string | null = null;
    if (res.status >= 300 && res.status < 400) {
      location = res.headers.get("location");
      // Drain nothing; the client close below discards the (small) body.
      const ct = res.headers.get("content-type");
      return { client, status: res.status, location, bytes: Buffer.alloc(0), contentType: ct };
    }
    if (res.status < 200 || res.status >= 300) {
      const body = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
      return { client, status: res.status, location: null, bytes: Buffer.from(body), contentType: res.headers.get("content-type") };
    }
    // 2xx: stream with a hard byte cap (works with or without Content-Length).
    if (!res.body) {
      const body = await res.arrayBuffer();
      if (body.byteLength > opts.maxBytes) throw new SsrfError("response exceeds size limit");
      return { client, status: res.status, location: null, bytes: Buffer.from(body), contentType: res.headers.get("content-type") };
    }
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > opts.maxBytes) {
          await reader.cancel().catch(() => {});
          throw new SsrfError("response exceeds size limit");
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { client, status: res.status, location: null, bytes: Buffer.concat(chunks), contentType: res.headers.get("content-type") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a user-supplied URL through the SSRF guard. Follows up to
 * `maxRedirects` redirects, re-vetting each hop.
 */
export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const allowLoopback = opts.allowLoopback ?? false;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfError("invalid URL");
  }
  const visited = new Set<string>();
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SsrfError("only http(s) URLs are supported");
    }
    if (visited.has(url.toString())) throw new SsrfError("redirect loop");
    visited.add(url.toString());

    const pinnedIp = await resolveVettedAddress(url.hostname, allowLoopback);
    const { client, status, location, bytes, contentType } = await fetchWithPinned(url, pinnedIp, { maxBytes, timeoutMs });
    if (location !== null) {
      if (hop >= maxRedirects) throw new SsrfError("too many redirects");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        await client.close();
        throw new SsrfError("invalid redirect target");
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        await client.close();
        throw new SsrfError("redirect to unsupported scheme");
      }
      await client.close();
      url = next;
      continue;
    }
    await client.close();
    if (status < 200 || status >= 300) {
      throw new SsrfError(`fetch failed with status ${status}`);
    }
    return { status, finalUrl: url.toString(), bytes, contentType };
  }
}
