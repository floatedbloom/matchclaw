/**
 * HTTP routes, app factory, and registry prune loop.
 * All route handlers are named functions for clarity and testability.
 */

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { readFile } from "node:fs/promises";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq, gt, lt } from "drizzle-orm/sql";
import { cfg } from "./config.js";
import { db, agents, encrypt, verifyBip340 } from "./data.js";
import { geocode, isAnywhere, agentInRange, parseProximityParams, type GeoAgent } from "./places.js";
import { checkRateLimit, clientIp, readBody, isInternalUrl, REGEX, parseRegisterBody, parseDeregisterBody } from "./guards.js";

// ── Migration ─────────────────────────────────────────────────────────────────

let migration: Promise<void> | undefined;

export function ensureRegistryMigrated(): Promise<void> {
  return (migration ??= migrate(db, { migrationsFolder: cfg.migrationsDir() }));
}

// ── Location resolution helper ────────────────────────────────────────────────

type LocResult = {
  lat: number | null;
  lng: number | null;
  resolution: string;
  label: string | null;
  anywhere: 0 | 1;
};

async function resolveLocation(input: string | null): Promise<LocResult> {
  if (!input?.trim() || isAnywhere(input)) {
    return { lat: null, lng: null, resolution: "anywhere", label: null, anywhere: 1 };
  }
  const hit = await geocode(input.trim());
  if (hit) {
    return { lat: hit.lat, lng: hit.lng, resolution: hit.resolution, label: hit.label, anywhere: 0 };
  }
  return { lat: null, lng: null, resolution: "unresolved", label: null, anywhere: 0 };
}

// ── Static info handlers ──────────────────────────────────────────────────────

function handleRoot(c: Context) {
  return c.json({
    name: "MatchClaw",
    description: "AI agent matching network",
    version: "1.0",
    endpoints: { agents: "/agents", register: "POST /register", skill: "/skill.md" },
  });
}

function handleWellKnownCard(c: Context) {
  return c.json({
    name: "MatchClaw Registry",
    url: "https://lamu.life/api/agent",
    version: "1.0.0",
    capabilities: { matchclaw: true },
    matchclaw: { nostrPubkey: null, matchContext: "dating-v1", protocolVersion: "1.0" },
  });
}

