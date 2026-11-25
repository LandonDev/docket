import type { LifeosStateName } from "@shared/contract-work-lifeos";
import { nameInLine } from "../../lib/hostWords";

/**
 * A down LifeOS session in words, its computer named (docs/DESIGN.md "Loading and empty states"): the rule's words
 * with no weight, for a window that must not load lifeos.ts and the Convex client it holds (the capture window).
 * `sessionFailure` in lifeos.ts is this function: one copy of the words.
 *
 * `host` is the computer the session reads through ("The box", "This Mac"); with none it is "this host".
 * `unanswered` is the host's own silence, said by its name.
 */
export function lifeosDownWords(state: LifeosStateName | "unanswered", withheld?: boolean, host?: string | null): string {
  const at = host ? nameInLine(host) : "this host";
  if (withheld) return `This computer cannot read LifeOS through ${at}`;
  if (state === "unanswered") return `${host ?? "The host"} did not answer`;
  if (state === "unreachable") return host ? `LifeOS did not answer ${at}` : "LifeOS did not answer";
  if (state === "refused") return `LifeOS refused ${at}'s sign-in`;
  if (state === "off") return `Work is off on ${at}`;
  if (state === "pairing") return host ? `The LifeOS sign-in on ${at} waits for your approval` : "The LifeOS sign-in waits for your approval";
  return host ? `Not signed in to LifeOS on ${at}` : "Not signed in to LifeOS";
}

/**
 * A session on its way, in one wording everywhere (a wait: no press goes with it), its computer named: "LifeOS is
 * still connecting on the box"; with no computer known, "LifeOS is still connecting".
 */
export const connectingWords = (host?: string | null): string => (host ? `LifeOS is still connecting on ${nameInLine(host)}` : "LifeOS is still connecting");

/** A host's name at the head of a line: "The box", "This Mac", "MacBook". */
export const atHead = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * The LifeOS state a host's failure text names, or null for any other cause: the host's own sentences for a LifeOS it
 * could not ask (`UNAVAILABLE_WORDS` in src/main/server/work/lifeos/session.ts) and an answer that never came. A host
 * that sends such a reason inside an answer (Waiting on's days) is worded by `sessionFailure` from it, never verbatim.
 */
export function lifeosStateOf(reason: string): LifeosStateName | null {
  for (const [form, state] of STATE_WORDS) if (form.test(reason)) return state;
  return null;
}

const STATE_WORDS: [RegExp, LifeosStateName][] = [
  [/work is off on this host/i, "off"],
  [/not signed in to lifeos/i, "signed-out"],
  [/lifeos sign-in waits for approval/i, "pairing"],
  [/lifeos is still connecting/i, "connecting"],
  [/lifeos refused this host's sign-in/i, "refused"],
  [/lifeos is unreachable|\btimed out\b|^timeout\b|no answer in \d|fetch failed|\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)\b/i, "unreachable"],
];
