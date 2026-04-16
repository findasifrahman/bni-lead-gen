import fs from "fs";
import path from "path";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env";

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeKey(value: string): string {
  return value.replace(/^\/+/, "").replace(/\\/g, "/");
}

function getEndpoint(): string {
  if (env.r2Endpoint.trim()) {
    return env.r2Endpoint.trim();
  }
  if (env.r2AccountId.trim()) {
    return `https://${env.r2AccountId.trim()}.r2.cloudflarestorage.com`;
  }
  return "";
}

const endpoint = getEndpoint();
const credentials = env.r2AccessKeyId && env.r2SecretAccessKey
  ? {
      accessKeyId: env.r2AccessKeyId,
      secretAccessKey: env.r2SecretAccessKey,
    }
  : undefined;

const s3Client = endpoint && credentials
  ? new S3Client({
      region: "auto",
      endpoint,
      forcePathStyle: true,
      credentials,
    })
  : null;

export function isR2Configured(): boolean {
  return Boolean(s3Client && env.r2Bucket.trim());
}

export function getR2ObjectUrl(objectKey: string): string {
  const key = normalizeKey(objectKey);
  const base = env.r2PublicBaseUrl.trim();
  if (base) {
    return new URL(key, ensureTrailingSlash(base)).toString();
  }
  if (endpoint && env.r2Bucket.trim()) {
    return `${ensureTrailingSlash(endpoint)}${env.r2Bucket.trim()}/${key}`;
  }
  return key;
}

export async function uploadFileToR2(objectKey: string, filePath: string, contentType?: string): Promise<string> {
  if (!s3Client || !env.r2Bucket.trim()) {
    throw new Error("R2 storage is not configured");
  }
  const body = fs.createReadStream(filePath);
  const key = normalizeKey(objectKey);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.r2Bucket.trim(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return getR2ObjectUrl(key);
}

export async function uploadBufferToR2(objectKey: string, buffer: Buffer, contentType?: string): Promise<string> {
  if (!s3Client || !env.r2Bucket.trim()) {
    throw new Error("R2 storage is not configured");
  }
  const key = normalizeKey(objectKey);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.r2Bucket.trim(),
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
  return getR2ObjectUrl(key);
}

export async function deleteR2Prefix(prefix: string): Promise<void> {
  if (!s3Client || !env.r2Bucket.trim()) {
    return;
  }
  const normalizedPrefix = normalizeKey(prefix);
  let continuationToken: string | undefined;
  do {
    const list = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: env.r2Bucket.trim(),
        Prefix: normalizedPrefix,
        ContinuationToken: continuationToken,
      })
    );
    const objects = (list.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => Boolean(key))
      .map((Key) => ({ Key }));
    if (objects.length) {
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: env.r2Bucket.trim(),
          Delete: { Objects: objects, Quiet: true },
        })
      );
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken ?? undefined : undefined;
  } while (continuationToken);
}

export async function getR2Object(objectKey: string) {
  if (!s3Client || !env.r2Bucket.trim()) {
    throw new Error("R2 storage is not configured");
  }
  return s3Client.send(
    new GetObjectCommand({
      Bucket: env.r2Bucket.trim(),
      Key: normalizeKey(objectKey),
    })
  );
}

export function buildReadableR2Prefix(parts: string[]): string {
  return path.posix.join(...parts.map((part) => normalizeKey(part)));
}
