import { useState } from "react";
import type { Saved } from "./useSaved";

/**
 * A set a page saves whole on every change (New threads, Reviews, Builds from plans): the change shows at once, the
 * row it came from carries the save (`useSaved`), and a refusal puts back the set the computer last confirmed. A
 * newer confirmed set (the store's answer, a push) replaces whatever was shown.
 */
export function useDraft<T>(confirmed: T | undefined) {
  const [draft, setDraft] = useState<T | null>(null);
  const [held, setHeld] = useState(confirmed);
  // A set the same in every value is the same answer: only a new one replaces what is shown.
  if (held !== confirmed && JSON.stringify(held) !== JSON.stringify(confirmed)) {
    setHeld(confirmed);
    setDraft(null);
  }
  const value = draft ?? confirmed;
  const change = async (saved: Saved, next: T, write: (next: T) => unknown): Promise<boolean> => {
    setDraft(next);
    const landed = await saved.run(() => write(next));
    if (!landed) setDraft(null);
    return landed;
  };
  return { value, change };
}
