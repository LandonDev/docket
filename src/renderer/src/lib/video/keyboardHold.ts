import { holdKeys } from "../heldKeys";
import { holdKeyboard, onHeldKey, onWindowFullScreen } from "../native";
import { sendKey, type VideoInput } from "./videoInput";

/**
 * The keyboard in full screen, the page's half (main's keyboardHold.ts, docs/agents/live-video.md "Driving"): while
 * the picture he drives in full screen has the focus, it asks main to hold the keyboard, and the full-screen map
 * (`VideoInput.fullScreen`) is on only while main says it holds it. Main lets go on his way out (⌃⌥, ⌃⌘F) and on every
 * loss, and says so: the picture then leaves (`leave`). ⌘Q, which main keeps from the menu while it holds the
 * keyboard, comes back as `closeWindow`. Returns the undo, which lets go.
 */
export function attachKeyboardHold(el: HTMLElement, input: VideoInput, leave: () => void): () => void {
  let asked = 0;
  let unkeys: (() => void) | undefined;
  // while main holds it, every key is the picture's before any other listener's (lib/heldKeys.ts)
  const setFull = (on: boolean): void => {
    input.fullScreen = on;
    if (on) unkeys ??= holdKeys(el, (e) => sendKey(input, e));
    else {
      unkeys?.();
      unkeys = undefined;
    }
  };
  const ask = (on: boolean): void => {
    const mine = ++asked;
    if (!on) setFull(false);
    void holdKeyboard(on).then((held) => {
      // an answer to an older ask, or one the focus has moved past since, changes nothing
      if (mine === asked) setFull(on && held && el.ownerDocument.activeElement === el);
    });
  };
  const onFocus = (): void => ask(true);
  const onBlur = (): void => ask(false);
  const unheld = onHeldKey((key) => {
    if (key === "closeWindow") return input.closeWindow();
    asked++;
    setFull(false);
    leave();
  });
  // the window is full screen only a beat after the page asked (off a Mac, the system's transition): ask again then
  const unfull = onWindowFullScreen(({ on, popOut }) => {
    if (on && !popOut && !input.fullScreen && el.ownerDocument.activeElement === el) ask(true);
  });
  el.addEventListener("focus", onFocus);
  el.addEventListener("blur", onBlur);
  if (el.ownerDocument.activeElement === el) ask(true);
  return () => {
    el.removeEventListener("focus", onFocus);
    el.removeEventListener("blur", onBlur);
    unheld();
    unfull();
    ask(false);
  };
}
