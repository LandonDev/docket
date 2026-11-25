/**
 * Rows his own acts are changing (docs/DESIGN.md "The Files place": a row his act is changing shows the list's spinner
 * and its verb until the host answers): opening, renaming, moving, copying, deleting, downloading. A map by row key, so
 * two acts at once each keep their own words.
 */

/** What a row says while his act is changing it: the one word beside its spinner, and while a rename is out the name he typed. */
export interface RowBusy {
  word: string;
  name?: string;
  /** the act that marked it: a let-go from any other act leaves it (`rowMarks`) */
  by?: symbol;
}
/** The rows his acts are changing now, by key: each its own, so a second open never takes the first one's words. Null is none. */
export type Busy = ReadonlyMap<string, RowBusy> | null;
/** Marks rows as his act changes them, or lets them go (null): with `by`, only the rows that act's mark still holds. */
export type MarkBusy = (keys: readonly string[], busy: RowBusy | null, by?: symbol) => void;
/** What one row says while busy, or null. */
export const busyOf = (busy: Busy, key: string): RowBusy | null => busy?.get(key) ?? null;
/** The rows marked, these marked or let go. */
export function marked(busy: Busy, keys: readonly string[], next: RowBusy | null, by?: symbol): Busy {
  const map = new Map(busy ?? []);
  for (const key of keys) {
    if (next) map.set(key, next);
    else if (by === undefined || map.get(key)?.by === by) map.delete(key);
  }
  return map;
}

/**
 * One act's marks on its rows: `say` puts its words there (again as it gets on), `done` lets go of only the rows that
 * still say its words, so an earlier act on the same row that ends later never takes a newer act's spinner away.
 */
export function rowMarks(mark: MarkBusy | undefined, keys: readonly string[]): { say(busy: RowBusy): void; done(): void } {
  const by = Symbol("act");
  return { say: (busy) => mark?.(keys, { ...busy, by }), done: () => mark?.(keys, null, by) };
}

/** How far a copy from another computer, or a download, has got, in the words of its row. */
export function openingWords(done: number, total: number, verb: "Opening…" | "Downloading…" = "Opening…"): string {
  const mb = (n: number): string => (n < 10 * 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) : String(Math.round(n / 1024 / 1024)));
  return `${verb} ${mb(done)} of ${mb(total)} MB`;
}
