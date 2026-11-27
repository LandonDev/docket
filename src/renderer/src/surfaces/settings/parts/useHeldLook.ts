import { useEffect, useState } from "react";
import { SAVE_SLOW_MS } from "./useSaved";

/**
 * How a held control looks (docs/agents/settings.md "Feedback"): a control is held at once while a save or a read its
 * value depends on is out (its handler refuses a new pick), but it is drawn disabled only once the hold has lasted
 * `SAVE_SLOW_MS`, as the row's spinner is, so a save that answers in a few frames never flashes the page.
 */
export function useHeldLook(held: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!held) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SAVE_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [held]);
  return held && slow;
}
