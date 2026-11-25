/**
 * The keyboard held in full screen (lib/video/keyboardHold.ts, main's keyboardHold.ts): while a picture holds it with
 * main, every key goes to that picture first and to nothing else. The app's own key listeners sit on window capture
 * too (App.tsx's commands, a Work editor's save, a view's keys), so this one is registered before them all (main.tsx
 * installs it before App) and stops each key it hands over. A leaf: no import, so the first paint carries only this.
 */

type Take = (e: KeyboardEvent) => void;

let held: { el: EventTarget; take: Take } | null = null;

/** Hands every key aimed at `el` to `take` until the returned undo. */
export function holdKeys(el: EventTarget, take: Take): () => void {
  const mine = { el, take };
  held = mine;
  return () => {
    if (held === mine) held = null;
  };
}

export function onHeldKey(e: Event): void {
  if (!held || e.target !== held.el) return;
  e.stopImmediatePropagation();
  held.take(e as KeyboardEvent);
}

export function installHeldKeys(target: Pick<Window, "addEventListener"> = window): void {
  target.addEventListener("keydown", onHeldKey, true);
  target.addEventListener("keyup", onHeldKey, true);
}
