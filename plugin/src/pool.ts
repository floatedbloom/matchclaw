import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentMatchDir, signPayload } from "./keys.js";
import type {
  ContactChannel,
  RegistrationRecord,
  AgentMatchIdentity,
} from "./schema.js";

// Re-evaluated on every call so registry URL overrides take effect immediately.
// Docs historically used MATCHER_REGISTRY_URL; MATCHCLAW_REGISTRY_URL is the newer name.
function resolveRegistryUrl(): string {
  return (
    process.env["MATCHER_REGISTRY_URL"] ??
    process.env["MATCHCLAW_REGISTRY_URL"] ??
    "https://agent.lamu.life"
  );
}

// Re-evaluated on every call to respect MATCHCLAW_DIR_OVERRIDE in simulations.
function resolveRegistrationPath(): string {
  return join(getAgentMatchDir(), "registration.json");
}

// ── HTTP error type ───────────────────────────────────────────────────────────

export class RegistryHttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, detail: string | null) {
    super(`Registry error ${statusCode}${detail ? `: ${detail}` : ""}`);
    this.statusCode = statusCode;
    this.name = "RegistryHttpError";
  }
}

// ── RegistryClient ────────────────────────────────────────────────────────────
//
// All HTTP interactions with the MatchClaw registry are routed through this class.
// Exported free functions below delegate to a module-level singleton instance.

