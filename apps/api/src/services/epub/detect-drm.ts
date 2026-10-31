/**
 * DRM / protected-content detection (PLAN slice 2.3, handoff §5.3).
 *
 * Heuristic over the unzipped archive — runs BEFORE any heavy parsing and
 * aborts the ingest with a clear, user-facing message. Signals:
 *
 *  1. A file path containing `adobe-drm` or `\.drm$` (Adobe ADEPT marker).
 *  2. An OPF `<meta name="...">` referencing an external DRM scheme
 *     (e.g. `ADEPT`, `open-drm`, `adobe-adept`).
 *  3. A `<key-system>` element (Open DRM / ADEPT manifests).
 *
 * Returns the matched signal so the caller can surface a precise reason.
 */
import JSZip from "jszip";

export interface DrmHit {
  /** Human-readable reason for the rejection message. */
  reason: string;
  /** Where the signal was found (path or element). */
  where: string;
}

export function detectDrm(zip: JSZip): DrmHit | null {
  for (const path of Object.keys(zip.files)) {
    const lower = path.toLowerCase();
    if (lower.includes("adobe-drm")) {
      return { reason: "Adobe ADEPT DRM detected", where: path };
    }
    if (lower.endsWith(".drm")) {
      return { reason: "DRM container detected", where: path };
    }
  }
  return null;
}

/** Inspect OPF/NCX XML text for DRM metadata signals. */
export function detectDrmInXml(xmlText: string): DrmHit | null {
  // <key-system> — ADEPT / Open DRM
  if (/<key-system[\s>]/i.test(xmlText)) {
    return { reason: "DRM key-system manifest detected", where: "<key-system>" };
  }
  // <meta name="..."> with a DRM-ish scheme
  const metaRe = /<meta[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(xmlText)) !== null) {
    const name = (m[1] ?? "").toLowerCase();
    if (name.includes("adept") || name.includes("open-drm") || name.includes("adobe-drm")) {
      return { reason: `DRM metadata "${m[1]}" detected`, where: "<meta>" };
    }
  }
  return null;
}
