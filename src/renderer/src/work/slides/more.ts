import type { CanvasShell, MoreEntry } from "../canvas/kind";

/**
 * The deck's own rows of the pane's More come from two places (Export…, and
 * what its file can do: Save to Google Slides, Read again from Google), and
 * the shell takes one list. Each place feeds its rows under a name; the list
 * the shell gets is all of them, in the order of their names.
 */
const feeds = new WeakMap<CanvasShell, Map<string, MoreEntry[]>>();

export function feedMore(shell: CanvasShell, who: string, entries: MoreEntry[] | null): void {
  if (!shell.more) return;
  const mine = feeds.get(shell) ?? feeds.set(shell, new Map()).get(shell)!;
  if (entries?.length) mine.set(who, entries);
  else mine.delete(who);
  const all = [...mine.keys()].sort().flatMap((name) => mine.get(name)!);
  shell.more(all.length ? all : null);
}
