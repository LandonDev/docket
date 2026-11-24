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

/** A host's name at the head of a line: "The box", "This Mac", "MacBook". */
export const atHead = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
