import { useCallback, useEffect, useRef, useState } from "react";
import { refusalWords } from "../../../lib/settingsHome";

/**
 * How a change that leaves the window reports itself (docs/agents/settings.md "Feedback, one contract"). The control
 * moves at once (`SettingSwitch`, `CommitField` and the selects do that themselves); an answer that takes over
 * `SAVE_SLOW_MS` puts a spinner before the control (`slow`); the answer holds a check and "Saved" for `SAVED_HOLD_MS`
 * (`saved`); a refusal leaves the row's red line saying why in the house's words (`error`), and `run` resolves false
 * so the control goes back to the last value the computer confirmed. A change kept in this window alone shows in the
 * control and needs none of this.
 */
export const SAVE_SLOW_MS = 150;
export const SAVED_HOLD_MS = 1_400;

export type SaveState = "idle" | "saving" | "slow" | "saved";

export type Saved = {
  state: SaveState;
  /** Why the newest change was refused; null once another is tried or lands. */
  error: string | null;
  /** Runs a change. Resolves true once the computer took it; false when it refused, rejected or resolved `false`. */
  run: (change: () => unknown) => Promise<boolean>;
};

/** What a refusal says when the computer gave no reason. */
export const NOT_SAVED = "This did not save.";

export function useSaved(): Saved {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  // The newest change owns the marks: an older one's answer changes nothing.
  const turn = useRef(0);
  const timers = useRef<number[]>([]);
  const clearTimers = (): void => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  const run = useCallback(async (change: () => unknown): Promise<boolean> => {
    const mine = ++turn.current;
    clearTimers();
    setError(null);
    setState("saving");
    timers.current.push(window.setTimeout(() => turn.current === mine && setState("slow"), SAVE_SLOW_MS));
    let landed = true;
    let why = "";
    try {
      landed = (await change()) !== false;
    } catch (err) {
      landed = false;
      why = refusalWords(err);
    }
    if (turn.current !== mine) return landed;
    clearTimers();
    if (!landed) {
      setState("idle");
      setError(why || NOT_SAVED);
      return false;
    }
    setState("saved");
    timers.current.push(window.setTimeout(() => turn.current === mine && setState("idle"), SAVED_HOLD_MS));
    return true;
  }, []);

  return { state, error, run };
}
