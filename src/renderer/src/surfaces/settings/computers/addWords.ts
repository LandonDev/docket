import type { Capability } from "@server/shared/capabilities";
import { hostErrorText } from "../../../lib/hostConnection";
import { refusalWords } from "../../../lib/settingsHome";

/**
 * The words and caps of Add a computer… (docs/agents/settings.md "Add a computer"): what a device may do, as he reads
 * it, and the caps each choice sends, which are the capability sets the old Pair and key dialogs sent.
 */

export type Allow = "look" | "run" | "approve" | "manage";

/** Every key reads; each choice adds to the one before it. */
export const ALLOW_CAPS: Record<Allow, Capability[]> = {
  look: [],
  run: ["operate"],
  approve: ["operate", "approve"],
  manage: ["operate", "approve", "admin"],
};

/** A bot holds at most `run` (the host's own ceiling for an MCP key). */
export const BOT_ALLOWS: readonly Allow[] = ["look", "run"];

/** The four choices of "It may", each with its line. `computer` is the name in a sentence ("the box", "this Mac"). */
export function allowChoices(computer: string): { value: Allow; label: string; description: string }[] {
  return [
    { value: "look", label: "Look only", description: "Read threads and files" },
    { value: "run", label: "Run threads", description: "Start, steer and stop threads" },
    { value: "approve", label: "Run threads and approve", description: "Also answer when a thread asks before a risky step" },
    { value: "manage", label: `Manage ${computer}`, description: `Everything above, and add devices and change every setting on ${computer}` },
  ];
}

/** "One use. Ends in 10 minutes.", in whole minutes rounded up (a clock-like 9:42 reads as a time of day), then
 *  "under a minute", then that it has ended. */
export function endsText(left: number): string {
  if (left <= 0) return "This link has ended.";
  if (left < 60) return "One use. Ends in under a minute.";
  const minutes = Math.ceil(left / 60);
  return `One use. Ends in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/** A sentence's first letter raised: "the box" starts a line as "The box". */
export const capital = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

/**
 * A refusal as the dialog says it: never the host's raw "forbidden: remote.pairings.create needs admin". `computer`
 * is the computer asked, as a sentence names it.
 */
export function addErrorWords(err: unknown, computer: string): string {
  const raw = hostErrorText(err).trim();
  if (/^forbidden: \S+ needs \w+/i.test(raw)) return `This window's key may not add devices to ${computer}. Do it from a computer that manages ${computer}.`;
  if (/^forbidden:/i.test(raw)) return `${capital(computer)} did not allow this.`;
  if (/makes no setup links/i.test(raw)) return `${capital(computer)} makes no setup links. Make one on the computer that set it up.`;
  if (/^not connected|did not answer|timed? ?out/i.test(raw)) return `${capital(computer)} did not answer. Try again once it is connected.`;
  return refusalWords(raw) || `${capital(computer)} did not make it. Try again.`;
}
