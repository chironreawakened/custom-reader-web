/**
 * Slice 7 TTS: the user's OpenAI API key at rest (SPECS §5, §10).
 *
 * The key lives in `user_settings.openai_key_enc`, encrypted with
 * AES-256-GCM under a HKDF subkey of the app master key (label
 * `api-key-enc/v1`). Wire form: base64(nonce(12) || ciphertext || tag(16)).
 * `key_version` stays 1 (the label is the version axis, same scheme as the
 * RDR1 storage KEK). The key is never returned by the API; only the last
 * four characters (`openai_key_last4`) are surfaced.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deriveSubkey } from "@reader/shared";

export const API_KEY_ENC_LABEL = "api-key-enc/v1";
export const API_KEY_ENC_VERSION = 1;

function subkey(masterKey: Uint8Array): Buffer {
  return deriveSubkey(masterKey, API_KEY_ENC_LABEL);
}

/** Encrypt a plaintext API key for storage. Returns the base64 wire form. */
export function encryptOpenAiKey(key: string, masterKey: Uint8Array): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", subkey(masterKey), nonce);
  const ct = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}

/** Decrypt a stored key; throws on tamper (auth tag mismatch or bad shape). */
export function decryptOpenAiKey(enc: string, masterKey: Uint8Array): string {
  const raw = Buffer.from(enc, "base64");
  if (raw.length < 12 + 16) throw new Error("openai key: ciphertext too short");
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", subkey(masterKey), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Last four characters, for the settings response. */
export function openAiKeyLast4(key: string): string {
  return key.slice(-4);
}

/** Validate the shape of a key the client is about to store. OpenAI keys
 *  start with `sk-` (legacy `sk-proj-` included) and are long; anything
 *  shorter is almost certainly a paste of something else. The server never
 *  checks the key against OpenAI — it is used lazily on first TTS call. */
export function looksLikeOpenAiKey(key: string): boolean {
  return /^sk-(proj-)?[A-Za-z0-9_-]{16,}$/.test(key);
}
