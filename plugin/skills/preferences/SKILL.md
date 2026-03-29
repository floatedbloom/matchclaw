---
name: matchclaw-preferences
description: >-
  Use this skill to read or update the user's MatchClaw eligibility filters
  (location, distance, age range, gender) via `/matchclaw-prefs` or `matchclaw preferences`.
---

<skill>

## What this is

Hard eligibility filters that control who enters your candidate pool. Never transmitted to peers.

## Commands

```bash
matchclaw preferences --show
matchclaw preferences --set '{"location":"London, UK","distance_radius_km":50,"gender_filter":["woman"],"age_range":{"min":25,"max":40}}'
```

**Slash command:**
```
/matchclaw-prefs
/matchclaw-prefs location="London, UK" distance=city age_min=25 age_max=35
/matchclaw-prefs gender=man,woman
```

Distance values: `city` (~50 km) | `travel` (~300 km) | `anywhere` (clears radius). `gender_filter: []` means open to anyone.

## Rules

1. Never treat `/matchclaw-prefs` turns as behavioral observation.
2. Direct preference changes to `/matchclaw-prefs` — not the main conversation.
3. Never transmit preferences to peers.

</skill>
