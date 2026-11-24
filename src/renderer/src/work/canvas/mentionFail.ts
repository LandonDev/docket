import type { ChipKind } from "@shared/work";
import { lifeosHeardWords } from "../shell/lifeos";

/** The kinds the host reads from LifeOS (each a `MentionSource` with `lifeos`). */
export const LIFEOS_KINDS: readonly ChipKind[] = ["task", "mail", "event", "project", "card", "person", "doc", "chat"];

/**
 * What a mention search that left kinds out says in its one muted row (the composer's @, a play's picker): when every
 * kind it left out is LifeOS's, the host's LifeOS state in the rule's words with its computer named
 * (`lifeosHeardWords`); else that not everything was searched. Null when nothing was left out.
 */
export function mentionFailWords(failed: readonly ChipKind[], environmentId: string): string | null {
  if (!failed.length) return null;
  return failed.every((k) => LIFEOS_KINDS.includes(k)) ? lifeosHeardWords(environmentId) : "Couldn't search everything";
}
