import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { VirtualRows } from "../chrome/railVirtualRows";

/**
 * Work's long lists, windowed as the Files list is (work/files/Page.tsx, the model; docs/agents/work-perf.md "Long
 * lists"): up to PLAIN_MOST rows are drawn whole; past it only the rows near the screen are mounted, inside the list's
 * own scrolling parent (the view frame's body). The list keeps its role and its keyboard order; each windowed row says
 * where it stands (`aria-posinset` of `aria-setsize`), so a screen reader still hears the whole count.
 */

/** Past this many rows a list mounts only those near the screen: the Files list's own line. */
export const PLAIN_MOST = 80;

/** What a windowed row adds to its own element: its place in the whole list. */
export type RowPlace = { "aria-posinset": number; "aria-setsize": number } | Record<string, never>;

const NO_PLACE: RowPlace = {};

/** The nearest ancestor that scrolls up and down: where a windowed list measures its window. */
function scrollParentOf(node: HTMLElement): HTMLElement | null {
  for (let at = node.parentElement; at; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll") return at;
  }
  return null;
}

export function WindowedRows({
  count,
  rowHeight,
  getKey,
  render,
  sizeKey,
}: {
  count: number;
  /** A row's height in pixels: every row of these lists is one fixed height. */
  rowHeight: number;
  getKey: (index: number) => string;
  /** One row; `place` goes on its own element while the list is windowed. */
  render: (index: number, place: RowPlace) => ReactNode;
  /** Lists that share a key share a remembered scroller size. */
  sizeKey: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [frame, setFrame] = useState<{ scroller: HTMLElement; margin: number } | null>(null);
  // One place object a row for as long as the count stands: a memoised row is handed the same one each render.
  const places = useMemo(() => new Map<number, RowPlace>(), [count]);
  const placeOf = (index: number): RowPlace => {
    let place = places.get(index);
    if (!place) places.set(index, (place = { "aria-posinset": index + 1, "aria-setsize": count }));
    return place;
  };
  // Before paint: the scroller is found and the list's offset in it read, so the first frame has its rows.
  useLayoutEffect(() => {
    if (!anchor) return;
    const scroller = scrollParentOf(anchor);
    if (!scroller) return;
    const margin = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    setFrame({ scroller, margin });
  }, [anchor]);
  if (count <= PLAIN_MOST) return <>{Array.from({ length: count }, (_, index) => render(index, NO_PLACE))}</>;
  return (
    <div ref={setAnchor} className="w-full">
      {frame ? (
        <VirtualRows
          count={count}
          scroller={frame.scroller}
          scrollMargin={frame.margin}
          estimateSize={() => rowHeight}
          getItemKey={getKey}
          gap={0}
          reveal={null}
          sizeKey={sizeKey}
          render={(index) => render(index, placeOf(index))}
        />
      ) : null}
    </div>
  );
}

/**
 * A list's rows, each the same object as before while it holds what it held (its JSON): a push that answers the whole
 * list again hands a memoised row its old object, so only the row that changed draws. The same array when nothing moved.
 */
export function useKeptRows<T>(rows: readonly T[] | null, keyOf: (row: T) => string): readonly T[] | null {
  // A box of the hook's own, read and written while rendering (as today/stable.ts keeps its rows).
  const [kept] = useState(() => ({ handed: null as readonly T[] | null, rows: null as readonly T[] | null, byKey: new Map<string, { json: string; row: T }>() }));
  if (rows === null) return null;
  if (rows === kept.handed) return kept.rows;
  kept.handed = rows;
  const byKey = new Map<string, { json: string; row: T }>();
  let same = !!kept.rows && kept.rows.length === rows.length;
  const next = rows.map((row, i) => {
    const key = keyOf(row);
    const json = JSON.stringify(row);
    const was = kept.byKey.get(key);
    const out = was && was.json === json ? was.row : row;
    byKey.set(key, { json, row: out });
    if (same && kept.rows![i] !== out) same = false;
    return out;
  });
  kept.byKey = byKey;
  if (!same) kept.rows = next;
  return kept.rows;
}
