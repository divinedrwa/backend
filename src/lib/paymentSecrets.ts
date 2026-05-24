import crypto from "crypto";
import { logger } from "./logger";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PREFIX = "enc:v1:";

let _key: Buffer | null = null;

function getKey(): Buffer | null {
  if (_key) return _key;
  const hex = process.env.PAYMENT_SECRETS_KEY;
  if (!hex) return null;
  if (hex.length !== 64) {
    logger.warn("PAYMENT_SECRETS_KEY must be 64 hex chars (32 bytes). Secrets will be stored in plaintext.");
    return null;
  }
  _key = Buffer.from(hex, "hex");
  return _key;
}

/** Returns true if the value looks like an encrypted secret. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext secret using AES-256-GCM.
 * Returns `enc:v1:<base64-iv>:<base64-authTag>:<base64-ciphertext>`.
 * If PAYMENT_SECRETS_KEY is not set, returns the plaintext as-is (dev mode).
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already encrypted

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypt an encrypted secret. Returns the plaintext.
 * If the value is not encrypted (no prefix), returns it as-is.
 */
export function decryptSecret(ciphertext: string): string {
  if (!isEncrypted(ciphertext)) return ciphertext;

  const key = getKey();
  if (!key) {
    logger.warn("Cannot decrypt: PAYMENT_SECRETS_KEY not set");
    return ciphertext;
  }

  const parts = ciphertext.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted secret format");
  }

  const iv = Buffer.from(parts[0], "base64");
  const authTag = Buffer.from(parts[1], "base64");
  const encrypted = Buffer.from(parts[2], "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return decrypted.toString("utf8");
}
