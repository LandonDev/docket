import { useDeferredValue } from "react";

/** Past this many paths a picker ranks in a transition: the field takes the key first, the rows follow. */
export const RANK_IN_TRANSITION = 5_000;

/** The query a list of `size` paths is ranked on: the typed one, or past RANK_IN_TRANSITION its deferred copy. */
export function useRankQuery(query: string, size: number): string {
  const deferred = useDeferredValue(query);
  return size > RANK_IN_TRANSITION ? deferred : query;
}
