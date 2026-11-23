import type { ThreadRules } from "@server/shared/rules";

/** A tune's pure rules, apart from chrome/ThreadTune.tsx so the first paint's
 *  New thread chooser starts a run without carrying the tune view, which
 *  loads with threadTuneChunk (surfaces/chunks.ts). */

export function isEmptyTune(tune: ThreadRules): boolean {
  return !tune.instructions?.trim() && Object.keys(tune.conduct ?? {}).length === 0;
}

/** `null` when nothing is overridden, so the server clears the thread's rules. */
export function normalizeTune(tune: ThreadRules): ThreadRules | null {
  if (isEmptyTune(tune)) return null;
  const out: ThreadRules = {};
  if (tune.instructions?.trim()) out.instructions = tune.instructions.trim();
  if (tune.conduct && Object.keys(tune.conduct).length > 0) out.conduct = tune.conduct;
  return out;
}
