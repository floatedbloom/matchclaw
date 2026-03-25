/**
 * Prompt builders for observation update instructions.
 *
 * Both the command:new hook and the periodic before_prompt_build update flow
 * need to inject observation instructions into Claude's context. Centralising
 * them here keeps the wording consistent across both paths.
 */

import type { ObservationSummary } from "./schema.js";
import { eligibilityReport } from "./profile.js";

/**
 * Instruction injected during before_prompt_build when the observation data
 * has gone stale and needs a periodic refresh.
 */
export function buildStaleObservationPrompt(
  obs: ObservationSummary,
  daysSinceUpdate: number,
  cliCommand: string,
): string {
  const report = eligibilityReport(obs);
  return (
    `[MatchClaw] This user's observation data is ${Math.floor(daysSinceUpdate)} days old and needs a refresh. ` +
    `Go over what you know and revise it at a natural moment. Persist it with \`${cliCommand} observe --write '<json>'\`.\n\n` +
    `CURRENT OBSERVATION:\n${JSON.stringify(obs, null, 2)}\n\n` +
    `ELIGIBILITY REPORT:\n${report}\n\n` +
    `Do NOT prompt the user with questions to speed this along. A revision is warranted only when genuinely new signal has emerged.`
  );
}

/**
 * Instruction injected when a user has existing Claude memory but no observation
 * manifest has been created yet. Allows long-time Claude users to bootstrap
 * eligibility from prior conversation history without starting from scratch.
 */
export function buildBootstrapObservationPrompt(
  emptyTemplate: ObservationSummary,
  cliCommand: string,
): string {
  return (
    `[MatchClaw] Conversation history exists for this user, but an observation manifest has not been created yet. ` +
    `Go through what you already know and fill in the observation once there is enough to go on. ` +
    `Persist it with \`${cliCommand} observe --write '<json>'\`.\n\n` +
    `If the user asks what you have on file or whether observations are needed: explain that their preferences (location, age, contact) were captured during setup, and that observations — behavioral signals gathered over time — are what still need to be built. Do not say you have "nothing"; the preferences are already there.\n\n` +
    `EMPTY OBSERVATION TEMPLATE:\n${JSON.stringify(emptyTemplate, null, 2)}\n\n` +
    `Draw on your existing memory to fill this in — do NOT ask the user questions to hurry it along. ` +
    `The observation should only be written once real behavioral signal has accumulated across more than one session.`
  );
}

/**
 * Instruction injected when the user explicitly ends a session via /new.
 * Prompts Claude to review what was learned and update the observation manifest.
 */
export function buildSessionEndObservationPrompt(
  obs: ObservationSummary,
  cliCommand: string,
): string {
  const report = eligibilityReport(obs);
  const observationBlock =
    `CURRENT OBSERVATION:\n${JSON.stringify(obs, null, 2)}\n\n` +
    `ELIGIBILITY REPORT:\n${report}`;

  // Determine whether any dimension has non-zero confidence.
  // Note: conversation_count is not used here — it only counts sessions since install,
  // so a veteran Claude user on their first post-install session could already show
  // meaningful confidence scores while still having conversation_count: 0.
  const anySignalPresent = [
    obs.attachmentType,
    obs.mbti,
    obs.zodiac,
    obs.interests,
    obs.moralEthicalAlignment,
    obs.familyLifeGoalsAlignment,
    obs.lifestyleRelationalBeliefs,
  ].some((dim) => dim.confidence > 0);

  // Tailor the ineligibility message based on whether there is any signal at all.
  const ineligibilityGuidance = anySignalPresent
    ? `If poolEligible is false, let the user know in a natural way — e.g. "There's already ` +
      `a decent amount I can say about you, though a few things I'd want to be more certain of ` +
      `before making an introduction. If you'd rather not wait, just say so — I can work with ` +
      `what I have and fill in the gaps from context."`
    : `If poolEligible is false, let the user know in a natural way — e.g. "Our conversations ` +
      `are still giving me a fuller picture of you. Once there's enough to work with, ` +
      `I'll bring it up."`;

  return (
    `[MatchClaw] The session has ended. Look over the observation summary below and revise it ` +
    `to reflect anything new that came up this session. Persist the result with ` +
    `\`${cliCommand} observe --write '<json>'\`.\n\n` +
    ineligibilityGuidance +
    `\nDo NOT pose questions to the user to speed this up.\n\n` +
    observationBlock
  );
}
