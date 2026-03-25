import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentMatchDir } from "./keys.js";
import type { UserPreferences } from "./schema.js";

// ── PrefsStore ────────────────────────────────────────────────────────────────
//
// Encapsulates all read/write access for the user preferences file.
// The file path is resolved on every call so MATCHCLAW_DIR_OVERRIDE changes in
// tests are respected immediately without a module reload.

class PrefsStore {
  /** Resolve path at call time — never cache. */
  private filePath(): string {
    return join(getAgentMatchDir(), "preferences.json");
  }

  /**
   * Synchronous load — required by plugin hooks that run in a synchronous
   * lifecycle phase (before_prompt_build).
   */
  loadSync(): UserPreferences {
    const fp = this.filePath();
    if (!existsSync(fp)) return {};
    try {
      return JSON.parse(readFileSync(fp, "utf8")) as UserPreferences;
    } catch {
      return {};
    }
  }

  async load(): Promise<UserPreferences> {
    const fp = this.filePath();
    if (!existsSync(fp)) return {};
    try {
      const raw = await readFile(fp, "utf8");
      return JSON.parse(raw) as UserPreferences;
    } catch {
      return {};
    }
  }

  async save(prefs: UserPreferences): Promise<void> {
    await writeFile(this.filePath(), JSON.stringify(prefs, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

// Module-level singleton — all exported functions delegate here.
const store = new PrefsStore();

// ── Exported thin wrappers ────────────────────────────────────────────────────

/** Synchronous load used by plugin hooks (before_prompt_build runs synchronously). */
export function loadPreferencesSync(): UserPreferences {
  return store.loadSync();
}

export async function loadPreferences(): Promise<UserPreferences> {
  return store.load();
}

export async function savePreferences(prefs: UserPreferences): Promise<void> {
  return store.save(prefs);
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatPreferences(prefs: UserPreferences): string {
  const sections: { label: string; value: string }[] = [];

  if (prefs.gender_filter?.length) {
    sections.push({
      label: "gender",
      value: prefs.gender_filter.join(" or "),
    });
  }

  if (prefs.location) {
    const radius =
      prefs.max_radius_km !== undefined
        ? ` (within ${prefs.max_radius_km} km)`
        : "";
    sections.push({ label: "location", value: `${prefs.location}${radius}` });
  }

  if (prefs.age_range) {
    const { min, max } = prefs.age_range;
    let ageValue: string;
    if (min !== undefined && max !== undefined) {
      ageValue = `${min}–${max}`;
    } else if (min !== undefined) {
      ageValue = `${min}+`;
    } else if (max !== undefined) {
      ageValue = `up to ${max}`;
    } else {
      ageValue = "";
    }
    if (ageValue) sections.push({ label: "age", value: ageValue });
  }

  if (sections.length === 0) return "No preferences set — open to all candidates";

  const formatted = sections.map((s) => `${s.label}: ${s.value}`).join(" | ");
  return `Active filters: ${formatted}`;
}
