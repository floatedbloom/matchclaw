/**
 * Data layer: database schema + client, and field-level encryption.
 * These two concerns live together because encryption exists solely to protect
 * values before they reach the database.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { integer, real, text } from "drizzle-orm/sqlite-core/columns";
import { sqliteTable } from "drizzle-orm/sqlite-core/table";
import { cfg } from "./config.js";

// ── Encryption ────────────────────────────────────────────────────────────────

// Key is loaded once and cached; bad config fails fast on first use.
let _aesKey: Buffer | null = null;

function getAesKey(): Buffer {
  if (_aesKey) return _aesKey;
  const raw = cfg.encryptionKey();
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. " +
      'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  return (_aesKey = key);
}

/** Seal a plaintext string. Returns "ivHex:tagHex:cipherHex". */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getAesKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/** Unseal a value produced by encrypt(). */
export function decrypt(sealed: string): string {
  const parts = sealed.split(":");
  if (parts.length !== 3) throw new Error("Malformed sealed value — expected ivHex:tagHex:cipherHex");
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", getAesKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/** Verify a BIP-340 Schnorr signature over sha256(payload). */
export function verifyBip340(pubkeyHex: string, sigHex: string, payload: Uint8Array): boolean {
  try {
    const digest = createHash("sha256").update(payload).digest();
    return schnorr.verify(
      Buffer.from(sigHex, "hex"),
      digest,
      Buffer.from(pubkeyHex, "hex"),
    );
  } catch {
    return false;
  }
}

/** Throw early if the encryption key is misconfigured. */
export function validateKey(): void {
  getAesKey();
}

// ── Database schema ───────────────────────────────────────────────────────────

export const agents = sqliteTable("agents", {
  pubkey:           text("pubkey").primaryKey(),
  agentCardUrl:     text("agent_card_url").notNull(),
  contactType:      text("contact_type").notNull(),
  contactValueEnc:  text("contact_value_enc").notNull(),
  lastSeen:         integer("last_seen", { mode: "timestamp" }).notNull(),
  registeredAt:     integer("registered_at", { mode: "timestamp" }).notNull(),
  protocolVersion:  text("protocol_version").notNull().default("2.0"),
  geoQuery:         text("geo_query"),
  geoLat:           real("geo_lat"),
  geoLng:           real("geo_lng"),
  geoResolution:    text("geo_resolution"),
  geoLabel:         text("geo_label"),
  geoAnywhere:      integer("geo_anywhere").notNull().default(0),
  maxDistanceKm:    real("max_distance_km"),
});

// ── Database client ───────────────────────────────────────────────────────────

const token = cfg.dbToken();
const client = createClient(token ? { url: cfg.dbUrl(), authToken: token } : { url: cfg.dbUrl() });

export const db = drizzle(client, { schema: { agents } });
