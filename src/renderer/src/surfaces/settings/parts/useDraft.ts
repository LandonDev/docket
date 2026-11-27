import { useRef, useState } from "react";
import type { Saved } from "./useSaved";

/**
 * A set a page saves whole on every change (New threads, Reviews, Builds from plans): the change shows at once, the
 * row it came from carries the save (`useSaved`), and a refusal puts back the set the computer last confirmed. A
 * newer confirmed set (the store's answer, a push) replaces whatever was shown, once no change of this page is still
 * out: while one is, the first save's answer does not wipe the second pick from the screen.
 */
export function useDraft<T>(confirmed: T | undefined) {
  const [draft, setDraft] = useState<T | null>(null);
  const [held, setHeld] = useState(confirmed);
  const [out, setOut] = useState(0);
  // A newer confirmed set came while a change was out: shown once the last one answers.
  const [missed, setMissed] = useState(false);
  const inFlight = useRef(0);
  // A set the same in every value is the same answer: only a new one replaces what is shown.
  if (held !== confirmed && JSON.stringify(held) !== JSON.stringify(confirmed)) {
    setHeld(confirmed);
    if (out === 0) setDraft(null);
    else setMissed(true);
  }
  if (missed && out === 0) {
    setMissed(false);
    setDraft(null);
  }
  const value = draft ?? confirmed;
  const change = async (saved: Saved, next: T, write: (next: T) => unknown): Promise<boolean> => {
    inFlight.current += 1;
    setOut(inFlight.current);
    setDraft(next);
    const landed = await saved.run(() => write(next));
    inFlight.current -= 1;
    setOut(inFlight.current);
    if (!landed) setDraft(null);
    return landed;
  };
  // A save of this set is out: the page holds every control of the set (no new pick) until it answers, so no second
  // change is ever laid on a set the first may yet replace, and a refusal puts back that one change alone.
  return { value, change, busy: out > 0 };
}
