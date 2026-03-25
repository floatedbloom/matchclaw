// Observation model for MatchClaw soft-scoring compatibility dimensions.
// Rule-based dimensions (attachment, mbti, zodiac) carry a discrete value string.
// LLM-based dimensions (interests, moral, family, lifestyle) carry free-text content
// that gets compared during scoring rather than matched against an enum.

export interface DimensionMeta {
  confidence: number; // 0.0–1.0
  evidenceCount: number;
  signalDiversity: "low" | "medium" | "high";
  value?: string; // rule-based result, e.g. "Secure", "INTJ", "Aries"
  content?: string; // LLM-based text used for dimension comparison
}

export type ConstraintGateState =
  | "confirmed"
  | "below_floor"
  | "none_observed";

export type InferredIntentCategory = "serious" | "casual" | "unclear";

/**
 * Full snapshot of observed compatibility dimensions for a user.
 * Scoring weights: attachment 10%, mbti 10%, zodiac 5%, interests 10%,
 * moral 15%, family 25%, lifestyle 25%.
 */
export interface ObservationSummary {
  lastRevised: string;
  eligibilityAt: string;
  poolEligible: boolean;

  sessionCount: number;
  spanDays: number;

  // Compatibility dimensions
  attachmentType: DimensionMeta; // Secure | Anxious | Fearful-Avoidant | Dismissive-Avoidant
  mbti: DimensionMeta;
  zodiac: DimensionMeta;
  interests: DimensionMeta;
  moralEthicalAlignment: DimensionMeta;
  familyLifeGoalsAlignment: DimensionMeta;
  lifestyleRelationalBeliefs: DimensionMeta;

  gateState: ConstraintGateState;
  intentCategory?: InferredIntentCategory;
}

// ── User preferences — hard Layer-0 eligibility filters ──────────────────────
// These are private pass/fail predicates. They are never transmitted to peers
// and are checked locally before any negotiation process begins.

export interface UserPreferences {
  gender_filter?: string[]; // e.g. ["woman", "non-binary"] — empty means no filter
  location?: string; // plain text location resolved server-side via geocoding
  max_radius_km?: number; // derived from onboarding natural-language selection
  age_range?: { min?: number; max?: number };
  // Note: intent (serious/casual) is NOT stored here — the agent infers it
  // from life_velocity and observed behavior patterns.
}

// ── Agent identity ────────────────────────────────────────────────────────────

export interface AgentMatchIdentity {
  /** Raw 64-char hex-encoded private key. NOT a bech32 "nsec1..." string. Keep secret. */
  nsec: string;
  npub: string; // hex-encoded x-only public key
  created_at: string; // ISO 8601
}

// ── Registry ──────────────────────────────────────────────────────────────────

export type ContactType =
  | "email"
  | "discord"
  | "telegram"
  | "whatsapp"
  | "imessage"
  | "signal"
  | "phone"
  | "instagram"
  | "twitter"
  | "linkedin"
  | "matrix"
  | "line";

// Authoritative set of valid contact types — must remain in sync with ContactType.
export const VALID_CONTACT_TYPES = new Set<ContactType>([
  "email",
  "discord",
  "telegram",
  "whatsapp",
  "imessage",
  "signal",
  "phone",
  "instagram",
  "twitter",
  "linkedin",
  "matrix",
  "line",
]);

export interface ContactChannel {
  type: ContactType;
  value: string;
}

export interface RegistrationRecord {
  pubkey: string;
  card_url: string;
  contact_channel: ContactChannel;
  registered_at: string;
  enrolled: boolean;
  // Geocoded coordinates returned by the registry at registration time.
  // Stored locally so proximity filtering (GET /agents) can supply lat/lng.
  location_lat?: number | null;
  location_lng?: number | null;
  location_label?: string | null;
  location_resolution?: string | null;
}

// ── Nostr / Negotiation protocol ──────────────────────────────────────────────

export interface AgentMatchMessage {
  matchclaw: "1.0";
  thread_id: string;
  type: MessageType;
  timestamp: string; // ISO 8601
  content: string; // plain text or JSON-serialised MatchNarrative
}

export type MessageType =
  | "negotiation"
  | "match_propose"
  | "end";

