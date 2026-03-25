// Throughout this file "nsec" means a raw 32-byte private key encoded as a
// 64-character hex string. It is NOT the bech32 "nsec1..." format used by
// Nostr clients. Never pass bech32-encoded keys to functions that expect nsec.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { schnorr } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import type { AgentMatchIdentity } from "./schema.js";

// Resolve the MatchClaw data directory at call time rather than module load time.
// MATCHCLAW_DIR_OVERRIDE wins; MATCHER_DIR_OVERRIDE is the legacy alias from the Lamu era.
export function getAgentMatchDir(): string {
  return (
    process.env["MATCHCLAW_DIR_OVERRIDE"] ??
    process.env["MATCHER_DIR_OVERRIDE"] ??
    join(homedir(), ".matchclaw")
  );
}

// Centralized path builder — evaluate lazily so env overrides are always respected.
const Paths = {
  identity: () => join(getAgentMatchDir(), "identity.json"),
  registration: () => join(getAgentMatchDir(), "registration.json"),
  preferences: () => join(getAgentMatchDir(), "preferences.json"),
};

/** Returns true when the given filesystem path exists, without throwing. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(): Promise<void> {
  const dataDir = getAgentMatchDir();
  if (await pathExists(dataDir)) return;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
}

export async function loadIdentity(): Promise<AgentMatchIdentity | null> {
  const identityFile = Paths.identity();
  if (!(await pathExists(identityFile))) return null;
  try {
    const raw = await readFile(identityFile, "utf8");
    return JSON.parse(raw) as AgentMatchIdentity;
  } catch {
    return null;
  }
}

async function generateAndStoreIdentity(): Promise<AgentMatchIdentity> {
  await ensureDir();
  const secretKey = generateSecretKey();
  const newIdentity: AgentMatchIdentity = {
    nsec: bytesToHex(secretKey),
    npub: getPublicKey(secretKey),
    created_at: new Date().toISOString(),
  };
  // Writing with mode 0o600 in a single call avoids a TOCTOU race between
  // writeFile and a subsequent chmod.
  await writeFile(Paths.identity(), JSON.stringify(newIdentity, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return newIdentity;
}

export async function getOrCreateIdentity(): Promise<AgentMatchIdentity> {
  const existing = await loadIdentity();
  return existing ?? generateAndStoreIdentity();
}

// Produce a BIP340 Schnorr signature over the SHA-256 digest of rawBody.
// The registry validates the signature using:
//   schnorr.verify(sig, sha256(rawBody), pubkey)
// The result is returned as a hex string for inclusion in X-MatchClaw-Sig.
export function signPayload(nsecHex: string, payload: Uint8Array): string {
  const privateKey = hexToBytes(nsecHex);
  const digest = createHash("sha256").update(payload).digest();
  const signature = schnorr.sign(digest, privateKey);
  return bytesToHex(signature);
}

// Re-export Paths so other modules can use the same lazy path resolution
// without duplicating the logic.
export { Paths as IdentityPaths };
