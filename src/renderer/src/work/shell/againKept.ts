import { useCallback, useState } from "react";

/** A read asked afresh by its Retry (`attempt`, a remount's key), and whether a press is out (`retrying`). */
export interface AgainKept {
  attempt: number;
  retrying: boolean;
  retry: () => void;
  /** The new read answered: the reader calls it once its read is no longer loading. Stable across renders. */
  settle: () => void;
}

/**
 * Retry on a read that mounts afresh (a `key` that grows): while the read he asked for is out, the reader keeps its
 * failed line with Retry spinning in place (docs/DESIGN.md "Loading and empty states"), never its bones, until the
 * answer replaces it. Only his press does that: a read again the reader starts by itself draws its own loading state.
 */
export function useAgainKept(): AgainKept {
  const [state, setState] = useState({ attempt: 0, retrying: false });
  const retry = useCallback(() => setState((s) => ({ attempt: s.attempt + 1, retrying: true })), []);
  const settle = useCallback(() => setState((s) => (s.retrying ? { ...s, retrying: false } : s)), []);
  return { ...state, retry, settle };
}
