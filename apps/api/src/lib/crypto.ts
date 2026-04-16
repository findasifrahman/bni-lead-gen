import crypto from "crypto";
import { env } from "./env";

function getKey(): Buffer {
  return crypto.createHash("sha256").update(env.encryptionKey).digest();
}

export function encryptSecret(value: string): string {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSecret(value: string): string {
  if (!value) return "";
  const [ivB64, tagB64, payloadB64] = value.split(".");
  if (!ivB64 || !tagB64 || !payloadB64) return "";
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payloadB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
