import { useState } from "react";

export { PLAIN_MOST, tableRowCount, WindowedRows, WindowedTableRows, type RowPlace, type TableRowPlace } from "../chrome/windowedRows";

/**
 * A list's rows, each the same object as before while it holds what it held (its JSON): a push that answers the whole
 * list again hands a memoised row its old object, so only the row that changed draws. The same array when nothing moved.
 */
export function useKeptRows<T>(rows: readonly T[] | null, keyOf: (row: T) => string): readonly T[] | null {
  const [keeper] = useState(() => rowKeeper(keyOf));
  return keeper.keep(rows);
}

/**
 * The keeping itself, an object of the hook's own whose method holds what it last handed: a render calls it and writes
 * nothing into a hook's value (the React Compiler keeps the components that use it).
 */
export function rowKeeper<T>(keyOf: (row: T) => string): { keep(rows: readonly T[] | null): readonly T[] | null } {
  let handed: readonly T[] | null = null;
  let kept: readonly T[] | null = null;
  let byKey = new Map<string, { json: string; row: T }>();
  return {
    keep(rows) {
      if (rows === null) return null;
      if (rows === handed) return kept;
      handed = rows;
      const next = new Map<string, { json: string; row: T }>();
      let same = !!kept && kept.length === rows.length;
      const out = rows.map((row, i) => {
        const key = keyOf(row);
        const json = JSON.stringify(row);
        const was = byKey.get(key);
        const use = was && was.json === json ? was.row : row;
        next.set(key, { json, row: use });
        if (same && kept![i] !== use) same = false;
        return use;
      });
      byKey = next;
      if (!same) kept = out;
      return kept;
    },
  };
}
