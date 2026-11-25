import { useEffect, useState } from "react";
import { savingNow, stageNow, type Unsaved } from "./calm";

/** Draws again when a threshold of the rule passes with nothing else new. */
function useWake(again: number | null): void {
  const [, wake] = useState(0);
  useEffect(() => {
    if (again === null) return;
    const timer = setTimeout(() => wake((n) => n + 1), again + 1);
    return () => clearTimeout(timer);
  }, [again]);
}

/** Whether the save line says Saving… now, by calm.ts's rule; the component draws again when that changes by time. */
export function useSaving(u: Unsaved): boolean {
  // The clock is read on every draw: the React Compiler must not keep an answer from an earlier one.
  "use no memo";
  const { saving, again } = savingNow(u, Date.now());
  useWake(again);
  return saving;
}

/** Whether a stage that began at `since` (null: none) has lasted long enough to show. */
export function useStage(since: number | null): boolean {
  "use no memo";
  const { shown, again } = stageNow(since, Date.now());
  useWake(again);
  return shown;
}

/** When `on` last turned true, read in the same draw it turns (null while it is false). */
export function useSince(on: boolean): number | null {
  "use no memo";
  const [since, setSince] = useState<number | null>(null);
  if (on && since === null) setSince(Date.now());
  if (!on && since !== null) setSince(null);
  return on ? (since ?? Date.now()) : null;
}

/** The last value `steady` held true for, by its key: what a line said before a stage that is not shown yet. */
export function useLast<T>(value: T | null, steady: boolean, key: (value: T) => string): T | null {
  const [last, setLast] = useState<T | null>(null);
  if (value !== null && steady && (last === null || key(last) !== key(value))) setLast(value);
  return value !== null && steady ? value : last;
}