export interface NegotiationMessage {
  role: "us" | "peer";
  content: string;
  timestamp: string; // ISO 8601
}

export interface NegotiationState {
  thread_id: string;
  remoteKey: string;
  sentRounds: number; // counts only outgoing messages from our side
  weInitiated: boolean;
  ourProposal: boolean; // true once we have sent a match_propose
  theirProposal: boolean; // true once the peer has sent a match_propose
  openedAt: string;
  touchedAt: string;
  status: "in_progress" | "matched" | "declined" | "expired";
  messages: NegotiationMessage[];
  sharedNarrative?: MatchNarrative; // populated from peer's match_propose payload
  remoteContact?: ContactChannel; // populated when peer includes contact in their proposal
  // Metadata used for analytics and learning
  closeReason?: string; // reason text for decline or expiry
  preflightScore?: number; // preflight compatibility score in range 0–1
}

export interface MatchNarrative {
  summary: string;
  strengths: string[];
  tensions: string[];
  compatSummary: string;
  commonGround?: string; // a specific shared interest or piece of common ground
  // Confidence signals indicating which dimensions drove or limited the match
  strongDims?: string[]; // dimensions with confidence >= 0.75
  weakDims?: string[]; // dimensions with confidence < floor + 0.1
}

// ── Post-match notification and handoff ───────────────────────────────────────

/**
 * Written to ~/.matchclaw/pending_notification.json when a double-lock match is confirmed.
 * Consumed (and then deleted) by the agent bootstrap / before_prompt_build hook
 * at the start of the user's next session.
 */
export interface PendingNotification {
  introId: string;
  remoteKey: string;
  narrative: MatchNarrative;
  lockedAt: string; // ISO 8601
  // Recognition hook: a behavioral observation that makes the notification feel personal
  // rather than algorithmic — drawn from the highest-confidence observed dimension.
  anchorDimension?: DimensionKey;
  anchorText?: string; // e.g. "the way you shut down when conversations get loud"
}

export type HandoffRound = 1 | 2;
export type HandoffStatus =
  | "pending_consent" // match confirmed, user has not yet been informed
  | "round_1"         // user notified, debrief in progress
  | "round_2"         // contact exchange in progress
  | "complete"        // both rounds finished
  | "expired";        // consent window elapsed

/**
 * Persisted in ~/.matchclaw/handoffs/<introId>/state.json.
 * State transitions are written by Claude to gate progression through rounds.
 */
export interface HandoffState {
  introId: string;
  remoteKey: string;
  stage: HandoffRound;
  status: HandoffStatus;
  narrative: MatchNarrative;
  created_at: string; // ISO 8601
  agreedAt?: string; // timestamp of user consent to the match
  proposal_round?: number; // negotiation round when proposal was made — used for friction calibration
  remoteContact?: ContactChannel; // received via Nostr from peer's match_propose
}

// ── Observation signals ───────────────────────────────────────────────────────

export type DimensionKey =
  | "attachmentType"
  | "mbti"
  | "zodiac"
  | "interests"
  | "moralEthicalAlignment"
  | "familyLifeGoalsAlignment"
  | "lifestyleRelationalBeliefs";

export interface DimensionSignalState {
  /** Confidence level at the time this signal was last delivered to Claude. */
  lastConf: number;
  /** ISO 8601 timestamp of the last context injection for this dimension. */
  deliveredAt: string;
}

/** Persisted in ~/.matchclaw/signals.json — records when each dimension was last surfaced to Claude. */
export interface SignalsFile {
  schema_version: 1;
  byDimension: Partial<Record<DimensionKey, DimensionSignalState>>;
}

// ── Persisted state file aliases ──────────────────────────────────────────────

// ~/.matchclaw/identity.json
export type IdentityFile = AgentMatchIdentity;

// ~/.matchclaw/registration.json
export type RegistrationFile = RegistrationRecord;

// ~/.matchclaw/observation.json
export type ObservationFile = ObservationSummary;

// ~/.matchclaw/preferences.json
export type PreferencesFile = UserPreferences;

// ~/.matchclaw/signals.json
export type SignalsStateFile = SignalsFile;

// ~/.matchclaw/threads/<thread_id>.json
export type ThreadFile = NegotiationState;
