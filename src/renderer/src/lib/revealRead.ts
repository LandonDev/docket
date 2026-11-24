/** Covers the five-second prepare round trip and the three-second saver check. */
export const REVEAL_READ_LIMIT_MS = 10_000;

type Hold = { phase: "prepared" | "opening" | "shown"; timer?: ReturnType<typeof setTimeout> };
const holds = new Map<string, Hold>();
const listeners = new Set<() => void>();
let inputTarget: EventTarget | null = null;

export const mayMarkRevealRead = (): boolean => holds.size === 0;

export function onRevealReadChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

function resumed(): void {
  inputTarget?.removeEventListener("pointerdown", localInput, true);
  inputTarget?.removeEventListener("keydown", localInput, true);
  inputTarget = null;
  changed();
}

function localInput(event: Event): void {
  if (!event.isTrusted || [...holds.values()].some((hold) => hold.phase !== "shown")) return;
  holds.clear();
  resumed();
}

/** Lift only this request's hold. Late replies cannot release another reveal. */
function release(token: string): void {
  const hold = holds.get(token);
  if (!hold) return;
  clearTimeout(hold.timer);
  holds.delete(token);
  if (mayMarkRevealRead()) resumed();
}

function holdReads(window: EventTarget, token: string, phase: "prepared" | "opening"): Hold {
  const first = mayMarkRevealRead();
  clearTimeout(holds.get(token)?.timer);
  const hold: Hold = { phase, timer: setTimeout(() => release(token), REVEAL_READ_LIMIT_MS) };
  holds.set(token, hold);
  if (first) {
    inputTarget = window;
    window.addEventListener("pointerdown", localInput, true);
    window.addEventListener("keydown", localInput, true);
    changed();
  }
  return hold;
}

export function prepareRevealReads(window: EventTarget, token: string): void {
  if (!holds.has(token)) holdReads(window, token, "prepared");
}

export function cancelRevealReads(token: string): void {
  if (holds.get(token)?.phase === "prepared") release(token);
}

/** Completed navigation waits for local input. A stalled opener releases itself. */
export function beginRevealNavigation(window: EventTarget, token: string): (opened?: boolean) => void {
  const hold = holdReads(window, token, "opening");
  return (opened = true) => {
    if (holds.get(token) !== hold || hold.phase !== "opening") return;
    if (!opened) return release(token);
    clearTimeout(hold.timer);
    hold.phase = "shown";
  };
}
