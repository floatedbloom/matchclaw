/**
 * Single source of truth for all environment variables, constants, and path
 * resolution. Every other module imports from here instead of reading env
 * directly — makes substitution and testing straightforward.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Path resolution ───────────────────────────────────────────────────────────

function resolveLocalDb(): string {
  const mono = join(process.cwd(), "agent", "data", "data.db");
  const solo = join(process.cwd(), "data", "data.db");
  const path = existsSync(mono) ? mono : existsSync(solo) ? solo : mono;
  return `file:${path}`;
}

function resolveMigrationsDir(): string {
  if (process.env.MATCHCLAW_MIGRATIONS_DIR) return process.env.MATCHCLAW_MIGRATIONS_DIR;
  const mono = join(process.cwd(), "agent", "drizzle");
  if (existsSync(mono)) return mono;
  const solo = join(process.cwd(), "drizzle");
  if (existsSync(solo)) return solo;
  return join(__dir, "..", "drizzle");
}

function resolveSkillDocPath(): string {
  if (process.env.MATCHCLAW_SKILL_PATH) return process.env.MATCHCLAW_SKILL_PATH;
  const mono = join(process.cwd(), "agent", "skill", "skill.md");
  if (existsSync(mono)) return mono;
  return join(process.cwd(), "skill", "skill.md");
}

function resolveCorsOrigins(): string[] {
  const base = [
    "https://lamu.life",
    "https://www.lamu.life",
    "https://agent.lamu.life",
    "http://localhost:3000",
  ];
  const extra = (process.env.MATCHCLAW_CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...base, ...extra];
}

// ── Exported config object ────────────────────────────────────────────────────

export const cfg = {
  // Server
  port:            () => Number(process.env.PORT ?? 3000),
  basePath:        () => process.env.MATCHCLAW_BASE_PATH ?? "",

  // Database
  dbUrl:           () => process.env.TURSO_DATABASE_URL ?? resolveLocalDb(),
  dbToken:         () => process.env.TURSO_AUTH_TOKEN,

  // Encryption
  encryptionKey:   () => process.env.ENCRYPTION_KEY,

  // Paths
  migrationsDir:   resolveMigrationsDir,
  skillDocPath:    resolveSkillDocPath,

  // CORS
  corsOrigins:     resolveCorsOrigins,

  // Agent liveness
  agentTtlMs:      24 * 60 * 60 * 1000,
  pruneTtlHours:   () => Number(process.env.LIVENESS_WINDOW_HOURS ?? 24),
  pruneIntervalMs: () => Number(process.env.HEALTH_CHECK_INTERVAL_MINUTES ?? 60) * 60_000,

  // Rate limiting
  rateWindowMs:    60_000,
  rateMaxHits:     20,
} as const;
