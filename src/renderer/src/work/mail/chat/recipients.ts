/**
 * Whom a draft the chat wrote goes to, against the thread it answers (docs/agents/work-mail.md "The chat beside the
 * mail"): a mail's words can steer a draft to another address or add a bcc, so the card names every recipient and
 * says in one line when any is not already on the thread, or is a bcc. Pure.
 */
export type Address = { name?: string | undefined; address: string };
type Recipients = { to: readonly Address[]; cc: readonly Address[]; bcc: readonly Address[] };
type ThreadMessage = { from: Address; replyTo?: Address | undefined; to: readonly Address[]; cc: readonly Address[] };

const key = (a: Address): string => a.address.trim().toLowerCase();

/** The draft's recipients not on the thread (no thread known: none), and its bcc, which is always told. */
export function strangers(draft: Recipients, thread: readonly ThreadMessage[] | null): { outside: Address[]; bcc: Address[] } {
  const on = new Set<string>();
  for (const m of thread ?? []) for (const a of [m.from, ...(m.replyTo ? [m.replyTo] : []), ...m.to, ...m.cc]) on.add(key(a));
  const outside = thread ? [...draft.to, ...draft.cc].filter((a) => !on.has(key(a))) : [];
  return { outside, bcc: [...draft.bcc] };
}

/** The card's one plain line, or null when every recipient is on the thread and there is no bcc. */
export function strangersLine(found: { outside: readonly Address[]; bcc: readonly Address[] }): string | null {
  const list = (as: readonly Address[]): string => as.map((a) => a.address).join(", ");
  const parts = [found.outside.length ? `Not on this thread: ${list(found.outside)}` : "", found.bcc.length ? `Bcc: ${list(found.bcc)}` : ""].filter(Boolean);
  return parts.length ? `${parts.join(". ")}.` : null;
}
