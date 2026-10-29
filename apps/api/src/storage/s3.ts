/**
 * Thin S3 client for Hippius (SPECS: path-style, SigV4, region "decentralized").
 * Deliberately minimal: put/get/ranged-get/delete/head.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";

export interface S3Storage {
  put(key: string, body: Uint8Array | ReadableStream, mime?: string): Promise<void>;
  /** Full object body. */
  get(key: string): Promise<Uint8Array>;
  /** Ranged GET: ciphertext bytes [offset, offset+length). */
  getRange(key: string, offset: number, length: number): Promise<Uint8Array>;
  head(key: string): Promise<{ contentLength: number; contentType: string | undefined }>;
  delete(key: string): Promise<void>;
}

export function createS3Storage(cfg: AppConfig): S3Storage {
  const client = new S3Client({
    endpoint: cfg.hippus.endpoint,
    region: cfg.hippus.region,
    credentials: {
      accessKeyId: cfg.hippus.accessKey,
      secretAccessKey: cfg.hippus.secretKey,
    },
    forcePathStyle: true,
  });

  return {
    async put(key, body, mime = "application/octet-stream") {
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.hippus.bucket,
          Key: key,
          Body: body as never,
          ContentType: mime,
        }),
      );
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.hippus.bucket, Key: key }));
      const buf = await res.Body?.transformToByteArray();
      if (!buf) throw new Error(`empty body for ${key}`);
      return buf;
    },
    async getRange(key, offset, length) {
      const res = await client.send(
        new GetObjectCommand({
          Bucket: cfg.hippus.bucket,
          Key: key,
          Range: `bytes=${offset}-${offset + length - 1}`,
        }),
      );
      const buf = await res.Body?.transformToByteArray();
      if (!buf || buf.byteLength !== length) {
        throw new Error(`bad range response for ${key}: got ${buf?.byteLength ?? 0}, want ${length}`);
      }
      return buf;
    },
    async head(key) {
      const res = await client.send(new HeadObjectCommand({ Bucket: cfg.hippus.bucket, Key: key }));
      return { contentLength: res.ContentLength ?? 0, contentType: res.ContentType };
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.hippus.bucket, Key: key }));
    },
  };
}
