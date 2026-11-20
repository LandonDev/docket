import type { InputEvent } from "@server/shared/video/nsl1";
import { macCommand } from "../keys";

/**
 * His pointer and keys, as the input records a `drive` stream takes
 * (docs/agents/live-video.md "Driving"). The picture he drives is the box's
 * browser on a Linux display, so a key is sent as the place it has on the
 * keyboard (its HID usage code), never as the character it types here.
 *
 * The key table, the wheel's notches and the modifier bookkeeping are ported
 * from screen-relay 0.1.2 (github.com/vercel-labs/screen-relay,
 * `src/protocol/index.ts` `HID_KEYS` and `viewer/main.ts`), licensed under
 * the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
 * Changed here: the rules are a class with no DOM in it; on a Mac only five
 * ⌘ chords cross, as their Ctrl chords, and every other ⌘ chord stays the
 * app's; a paste is handed to the host, never typed; the chords that would
 * close or quit the shared browser are never sent; and Ctrl+Alt pressed with
 * nothing else is his way out of the picture, since Tab and Escape are the
 * page's while it holds the keyboard.
 */

/** `KeyboardEvent.code` to HID usage code. */
export const HID_KEYS: Readonly<Record<string, number>> = (() => {
  const keys: Record<string, number> = {};
  const assign = (first: number, names: string[]): void => names.forEach((name, i) => (keys[name] = first + i));
  assign(4, Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`));
  assign(30, "Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0".split(" "));
  assign(40, "Enter Escape Backspace Tab Space Minus Equal BracketLeft BracketRight Backslash".split(" "));
  assign(51, "Semicolon Quote Backquote Comma Period Slash CapsLock".split(" "));
  assign(58, Array.from({ length: 12 }, (_, i) => `F${i + 1}`));
  assign(70, "PrintScreen ScrollLock Pause Insert Home PageUp Delete End PageDown ArrowRight ArrowLeft ArrowDown ArrowUp NumLock".split(" "));
  assign(84, "NumpadDivide NumpadMultiply NumpadSubtract NumpadAdd NumpadEnter Numpad1 Numpad2 Numpad3 Numpad4 Numpad5 Numpad6 Numpad7 Numpad8 Numpad9 Numpad0 NumpadDecimal".split(" "));
  keys.IntlBackslash = 100;
  keys.ContextMenu = 101;
  assign(104, Array.from({ length: 12 }, (_, i) => `F${i + 13}`));
  assign(224, "ControlLeft ShiftLeft AltLeft MetaLeft ControlRight ShiftRight AltRight MetaRight".split(" "));
  return Object.freeze(keys);
})();

const CONTROL = 224;
const SHIFT_BITS = (1 << 1) | (1 << 5);
const CONTROL_BITS = (1 << 0) | (1 << 4);
const ALT_LEFT_BIT = 1 << 2;
const ALT_BITS = ALT_LEFT_BIT | (1 << 6);
const isModifier = (code: number): boolean => code >= 224 && code <= 231;
const isMeta = (code: number): boolean => code === 227 || code === 231;

/** On a Mac these ⌘ chords go to the page as the Ctrl chords; ⌘V is the paste. Every other ⌘ chord stays the app's. */
export const MAC_CHORDS: ReadonlySet<string> = new Set(["KeyC", "KeyX", "KeyA", "KeyZ"]);
/** With Ctrl held these would close, quit or leave the shared browser: Ctrl+W, Ctrl+Q, Ctrl+N, Ctrl+T, and Ctrl+Shift+I. They are never sent. */
export const NEVER_SENT: ReadonlySet<string> = new Set(["KeyW", "KeyQ", "KeyN", "KeyT"]);
/** Held together and let go with no other key or button between: the keyboard goes back to the app (`leave`). The way a VM's window lets go. */
export const LEAVE_CHORD = "ctrl+alt";

/** What a key event says of itself: enough of `KeyboardEvent` to decide. */
export interface KeyLike {
  code: string;
  repeat?: boolean;
  /** the Mac's Command key is held (`macCommand`); never true elsewhere */
  command?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  /** `getModifierState("CapsLock")` */
  capsLock?: boolean;
}

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  wheelDeltaX?: number;
  wheelDeltaY?: number;
}

const WHEEL_LINES_PER_NOTCH = 3;
const WHEEL_PIXELS_PER_NOTCH = 100;

/** Wheel notches in one event: Blink reports 120 a notch in `wheelDelta` whatever a notch is in pixels on the platform, so that wins. */
function wheelNotches(e: WheelLike, axis: 0 | 1): number {
  const legacy = axis ? e.wheelDeltaX : e.wheelDeltaY;
  if (typeof legacy === "number" && legacy !== 0) return -legacy / 120;
  const delta = axis ? e.deltaX : e.deltaY;
  if (e.deltaMode === 1) return delta / WHEEL_LINES_PER_NOTCH;
  if (e.deltaMode === 2) return delta;
  return delta / WHEEL_PIXELS_PER_NOTCH;
}

const share = (v: number): number => Math.min(1, Math.max(0, v));

export class VideoInput {
  private readonly held = new Set<number>();
  private modifiers = 0;
  private buttons = 0;
  private remoteCaps = false;
  private readonly wheelRemainder = [0, 0];
  /** Ctrl and Alt are down and nothing else has been pressed since: letting one go leaves the picture */
  private leaving = false;

  constructor(
    private readonly send: (event: InputEvent) => void,
    private readonly opts: { mac: boolean; paste: () => void; leave?: () => void },
  ) {}

  private emit(event: InputEvent): void {
    this.send({ ...event, buttons: this.buttons, modifiers: this.modifiers });
  }

  private setModifier(code: number, down: boolean): void {
    if (!isModifier(code)) return;
    const bit = 1 << (code - 224);
    this.modifiers = down ? this.modifiers | bit : this.modifiers & ~bit;
  }

  private tap(code: number): void {
    this.emit({ type: "keyDown", key: code });
    this.emit({ type: "keyUp", key: code });
  }

  /** Ctrl and Alt held, and no other key. Off a Mac only the left Alt counts: the right one is AltGr, which some keyboards send as Ctrl with Alt. */
  private chordAlone(): boolean {
    const alt = this.opts.mac ? ALT_BITS : ALT_LEFT_BIT;
    return (this.modifiers & CONTROL_BITS) !== 0 && (this.modifiers & alt) !== 0 && (this.modifiers & ~(CONTROL_BITS | alt)) === 0 && [...this.held].every(isModifier);
  }

  /** The far Caps Lock follows his: the key is a toggle there too, so it is pressed only when the two differ. */
  private syncCaps(e: KeyLike): void {
    if (e.capsLock === undefined || e.capsLock === this.remoteCaps) return;
    this.tap(HID_KEYS.CapsLock);
    this.remoteCaps = e.capsLock;
  }

  /** A key went down. True when it is the picture's: the caller stops it there, so the app does nothing with it. */
  keyDown(e: KeyLike): boolean {
    const code = HID_KEYS[e.code];
    const leaving = this.leaving;
    this.leaving = false;
    if (!code) return false;
    if (isMeta(code)) return this.opts.mac ? false : true;
    const command = this.opts.mac && !!e.command;
    const control = !!e.ctrlKey || (this.modifiers & CONTROL_BITS) !== 0;
    // the paste is his clipboard's text, handed to the host: the far clipboard has none of it to paste
    if (e.code === "KeyV" && (command || control)) {
      if (!e.repeat) this.opts.paste();
      return true;
    }
    if (command) {
      // every other ⌘ chord is the app's
      if (!MAC_CHORDS.has(e.code)) return false;
      if (!e.repeat) {
        this.setModifier(CONTROL, true);
        this.emit({ type: "keyDown", key: CONTROL });
        this.tap(code);
        this.setModifier(CONTROL, false);
        this.emit({ type: "keyUp", key: CONTROL });
      }
      return true;
    }
    if (control && (NEVER_SENT.has(e.code) || (e.code === "KeyI" && ((this.modifiers & SHIFT_BITS) !== 0 || !!e.shiftKey)))) return true;
    this.syncCaps(e);
    if (e.code === "CapsLock") return true;
    if (e.repeat || this.held.has(code)) {
      // a held modifier repeating is no other key
      this.leaving = leaving && isModifier(code);
      return true;
    }
    this.held.add(code);
    this.setModifier(code, true);
    this.emit({ type: "keyDown", key: code });
    this.leaving = isModifier(code) && this.chordAlone();
    return true;
  }

  keyUp(e: KeyLike): boolean {
    const code = HID_KEYS[e.code];
    if (!code) return false;
    if (isMeta(code)) return !this.opts.mac;
    if (e.code === "CapsLock") {
      this.syncCaps(e);
      return true;
    }
    // a key that never went down there (a chord's letter, one never sent) has nothing to let go
    if (!this.held.delete(code)) return false;
    this.setModifier(code, false);
    this.emit({ type: "keyUp", key: code });
    if (this.leaving) {
      this.leaving = false;
      this.opts.leave?.();
    }
    return true;
  }

  /** The pointer, as shares of the picture. */
  pointerMove(x: number, y: number): void {
    this.emit({ type: "pointerMove", x: share(x), y: share(y) });
  }

  /** `button` is the DOM's: 0 left, 1 middle, 2 right. False for any other. */
  buttonDown(button: number, x: number, y: number): boolean {
    if (button < 0 || button > 2) return false;
    this.leaving = false;
    this.buttons |= 1 << button;
    this.emit({ type: "buttonDown", button: (button + 1) as 1 | 2 | 3, x: share(x), y: share(y) });
    return true;
  }

  buttonUp(button: number, x: number, y: number): boolean {
    if (button < 0 || button > 2) return false;
    this.buttons &= ~(1 << button);
    this.emit({ type: "buttonUp", button: (button + 1) as 1 | 2 | 3, x: share(x), y: share(y) });
    return true;
  }

  /** Any button is down: the pointer is the picture's until it is let go. */
  get pressing(): boolean {
    return this.buttons !== 0;
  }

  wheel(e: WheelLike, x: number, y: number): void {
    for (const axis of [0, 1] as const) {
      if (!(axis ? e.deltaX : e.deltaY)) continue;
      const notches = wheelNotches(e, axis);
      if (Math.sign(notches) !== Math.sign(this.wheelRemainder[axis])) this.wheelRemainder[axis] = 0;
      this.wheelRemainder[axis] += notches;
      const whole = Math.trunc(this.wheelRemainder[axis]);
      if (!whole) continue;
      this.wheelRemainder[axis] -= whole;
      this.emit({ type: "wheel", axis: axis ? "horizontal" : "vertical", delta: Math.min(1200, Math.max(-1200, whole * 120)), x: share(x), y: share(y) });
    }
  }

  /** Everything he holds is let go there: the picture lost the keyboard, the window lost focus, the pointer was taken away. */
  release(): void {
    const had = this.held.size > 0 || this.buttons !== 0 || this.modifiers !== 0;
    this.held.clear();
    this.leaving = false;
    this.buttons = 0;
    this.modifiers = 0;
    this.wheelRemainder[0] = this.wheelRemainder[1] = 0;
    if (had) this.send({ type: "releaseAll" });
  }
}

/**
 * Binds a picture's element to a `VideoInput`: its pointer, wheel and keys
 * while it has the keyboard. Returns the undo, which lets go of everything.
 */
export function attachInput(el: HTMLElement, input: VideoInput): () => void {
  const at = (e: MouseEvent): [number, number] => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] : [0, 0];
  };
  const key = (e: KeyboardEvent): KeyLike => ({ code: e.code, repeat: e.repeat, command: macCommand(e), ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, capsLock: e.getModifierState?.("CapsLock") });
  const stop = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onKeyDown = (e: KeyboardEvent): void => void (input.keyDown(key(e)) && stop(e));
  const onKeyUp = (e: KeyboardEvent): void => void (input.keyUp(key(e)) && stop(e));
  const onMove = (e: PointerEvent): void => input.pointerMove(...at(e));
  const onDown = (e: PointerEvent): void => {
    if (!input.buttonDown(e.button, ...at(e))) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    el.setPointerCapture?.(e.pointerId);
  };
  const onUp = (e: PointerEvent): void => {
    if (!input.buttonUp(e.button, ...at(e))) return;
    e.preventDefault();
    if (!input.pressing && el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    input.wheel(e as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number }, ...at(e));
  };
  const release = (): void => input.release();
  const onLost = (): void => void (input.pressing && input.release());
  const onMenu = (e: Event): void => e.preventDefault();
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("keyup", onKeyUp);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", release);
  el.addEventListener("lostpointercapture", onLost);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("contextmenu", onMenu);
  el.addEventListener("blur", release);
  // the window the picture is in, which is the pop-out's own for a picture there: when it loses focus, what he holds is let go
  const view = el.ownerDocument.defaultView ?? window;
  view.addEventListener("blur", release);
  return () => {
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("keyup", onKeyUp);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", release);
    el.removeEventListener("lostpointercapture", onLost);
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("contextmenu", onMenu);
    el.removeEventListener("blur", release);
    view.removeEventListener("blur", release);
    input.release();
  };
}
