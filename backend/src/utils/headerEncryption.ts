import crypto from "crypto";

/**
 * AES-256-GCM encryption for sensitive webhook custom header values at rest.
 *
 * Stored format: `enc:v1:<iv b64>:<auth tag b64>:<ciphertext b64>`
 */
const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function resolveKey(rawKey: string | undefined): Buffer {
  if (!rawKey) {
    throw new Error(
      "WEBHOOK_HEADER_ENCRYPTION_KEY is required to store sensitive webhook headers"
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, "hex");
  }
  // Accept any other string by deriving a 32-byte key from it.
  return crypto.createHash("sha256").update(rawKey, "utf8").digest();
}

export function isEncryptedValue(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptHeaderValue(
  plaintext: string,
  rawKey: string | undefined = process.env.WEBHOOK_HEADER_ENCRYPTION_KEY
): string {
  const key = resolveKey(rawKey);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptHeaderValue(
  stored: string,
  rawKey: string | undefined = process.env.WEBHOOK_HEADER_ENCRYPTION_KEY
): string {
  if (!isEncryptedValue(stored)) {
    throw new Error("Value is not an encrypted header value");
  }
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted header value");
  }
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    resolveKey(rawKey),
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
