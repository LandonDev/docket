import type { ThreadRow } from "./workspaceSessions";

/**
 * Whether a list's threads live on two or more hosts. A host glyph tells
 * threads apart only then: with every thread on one host, each row and chip
 * would show the same glyph, one fact said on every line (docs/agents/one-project-across-hosts.md).
 */
export function spansHosts(environmentIds: Iterable<string | null | undefined>): boolean {
  let first: string | null = null;
  for (const id of environmentIds) {
    if (!id) continue;
    if (first === null) first = id;
    else if (id !== first) return true;
  }
  return false;
}

/** Every host of a list of thread rows, their subagents and batches included. */
export function* rowHosts(rows: Iterable<ThreadRow>): Generator<string | undefined> {
  for (const row of rows) {
    yield row.environmentId;
    if (row.children) yield* rowHosts(row.children);
    if (row.batch) yield* rowHosts(row.batch);
  }
}

/** On a list's container while its threads share one host: the host glyphs in it draw nothing.
 *  A class, so no row takes a new prop or re-renders when the list's hosts change. */
export const ONE_HOST = "[&_[data-host-glyph]]:hidden";
