import { useRef, useState } from "react";
import type { Saved } from "./useSaved";

/**
 * A set a page saves whole on every change (New threads, Reviews, Builds from plans): the change shows at once, the
 * row it came from carries the save (`useSaved`). One change at a time: a pick while one is out is refused here
 * (`busy` says so; the page draws its controls held through `useHeldLook`). A refusal puts back the set the last good
 * save sent (`accepted`), else the one the computer confirmed. A newer confirmed set (the store's answer, a push)
 * replaces whatever was shown once no change is out.
 */
export function useDraft<T>(confirmed: T | undefined) {
  const [draft, setDraft] = useState<T | null>(null);
  const [held, setHeld] = useState(confirmed);
  // What the last good save sent, standing over `confirmed` (a store that does not echo a save) until a newer one comes.
  const [accepted, setAccepted] = useState<T | null>(null);
  const [out, setOut] = useState(0);
  // A newer confirmed set came while a change was out: shown once it answers.
  const [missed, setMissed] = useState(false);
  const inFlight = useRef(0);
  // A set the same in every value is the same answer: only a new one replaces what is shown.
  if (held !== confirmed && JSON.stringify(held) !== JSON.stringify(confirmed)) {
    setHeld(confirmed);
    setAccepted(null);
    if (out === 0) setDraft(null);
    else setMissed(true);
  }
  if (missed && out === 0) {
    setMissed(false);
    setDraft(null);
  }
  const value = draft ?? confirmed;
  const change = async (saved: Saved, next: T, write: (next: T) => unknown): Promise<boolean> => {
    // Refused at once while a change is out, whatever the controls look like yet.
    if (inFlight.current > 0) return false;
    const back = accepted;
    inFlight.current += 1;
    setOut(inFlight.current);
    setDraft(next);
    const landed = await saved.run(() => write(next));
    inFlight.current -= 1;
    setOut(inFlight.current);
    if (landed) setAccepted(next);
    else setDraft(back);
    return landed;
  };
  return { value, change, busy: out > 0 };
}
