/**
 * Location layer: geocoding, distance calculation, and proximity filtering.
 * All geo concerns live here so routes.ts stays free of spatial logic.
 */

// ── Geocoding ─────────────────────────────────────────────────────────────────

type GeoHit = { lat: number; lng: number; label: string; resolution: string };

const geocodeCache = new Map<string, GeoHit | null>();

const ANYWHERE_RE = /^(anywhere|worldwide|remote|online|global)$/i;

export function isAnywhere(input: string): boolean {
  return ANYWHERE_RE.test(input.trim());
}

function rankToResolution(rank: number): string {
  if (rank <= 4) return "country";
  if (rank <= 12) return "region";
  return "city";
}

export async function geocode(query: string): Promise<GeoHit | null> {
  const cacheKey = query.trim().toLowerCase();
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey)!;

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  try {
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "MatchClaw/1.0 (https://agent.lamu.life)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) { geocodeCache.set(cacheKey, null); return null; }

    const hits = (await res.json()) as {
      lat: string; lon: string; display_name: string; place_rank: number;
    }[];
    if (!hits.length) { geocodeCache.set(cacheKey, null); return null; }

    const top = hits[0]!;
    const hit: GeoHit = {
      lat: parseFloat(top.lat),
      lng: parseFloat(top.lon),
      label: top.display_name.split(",")[0]!.trim(),
      resolution: rankToResolution(top.place_rank),
    };
    geocodeCache.set(cacheKey, hit);
    return hit;
  } catch {
    return null;
  }
}

// ── Haversine distance ────────────────────────────────────────────────────────

const EARTH_KM = 6371;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function distanceKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

// ── Proximity filtering ───────────────────────────────────────────────────────

export type ProximityFilter = { lat: number; lng: number; radius: number };

export function parseProximityParams(
  lat: string | undefined,
  lng: string | undefined,
  radius: string | undefined,
): { ok: ProximityFilter } | { err: string } | null {
  const anyPresent = lat !== undefined || lng !== undefined || radius !== undefined;
  if (!anyPresent) return null;

  if (!lat || !lng || !radius) {
    return { err: "lat, lng, and radius_km must all be provided together" };
  }

  const p = { lat: parseFloat(lat), lng: parseFloat(lng), radius: parseFloat(radius) };
  if (isNaN(p.lat) || isNaN(p.lng) || isNaN(p.radius) || p.radius <= 0) {
    return { err: "Invalid proximity params" };
  }
  return { ok: p };
}

export type GeoAgent = {
  geoAnywhere: number;
  geoLat: number | null;
  geoLng: number | null;
  geoResolution: string | null;
  maxDistanceKm: number | null;
};

export function agentInRange(agent: GeoAgent, filter: ProximityFilter): boolean {
  if (agent.geoAnywhere) return true;
  if (agent.geoLat == null || agent.geoLng == null) {
    return agent.geoResolution === "unresolved" || agent.geoResolution === null;
  }
  const d = distanceKm(agent.geoLat, agent.geoLng, filter.lat, filter.lng);
  return d <= filter.radius && (agent.maxDistanceKm == null || d <= agent.maxDistanceKm);
}
