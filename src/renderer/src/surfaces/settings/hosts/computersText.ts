import { ACCOUNT_PROVIDERS, PROVIDER_OF, type AccountProvider } from "@server/shared/accounts";
import { SETUP_STEPS, type ComputerRow, type GiverRecord, type SetupItems, type SetupStep, type SetupStepRow } from "@server/shared/contract-devices";
import type { SavedEnvironment } from "@server/shared/contract-remote";
import { PROVIDER_NAME } from "@server/shared/usageMeter";
import { ago } from "../../harnessLine";

/** The words the Computers group and the setup screens say, kept apart from their markup. */

/** "2 Claude", "1 Codex": what a computer holds, by provider, in the Accounts page's order; "No accounts" for none. */
export function holdsParts(holds: readonly { service: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const { service } of holds) {
    const provider = (PROVIDER_OF as Record<string, AccountProvider | undefined>)[service];
    if (provider) counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  const parts = ACCOUNT_PROVIDERS.filter((p) => counts.has(p)).map((p) => `${counts.get(p)} ${PROVIDER_NAME[p]}`);
  return parts.length > 0 ? parts : ["No accounts"];
}

/** "synced 3m ago"; "not synced yet" before its first word. */
export const syncedText = (at: number | null, now = Date.now()): string => (at === null ? "not synced yet" : `synced ${ago(at, now)}`);

/** A computer's line under its name: a removal waiting on it says only that. */
export function computerParts(row: ComputerRow, now = Date.now()): string[] {
  if (row.waitingForContact) return [`Waiting for ${row.name} to be in touch`];
  if (row.state === "stopped") return ["Stopped", syncedText(row.syncedAt, now)];
  return [...holdsParts(row.holds), ...(row.paused ? ["paused"] : []), syncedText(row.syncedAt, now)];
}

/** This window's desktop is the giver: its key on the box is the giver's. */
export const isGiverHere = (giver: GiverRecord | null, saved: readonly SavedEnvironment[]): boolean =>
  !!giver && saved.some((env) => !!env.keyId && env.keyId === giver.keyId);

/** What a link gives, in the order the dialog lists it: "link to the box, your accounts, LifeOS with Outlook and Teams, folders in Files". */
export function givesText(items: SetupItems): string {
  const parts = ["link to the box"];
  if (items.accounts) parts.push("your accounts");
  if (items.lifeos) parts.push(items.reader ? "LifeOS with Outlook and Teams" : "LifeOS");
  if (items.folders) parts.push("folders in Files");
  return parts.join(", ");
}

export function stepTitle(step: SetupStep, giverName: string): string {
  switch (step) {
    case "link":
      return "Link to the box";
    case "allow":
      return `Allow on ${giverName}`;
    case "accounts":
      return "Accounts";
    case "lifeos":
      return "LifeOS";
    case "work":
      return "Work signed in to LifeOS";
    case "folders":
      return "Folders in Files";
  }
}

/**
 * A failed step's reason as the row under its title says it, beside the row's own Retry: no "Retry." in the sentence,
 * and the LifeOS installer's exit code left to the log ("The LifeOS installer did not finish.").
 */
export function stepReasonWords(step: SetupStep, reason: string | null | undefined): string {
  if (!reason) return "It did not finish.";
  if (step === "lifeos" && /^The installer (stopped with code|did not finish)/.test(reason)) return "The LifeOS installer did not finish.";
  const bare = reason.replace(/\s*Retry\.?$/, "").trim();
  return /[.!?]$/.test(bare) ? bare : `${bare}.`;
}

/** A step that moved, over the row on file; a step the host had not listed yet joins at its place in the order. */
export function landStep(steps: readonly SetupStepRow[], row: SetupStepRow): SetupStepRow[] {
  const next = steps.some((s) => s.step === row.step) ? steps.map((s) => (s.step === row.step ? row : s)) : [...steps, row];
  return [...next].sort((x, y) => SETUP_STEPS.indexOf(x.step) - SETUP_STEPS.indexOf(y.step));
}

/** Every step listed is done: Ready. */
export const allDone = (steps: readonly SetupStepRow[]): boolean => steps.length > 0 && steps.every((s) => s.state === "done");

/** The three words as the giver's notice shows them. */
export const wordsText = (words: readonly string[]): string => words.join(" · ");