async function handleSkillDoc(c: Context) {
  try {
    const text = await readFile(cfg.skillDocPath(), "utf8");
    return c.text(text, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  } catch {
    return c.text("Not found", 404);
  }
}

// ── Agent list ────────────────────────────────────────────────────────────────

async function handleListAgents(c: Context) {
  if (!checkRateLimit(clientIp(c.req))) return c.json({ error: "Too many requests" }, 429);

  const proximity = parseProximityParams(
    c.req.query("lat"),
    c.req.query("lng"),
    c.req.query("radius_km"),
  );
  if (proximity && "err" in proximity) return c.json({ error: proximity.err }, 400);

  try {
    const since = new Date(Date.now() - cfg.agentTtlMs);
    const rows = await db
      .select({
        pubkey:         agents.pubkey,
        agentCardUrl:   agents.agentCardUrl,
        lastSeen:       agents.lastSeen,
        protocolVersion: agents.protocolVersion,
        geoLat:         agents.geoLat,
        geoLng:         agents.geoLng,
        geoAnywhere:    agents.geoAnywhere,
        maxDistanceKm:  agents.maxDistanceKm,
        geoResolution:  agents.geoResolution,
      })
      .from(agents)
      .where(gt(agents.lastSeen, since));

    const pool =
      proximity && "ok" in proximity
        ? rows.filter((a: typeof rows[number]) => agentInRange(a as GeoAgent, proximity.ok))
        : rows;

    const out = pool.map(({ pubkey, agentCardUrl, lastSeen, protocolVersion }: typeof rows[number]) => ({
      pubkey, cardUrl: agentCardUrl, lastSeen, protocolVersion,
    }));

    return c.json({ agents: out, count: out.length, ...(out.length === 2 && { only_two_in_pool: true }) });
  } catch (err) {
    console.error("/agents error:", err);
    return c.json(
      { error: "Internal Server Error", details: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

async function handleGetAgentCard(c: Context) {
  const pk = c.req.param("pubkey");
  if (!pk || !REGEX.pubkey.test(pk)) return c.json({ error: "Invalid pubkey" }, 400);

  const [row] = await db
    .select({ pubkey: agents.pubkey, agentCardUrl: agents.agentCardUrl, protocolVersion: agents.protocolVersion })
    .from(agents)
    .where(eq(agents.pubkey, pk))
    .limit(1);

  if (!row) return c.json({ error: "Agent not found" }, 404);

  return c.json({
    name: "MatchClaw Matchmaking Agent",
    url: row.agentCardUrl,
    version: "1.0.0",
    capabilities: { matchclaw: true },
    matchclaw: { nostrPubkey: row.pubkey, matchContext: "dating-v1", protocolVersion: row.protocolVersion },
  });
}

// ── Register / deregister ─────────────────────────────────────────────────────

async function handleRegister(c: Context) {
  if (!checkRateLimit(clientIp(c.req))) return c.json({ error: "Too many requests" }, 429);

  const raw = await readBody(c.req);
  if (!raw) return c.json({ error: "Request body too large" }, 413);

  const sig = c.req.header("x-matcher-sig");
  if (!sig || !REGEX.sig.test(sig)) return c.json({ error: "Missing or invalid X-Matcher-Sig" }, 400);

  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(raw)); }
  catch { return c.json({ error: "Invalid JSON" }, 400); }

  const parsed = parseRegisterBody(body);
  if ("err" in parsed) return c.json({ error: parsed.err }, 400);

  const { pubkey, card_url, contact_channel, location, distance_radius_km } = parsed.ok;
  if (isInternalUrl(card_url)) return c.json({ error: "Invalid card_url" }, 400);
  if (!verifyBip340(pubkey, sig, raw)) return c.json({ error: "Invalid signature" }, 401);

  const loc = await resolveLocation(location ?? null);
  const now = new Date();

  const row = {
    pubkey,
    agentCardUrl:    card_url,
    contactType:     contact_channel.type,
    contactValueEnc: encrypt(contact_channel.value),
    lastSeen:        now,
    registeredAt:    now,
    geoQuery:        location?.trim() ?? null,
    geoLat:          loc.lat,
    geoLng:          loc.lng,
    geoResolution:   loc.resolution,
    geoLabel:        loc.label,
    geoAnywhere:     loc.anywhere,
    maxDistanceKm:   distance_radius_km ?? null,
  };

  await db.insert(agents).values(row).onConflictDoUpdate({
    target: agents.pubkey,
    set: {
      agentCardUrl:    row.agentCardUrl,
      contactType:     row.contactType,
      contactValueEnc: row.contactValueEnc,
      lastSeen:        row.lastSeen,
      geoQuery:        row.geoQuery,
      geoLat:          row.geoLat,
      geoLng:          row.geoLng,
      geoResolution:   row.geoResolution,
      geoLabel:        row.geoLabel,
      geoAnywhere:     row.geoAnywhere,
      maxDistanceKm:   row.maxDistanceKm,
    },
  });

  return c.json(
    { enrolled: true, pubkey, location_lat: loc.lat, location_lng: loc.lng, location_label: loc.label, location_resolution: loc.resolution },
    201,
  );
}

async function handleDeregister(c: Context) {
  if (!checkRateLimit(clientIp(c.req))) return c.json({ error: "Too many requests" }, 429);

  const raw = await readBody(c.req);
  if (!raw) return c.json({ error: "Request body too large" }, 413);

  const sig = c.req.header("x-matcher-sig");
  if (!sig || !REGEX.sig.test(sig)) return c.json({ error: "Missing or invalid X-Matcher-Sig" }, 400);

  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(raw)); }
  catch { return c.json({ error: "Invalid JSON" }, 400); }

  const parsed = parseDeregisterBody(body);
  if ("err" in parsed) return c.json({ error: parsed.err }, 400);

  const { pubkey } = parsed.ok;
  if (!verifyBip340(pubkey, sig, raw)) return c.json({ error: "Invalid signature" }, 401);

  const [gone] = await db
    .delete(agents)
    .where(eq(agents.pubkey, pubkey))
    .returning({ pubkey: agents.pubkey });

  if (!gone) return c.json({ error: "Agent not found" }, 404);
  return c.json({ deregistered: true, pubkey });
}

// ── App factory ───────────────────────────────────────────────────────────────

export interface RegistryAppOptions { basePath?: string }

export function createRegistryApp({ basePath = "" }: RegistryAppOptions = {}): Hono {
  const app = new Hono();

  app.use("/*", cors({
    origin: cfg.corsOrigins(),
    allowHeaders: ["Content-Type", "Authorization", "Upgrade", "X-Matcher-Sig"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    credentials: true,
    maxAge: 86400,
  }));

  app.get("/", handleRoot);
  app.get("/.well-known/agent-card.json", handleWellKnownCard);
  app.get("/agents", handleListAgents);
  app.get("/agents/:pubkey/card", handleGetAgentCard);
  app.post("/register", handleRegister);
  app.delete("/register", handleDeregister);
  app.get("/skill.md", handleSkillDoc);

  if (!basePath) return app;
  const root = new Hono();
  root.route(basePath, app);
  return root;
}

// ── Prune loop ────────────────────────────────────────────────────────────────

export async function runRegistryPruneOnce(): Promise<{ pruned: number }> {
  const cutoff = new Date(Date.now() - cfg.pruneTtlHours() * 3_600_000);
  const gone = await db
    .delete(agents)
    .where(lt(agents.lastSeen, cutoff))
    .returning({ pubkey: agents.pubkey });
  gone.forEach((r: { pubkey: string }) => console.log("Pruned stale agent:", r.pubkey.slice(0, 12) + "..."));
  return { pruned: gone.length };
}

/** Returns a cleanup function that stops the interval. */
export function startRegistryPruneLoop(): () => void {
  const id = setInterval(
    () => runRegistryPruneOnce().catch((err) => console.error("Prune error:", err)),
    cfg.pruneIntervalMs(),
  );
  return () => clearInterval(id);
}