class RegistryClient {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = resolveRegistryUrl();
  }

  /** Extract an error detail string from a non-OK JSON response body. */
  private async extractErrorDetail(
    res: Response,
  ): Promise<string | null> {
    try {
      return ((await res.json()) as { error: string }).error ?? null;
    } catch {
      return null;
    }
  }

  /** Throw a typed error when a response signals failure. */
  private async assertOk(res: Response): Promise<void> {
    if (!res.ok) {
      const detail = await this.extractErrorDetail(res);
      throw new RegistryHttpError(res.status, detail);
    }
  }

  async register(
    identity: AgentMatchIdentity,
    cardUrl: string,
    contact: ContactChannel,
    locationText?: string,
    distanceRadiusKm?: number,
  ): Promise<RegistrationRecord> {
    const body: Record<string, unknown> = {
      pubkey: identity.npub,
      card_url: cardUrl,
      contact_channel: contact,
    };
    if (locationText) body["location"] = locationText;
    if (distanceRadiusKm !== undefined) body["distance_radius_km"] = distanceRadiusKm;

    const encoded = JSON.stringify(body);
    const sig = signPayload(identity.nsec, new TextEncoder().encode(encoded));

    const res = await fetch(`${resolveRegistryUrl()}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matcher-Sig": sig,
      },
      body: encoded,
    });

    if (!res.ok) {
      const detail = await this.extractErrorDetail(res);
      throw new RegistryHttpError(res.status, detail);
    }

    const serverPayload = (await res.json()) as {
      enrolled: boolean;
      pubkey: string;
      location_lat?: number | null;
      location_lng?: number | null;
      location_label?: string | null;
      location_resolution?: string | null;
    };

    const saved: RegistrationRecord = {
      pubkey: identity.npub,
      card_url: cardUrl,
      contact_channel: contact,
      registered_at: new Date().toISOString(),
      enrolled: true,
      location_lat: serverPayload.location_lat ?? null,
      location_lng: serverPayload.location_lng ?? null,
      location_label: serverPayload.location_label ?? null,
      location_resolution: serverPayload.location_resolution ?? null,
    };

    await writeFile(resolveRegistrationPath(), JSON.stringify(saved, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });

    return saved;
  }

  async deregister(identity: AgentMatchIdentity): Promise<void> {
    const encoded = JSON.stringify({ pubkey: identity.npub });
    const sig = signPayload(identity.nsec, new TextEncoder().encode(encoded));

    const res = await fetch(`${resolveRegistryUrl()}/register`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-Matcher-Sig": sig,
      },
      body: encoded,
    });

    // A 404 means we were already deregistered — that is an acceptable outcome.
    if (!res.ok && res.status !== 404) {
      const detail = await this.extractErrorDetail(res);
      throw new RegistryHttpError(res.status, detail);
    }

    // Mark the locally persisted record as no longer enrolled.
    const localPath = resolveRegistrationPath();
    if (!existsSync(localPath)) return;

    const diskRecord = await loadRegistration();
    if (!diskRecord) return;

    diskRecord.enrolled = false;
    await writeFile(localPath, JSON.stringify(diskRecord, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async listAgents(proximity?: ProximityOpts): Promise<ListAgentsResult> {
    const params = new URLSearchParams();
    if (proximity) {
      params.set("lat", String(proximity.lat));
      params.set("lng", String(proximity.lng));
      params.set("radius_km", String(proximity.radiusKm));
    }

    const queryString = params.toString();
    const url = `${resolveRegistryUrl()}/agents${queryString ? `?${queryString}` : ""}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new RegistryHttpError(res.status, null);
    }

    const parsed = (await res.json()) as {
      agents: Array<{ pubkey: string; cardUrl: string; lastSeen: string }>;
      only_two_in_pool?: boolean;
    };

    return {
      agents: parsed.agents,
      onlyTwoInPool: parsed.only_two_in_pool ?? false,
    };
  }

  /** Mint a canonical thread id from the registry (Turso). Both agents must be registered. */
  async mintNegotiationThread(
    identity: AgentMatchIdentity,
    peerPubkey: string,
  ): Promise<MintNegotiationResult> {
    const body = JSON.stringify({ pubkey: identity.npub, peer_pubkey: peerPubkey });
    const sig = signPayload(identity.nsec, new TextEncoder().encode(body));

    const res = await fetch(`${resolveRegistryUrl()}/negotiations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Matcher-Sig": sig,
      },
      body,
    });

    if (!res.ok) {
      const detail = await this.extractErrorDetail(res);
      throw new RegistryHttpError(res.status, detail);
    }

    const payload = (await res.json()) as { thread_id: string; reused?: boolean };
    if (!payload.thread_id || typeof payload.thread_id !== "string") {
      throw new RegistryHttpError(res.status, "Missing thread_id in response");
    }
    return {
      threadId: payload.thread_id,
      reused: payload.reused === true,
    };
  }

  /**
   * Mark a thread as closed in the registry.
   * Fails silently on network/server errors — local state is already persisted.
   */
  async closeNegotiationThread(
    identity: AgentMatchIdentity,
    threadId: string,
  ): Promise<void> {
    try {
      const body = JSON.stringify({ pubkey: identity.npub });
      const sig = signPayload(identity.nsec, new TextEncoder().encode(body));
      await fetch(`${resolveRegistryUrl()}/negotiations/${encodeURIComponent(threadId)}/close`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Matcher-Sig": sig,
        },
        body,
      });
    } catch {
      // Network failure — local state is already persisted; registry will eventually
      // reflect closed status when the other side (or a future call) closes it.
    }
  }

  /**
   * Returns true if the registry recognises this thread ID.
   * Fails open (returns true) on network/server errors so a downed registry
   * doesn't block all inbound messages.
   */
  async validateNegotiationThread(threadId: string): Promise<boolean> {
    try {
      const res = await fetch(`${resolveRegistryUrl()}/negotiations/${encodeURIComponent(threadId)}`);
      if (res.ok) return true;
      if (res.status === 404) {
        // Distinguish "thread not found" (our endpoint, specific error body) from
        // "route not found" (old server without this endpoint, generic 404).
        // Only reject when we are certain the endpoint exists and the thread is missing.
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error === "Thread not found") return false;
        } catch {
          // Body is not JSON — old server or proxy page → fail open
        }
        return true; // endpoint not deployed yet or unexpected 404 body → fail open
      }
      return true; // 5xx or other status → fail open
    } catch {
      return true; // network error → fail open
    }
  }
}

// Module-level singleton — all exported functions delegate here.
const client = new RegistryClient();

// ── Persistence helpers ───────────────────────────────────────────────────────

/** Synchronous load for plugin hooks that run in a sync context. */
export function loadRegistrationSync(): RegistrationRecord | null {
  const diskPath = resolveRegistrationPath();
  if (!existsSync(diskPath)) return null;
  try {
    return JSON.parse(readFileSync(diskPath, "utf8")) as RegistrationRecord;
  } catch {
    return null;
  }
}

export async function loadRegistration(): Promise<RegistrationRecord | null> {
  const diskPath = resolveRegistrationPath();
  if (!existsSync(diskPath)) return null;
  try {
    const raw = await readFile(diskPath, "utf8");
    return JSON.parse(raw) as RegistrationRecord;
  } catch {
    return null;
  }
}

// ── Exported free functions (delegate to client) ──────────────────────────────

export async function register(
  identity: AgentMatchIdentity,
  cardUrl: string,
  contact: ContactChannel,
  locationText?: string,
  distanceRadiusKm?: number,
): Promise<RegistrationRecord> {
  return client.register(identity, cardUrl, contact, locationText, distanceRadiusKm);
}

export async function deregister(identity: AgentMatchIdentity): Promise<void> {
  return client.deregister(identity);
}

export interface ProximityOpts {
  lat: number;
  lng: number;
  radiusKm: number;
}

export interface ListAgentsResult {
  agents: Array<{ pubkey: string; cardUrl: string; lastSeen: string }>;
  onlyTwoInPool: boolean;
}

export interface MintNegotiationResult {
  threadId: string;
  /** True when the registry returned an already-open thread for this pair (second `match --start`). */
  reused: boolean;
}

export async function listAgents(
  proximity?: ProximityOpts,
): Promise<ListAgentsResult> {
  return client.listAgents(proximity);
}

export async function mintNegotiationThread(
  identity: AgentMatchIdentity,
  peerPubkey: string,
): Promise<MintNegotiationResult> {
  return client.mintNegotiationThread(identity, peerPubkey);
}

export async function validateNegotiationThread(threadId: string): Promise<boolean> {
  return client.validateNegotiationThread(threadId);
}

export async function closeNegotiationThread(
  identity: AgentMatchIdentity,
  threadId: string,
): Promise<void> {
  return client.closeNegotiationThread(identity, threadId);
}
