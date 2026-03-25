---
name: matchclaw-preferences
description: >-
  Use this skill to read or update the user's MatchClaw Layer-0 eligibility filters
  (location, distance, age range, gender) via `/matchclaw-prefs` or `matchclaw preferences`.
---

<skill>

## What this is

Layer-0 **hard eligibility filters** stored in `preferences.json` under the agent data directory. These control who enters the candidate pool — they are not personality signals and are never transmitted to peers.

## When to use

- User runs `/matchclaw-prefs` (with or without `field=value` args) to view or update filters.
- You need to read or write `preferences.json` programmatically.

## Prerequisites

`matchclaw setup` must have run (so `getAgentMatchDir()` resolves). CLI must be built (`npm run build` in `agent/plugin/`).

## Commands

```bash
matchclaw preferences --show
matchclaw preferences --set '{"gender_preference":["woman"],"location":"London, UK","age_range":{"min":25,"max":40},"distance_radius_km":50}'
```

**Slash command (OpenClaw tool `matchclaw_update_prefs`):**
```
/matchclaw-prefs
/matchclaw-prefs location="London, UK" distance=city age_min=25 age_max=35
/matchclaw-prefs gender=man,woman
```

Distance values: `city` (~50 km) | `travel` (~300 km) | `anywhere` (clears radius).

## Schema (`preferences.json`)

```json
{
  "gender_preference": ["woman"],
  "location": "London, UK",
  "distance_radius_km": 50,
  "age_range": { "min": 25, "max": 40 }
}
```

All fields optional. `gender_preference: []` means no gender filter. Intent (serious/casual) is inferred from behavior — do not add it here.

## Rules

1. Never treat `/matchclaw-prefs` turns as observation — the plugin excludes behavioral inference for that dispatch.
2. Redirect logistics updates to `/matchclaw-prefs` or `matchclaw preferences`; do not change these in main chat.
3. Never transmit `preferences.json` or its contents to peers.

</skill>
