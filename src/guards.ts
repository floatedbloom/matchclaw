/**
 * Request guards: rate limiting, IP extraction, URL safety, and input validation.
 * Everything that protects the API surface from bad input lives here.
 */

import { cfg } from "./config.js";

// ── Rate limiting ─────────────────────────────────────────────────────────────

type Bucket = { hits: number; since: number };
const buckets = new Map<string, Bucket>();

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.since >= cfg.rateWindowMs) {
    buckets.set(ip, { hits: 1, since: now });
    return true;
  }
  return ++b.hits <= cfg.rateMaxHits;
}

// ── Client IP ─────────────────────────────────────────────────────────────────

export function clientIp(req: { header(name: string): string | undefined }): string {
  return (
    req.header("cf-connecting-ip") ??
    req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

// ── Raw body ──────────────────────────────────────────────────────────────────

export async function readBody(
  req: { arrayBuffer(): Promise<ArrayBuffer> },
  maxBytes = 64 * 1024,
): Promise<Uint8Array | null> {
  const buf = await req.arrayBuffer();
  return buf.byteLength > maxBytes ? null : new Uint8Array(buf);
}

// ── Private URL detection ─────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(["localhost", "::1", "[::1]"]);

export function isInternalUrl(rawUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

// ── Input validation ──────────────────────────────────────────────────────────

const RE_PUBKEY  = /^[0-9a-f]{64}$/;
const RE_SIG     = /^[0-9a-f]{128}$/;
const RE_HTTPS   = /^https:\/\/.+/;
const CONTACT_TYPES = new Set(["email", "discord", "telegram", "whatsapp", "imessage"]);

export const REGEX = { pubkey: RE_PUBKEY, sig: RE_SIG, cardUrl: RE_HTTPS } as const;

export interface RegisterBody {
  pubkey: string;
  card_url: string;
  contact_channel: { type: string; value: string };
  location?: string;
  distance_radius_km?: number;
}

export interface DeregisterBody {
  pubkey: string;
}

type Result<T> = { ok: T } | { err: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parseRegisterBody(raw: unknown): Result<RegisterBody> {
  if (!isObj(raw)) return { err: "Invalid JSON" };

  const { pubkey, card_url, contact_channel: cc } = raw;
  if (!pubkey || !card_url || !cc) return { err: "Missing required fields" };
  if (typeof pubkey !== "string" || !RE_PUBKEY.test(pubkey)) return { err: "Invalid pubkey" };
  if (typeof card_url !== "string" || !RE_HTTPS.test(card_url)) return { err: "Invalid card_url" };
  if (
    !isObj(cc) ||
    typeof cc["type"] !== "string" ||
    typeof cc["value"] !== "string" ||
    !CONTACT_TYPES.has(cc["type"]) ||
    (cc["value"] as string).length > 512
  ) return { err: "Invalid contact_channel" };

  const loc  = raw["location"];
  const dist = raw["distance_radius_km"];
  if (loc !== undefined && typeof loc !== "string") return { err: "location must be string" };
  if (dist !== undefined && (typeof dist !== "number" || dist <= 0 || dist > 20_000)) {
    return { err: "distance_radius_km must be positive and ≤ 20000" };
  }

  return {
    ok: {
      pubkey,
      card_url,
      contact_channel: { type: cc["type"] as string, value: cc["value"] as string },
      location: typeof loc === "string" ? loc : undefined,
      distance_radius_km: typeof dist === "number" ? dist : undefined,
    },
  };
}

export function parseDeregisterBody(raw: unknown): Result<DeregisterBody> {
  if (!isObj(raw)) return { err: "Invalid JSON" };
  const { pubkey } = raw;
  if (typeof pubkey !== "string") return { err: "Missing pubkey" };
  if (!RE_PUBKEY.test(pubkey)) return { err: "Invalid pubkey" };
  return { ok: { pubkey } };
}

export interface NegotiationMintBody {
  pubkey: string;
  peer_pubkey: string;
}

export function parseNegotiationMintBody(raw: unknown): Result<NegotiationMintBody> {
  if (!isObj(raw)) return { err: "Invalid JSON" };
  const { pubkey, peer_pubkey: peerPubkey } = raw;
  if (typeof pubkey !== "string" || !RE_PUBKEY.test(pubkey)) return { err: "Invalid pubkey" };
  if (typeof peerPubkey !== "string" || !RE_PUBKEY.test(peerPubkey)) return { err: "Invalid peer_pubkey" };
  return { ok: { pubkey, peer_pubkey: peerPubkey } };
}
