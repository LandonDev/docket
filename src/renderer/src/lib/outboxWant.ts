/**
 * The Outbox's door for "open on this one" (docs/agents/work-outbox.md "The
 * screens"): a notice, Mail's composer, Today, the transcript's held line
 * and a thread's request card name what the Outbox page should pick, and
 * the page picks it once its lists hold it. All of it the first paint
 * holds: it imports nothing.
 *
 *   wantOutbox("box:host:h12")                 an item, by the page's own key
 *   wantOutbox("request:box:r3")               a thread's request
 *   wantOutbox({ environmentId: "box", n: 12 }) "Held as item 12", by its host's number
 */
export type OutboxWant = string | { environmentId: string; n: number };

let wanted: OutboxWant | null = null;
const listeners = new Set<() => void>();

export function wantOutbox(want: OutboxWant | null): void {
  if (wanted === want) return;
  wanted = want;
  for (const listener of listeners) listener();
}

export const wantedOutbox = (): OutboxWant | null => wanted;

export function subscribeOutboxWant(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
