import { describe, expect, it } from "vitest";
import type { InputEvent } from "@server/shared/video/nsl1";
import { encodeInput, parseInput } from "@server/shared/video/nsl1";
import { HID_KEYS, VideoInput, attachInput, drivenScreen, type DrivenScreen } from "./videoInput";

function rig(mac = false, screen?: DrivenScreen) {
  const sent: InputEvent[] = [];
  let pastes = 0;
  let left = 0;
  const input = new VideoInput((e) => sent.push(e), { mac, paste: () => void pastes++, leave: () => void left++, ...(screen ? { screen } : {}) });
  const keys = () => sent.map((e) => ("key" in e ? `${e.type === "keyDown" ? "+" : "-"}${e.key}` : e.type));
  return { sent, input, keys, pastes: () => pastes, left: () => left };
}
const K = HID_KEYS;

describe("the key table", () => {
  it("names a key by its place on the keyboard, as the engine does", () => {
    expect([K.KeyA, K.KeyZ, K.Digit1, K.Digit0, K.Enter, K.Escape, K.Backspace, K.Tab, K.Space]).toEqual([4, 29, 30, 39, 40, 41, 42, 43, 44]);
    expect([K.ArrowRight, K.ArrowLeft, K.ArrowDown, K.ArrowUp, K.F1, K.F12, K.F13, K.Delete, K.NumpadEnter]).toEqual([79, 80, 81, 82, 58, 69, 104, 76, 88]);
    expect([K.ControlLeft, K.ShiftLeft, K.AltLeft, K.MetaLeft, K.ControlRight, K.ShiftRight, K.AltRight, K.MetaRight]).toEqual([224, 225, 226, 227, 228, 229, 230, 231]);
    // every record it makes is one the wire takes
    for (const code of Object.values(K)) expect(parseInput(encodeInput({ type: "keyDown", key: code }, 1))).toMatchObject({ type: "keyDown", key: code });
  });
});

describe("his keys", () => {
  it("sends a key down once and up once, with the modifiers held beside it", () => {
    const r = rig();
    expect(r.input.keyDown({ code: "ShiftLeft" })).toBe(true);
    expect(r.input.keyDown({ code: "KeyA" })).toBe(true);
    // the keyboard's own repeat is not his press: the far side repeats a held key itself
    expect(r.input.keyDown({ code: "KeyA", repeat: true })).toBe(true);
    expect(r.input.keyUp({ code: "KeyA" })).toBe(true);
    expect(r.input.keyUp({ code: "ShiftLeft" })).toBe(true);
    expect(r.keys()).toEqual(["+225", "+4", "-4", "-225"]);
    expect(r.sent.map((e) => e.modifiers)).toEqual([2, 2, 2, 0]);
    // a key this table does not know is not the picture's
    expect(r.input.keyDown({ code: "AudioVolumeUp" })).toBe(false);
    // a key that never went down there has nothing to let go
    expect(r.input.keyUp({ code: "KeyB" })).toBe(false);
    expect(r.sent).toHaveLength(4);
  });

  it("on a Mac sends copy, cut, select all and undo as the Ctrl chords, and leaves every other ⌘ chord to the app", () => {
    const r = rig(true);
    // ⌘ itself is the app's: the far side never sees a Super key
    expect(r.input.keyDown({ code: "MetaLeft", command: true })).toBe(false);
    for (const code of ["KeyC", "KeyX", "KeyA", "KeyZ"]) {
      r.sent.length = 0;
      expect(r.input.keyDown({ code, command: true }), code).toBe(true);
      expect(r.keys(), code).toEqual(["+224", `+${K[code]}`, `-${K[code]}`, "-224"]);
      // its letter's key-up finds nothing held
      expect(r.input.keyUp({ code, command: true })).toBe(false);
    }
    r.sent.length = 0;
    for (const code of ["KeyW", "KeyK", "KeyN", "KeyT", "KeyQ", "KeyL", "Comma", "Digit1"]) expect(r.input.keyDown({ code, command: true }), code).toBe(false);
    expect(r.sent).toEqual([]);
    // redo: Shift is held there already when ⌘Z comes
    r.input.keyDown({ code: "ShiftLeft" });
    r.input.keyDown({ code: "KeyZ", command: true });
    expect(r.keys()).toEqual(["+225", "+224", "+29", "-29", "-224"]);
    // the physical Control key is Ctrl there
    r.sent.length = 0;
    r.input.keyUp({ code: "ShiftLeft" });
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    r.input.keyDown({ code: "KeyL", ctrlKey: true });
    expect(r.keys()).toEqual(["-225", "+224", "+15"]);
  });

  it("hands a paste to the host and types none of it, on a Mac and elsewhere", () => {
    const mac = rig(true);
    expect(mac.input.keyDown({ code: "KeyV", command: true })).toBe(true);
    expect(mac.input.keyDown({ code: "KeyV", command: true, repeat: true })).toBe(true);
    expect(mac.pastes()).toBe(1);
    expect(mac.sent).toEqual([]);
    const pc = rig(false);
    pc.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    expect(pc.input.keyDown({ code: "KeyV", ctrlKey: true })).toBe(true);
    expect(pc.pastes()).toBe(1);
    expect(pc.keys()).toEqual(["+224"]);
    // a plain V is a V
    pc.input.keyUp({ code: "ControlLeft" });
    pc.input.keyDown({ code: "KeyV" });
    expect(pc.keys().at(-1)).toBe("+25");
  });

  it("never sends the chords that would close, quit or leave the shared browser, and swallows them", () => {
    const r = rig(false);
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    r.sent.length = 0;
    for (const code of ["KeyW", "KeyQ", "KeyN", "KeyT"]) expect(r.input.keyDown({ code, ctrlKey: true }), code).toBe(true);
    expect(r.input.keyDown({ code: "KeyI", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(r.sent).toEqual([]);
    // Ctrl+I alone is the page's (italic), and so is a plain W
    expect(r.input.keyDown({ code: "KeyI", ctrlKey: true })).toBe(true);
    expect(r.keys()).toEqual(["+12"]);
    r.input.keyUp({ code: "KeyI" });
    r.input.keyUp({ code: "ControlLeft" });
    r.sent.length = 0;
    r.input.keyDown({ code: "KeyW" });
    expect(r.keys()).toEqual(["+26"]);
    // the Windows key is neither the page's nor sent
    expect(r.input.keyDown({ code: "MetaLeft" })).toBe(true);
    expect(r.keys()).toEqual(["+26"]);
  });

  it("sends the Windows VM every chord, Ctrl+W, T, N, Q and Ctrl+Shift+I included: the guest is his", () => {
    expect(drivenScreen("vm:windows")).toBe("vm");
    expect(drivenScreen("browser:t1")).toBe("browser");
    const r = rig(false, "vm");
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    for (const code of ["KeyW", "KeyQ", "KeyN", "KeyT"]) {
      expect(r.input.keyDown({ code, ctrlKey: true }), code).toBe(true);
      r.input.keyUp({ code, ctrlKey: true });
    }
    r.input.keyDown({ code: "ShiftLeft", ctrlKey: true, shiftKey: true });
    r.input.keyDown({ code: "KeyI", ctrlKey: true, shiftKey: true });
    expect(r.keys()).toEqual(["+224", "+26", "-26", "+20", "-20", "+17", "-17", "+23", "-23", "+225", "+12"]);
    // on a Mac ⌘ never crosses, and ⌘C goes as Ctrl+C, as on the browser
    const m = rig(true, "vm");
    expect(m.input.keyDown({ code: "MetaLeft", command: true })).toBe(false);
    expect(m.input.keyDown({ code: "KeyC", command: true })).toBe(true);
    expect(m.keys()).toEqual(["+224", "+6", "-6", "-224"]);
  });

  it("presses the far Caps Lock only when it differs from his", () => {
    const r = rig();
    r.input.keyDown({ code: "KeyA", capsLock: false });
    r.input.keyUp({ code: "KeyA", capsLock: false });
    expect(r.keys()).toEqual(["+4", "-4"]);
    r.sent.length = 0;
    // he turned it on
    r.input.keyDown({ code: "CapsLock", capsLock: true });
    r.input.keyUp({ code: "CapsLock", capsLock: true });
    expect(r.keys()).toEqual(["+57", "-57"]);
    r.input.keyDown({ code: "KeyB", capsLock: true });
    expect(r.keys()).toEqual(["+57", "-57", "+5"]);
  });
});

describe("his pointer", () => {
  it("is sent as shares of the picture, held to its edges, with the buttons held beside it", () => {
    const r = rig();
    r.input.pointerMove(0.25, 0.5);
    r.input.pointerMove(-0.2, 1.4);
    expect(r.input.buttonDown(0, 0.5, 0.5)).toBe(true);
    expect(r.input.pressing).toBe(true);
    r.input.pointerMove(0.6, 0.5);
    expect(r.input.buttonUp(0, 0.6, 0.5)).toBe(true);
    expect(r.input.pressing).toBe(false);
    expect(r.sent).toEqual([
      { type: "pointerMove", x: 0.25, y: 0.5, buttons: 0, modifiers: 0 },
      { type: "pointerMove", x: 0, y: 1, buttons: 0, modifiers: 0 },
      { type: "buttonDown", button: 1, x: 0.5, y: 0.5, buttons: 1, modifiers: 0 },
      { type: "pointerMove", x: 0.6, y: 0.5, buttons: 1, modifiers: 0 },
      { type: "buttonUp", button: 1, x: 0.6, y: 0.5, buttons: 0, modifiers: 0 },
    ]);
    // the middle and the right button, and no fourth
    r.sent.length = 0;
    r.input.buttonDown(1, 0, 0);
    r.input.buttonDown(2, 0, 0);
    expect(r.input.buttonDown(3, 0, 0)).toBe(false);
    expect(r.sent.map((e) => ("button" in e ? e.button : null))).toEqual([2, 3]);
    for (const e of r.sent) expect(() => encodeInput(e, 1)).not.toThrow();
  });

  it("turns the wheel in whole notches, keeping what is left of one for the next", () => {
    const r = rig();
    // a trackpad's small steps: nothing until a notch is whole
    for (let i = 0; i < 3; i++) r.input.wheel({ deltaX: 0, deltaY: 40, deltaMode: 0 }, 0.5, 0.5);
    expect(r.sent).toEqual([{ type: "wheel", axis: "vertical", delta: 120, x: 0.5, y: 0.5, buttons: 0, modifiers: 0 }]);
    // the browser's own count of notches wins over pixels
    r.sent.length = 0;
    r.input.wheel({ deltaX: 0, deltaY: 4, deltaMode: 0, wheelDeltaY: -240 }, 0.5, 0.5);
    expect(r.sent.map((e) => ("delta" in e ? e.delta : 0))).toEqual([240]);
    // lines, the other way, sideways
    r.sent.length = 0;
    r.input.wheel({ deltaX: -3, deltaY: 0, deltaMode: 1 }, 0.5, 0.5);
    expect(r.sent[0]).toMatchObject({ axis: "horizontal", delta: -120 });
    // a turn back drops what was left the other way; one event is twelve hundred at most
    r.sent.length = 0;
    r.input.wheel({ deltaX: 0, deltaY: 60, deltaMode: 0 }, 0.5, 0.5);
    r.input.wheel({ deltaX: 0, deltaY: -5000, deltaMode: 0 }, 0.5, 0.5);
    expect(r.sent.map((e) => ("delta" in e ? e.delta : 0))).toEqual([-1200]);
  });
});

describe("letting go", () => {
  it("lets go of everything he holds at once, and says nothing when he holds nothing", () => {
    const r = rig();
    r.input.release();
    expect(r.sent).toEqual([]);
    r.input.keyDown({ code: "ShiftLeft" });
    r.input.buttonDown(0, 0.5, 0.5);
    r.sent.length = 0;
    r.input.release();
    expect(r.sent).toEqual([{ type: "releaseAll" }]);
    expect(r.input.pressing).toBe(false);
    // the keys are his to press again, with no modifier left over
    r.input.keyDown({ code: "KeyA" });
    expect(r.sent.at(-1)).toEqual({ type: "keyDown", key: 4, buttons: 0, modifiers: 0 });
    r.input.release();
    r.input.release();
    expect(r.sent.filter((e) => e.type === "releaseAll")).toHaveLength(2);
  });
});

describe("leaving the picture", () => {
  it("leaves on Ctrl+Alt pressed alone, when one of the two is let go, and still sends both to the page", () => {
    const r = rig();
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    r.input.keyDown({ code: "AltLeft", ctrlKey: true });
    expect(r.left()).toBe(0);
    // the keyboard's own repeat of a held modifier is no other key
    r.input.keyDown({ code: "AltLeft", ctrlKey: true, repeat: true });
    r.input.keyUp({ code: "AltLeft" });
    expect(r.left()).toBe(1);
    expect(r.keys()).toEqual(["+224", "+226", "-226"]);
    // the other of the two coming up is not a second leave
    r.input.keyUp({ code: "ControlLeft" });
    expect(r.left()).toBe(1);
  });

  it("does not leave when another key or a button came between: Ctrl+Alt+Delete and a Ctrl+Alt click are the page's", () => {
    const r = rig();
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    r.input.keyDown({ code: "AltLeft", ctrlKey: true });
    r.input.keyDown({ code: "Delete", ctrlKey: true });
    r.input.keyUp({ code: "Delete" });
    r.input.keyUp({ code: "AltLeft" });
    r.input.keyUp({ code: "ControlLeft" });
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    r.input.keyDown({ code: "AltLeft", ctrlKey: true });
    r.input.buttonDown(0, 0.5, 0.5);
    r.input.buttonUp(0, 0.5, 0.5);
    r.input.keyUp({ code: "AltLeft" });
    r.input.keyUp({ code: "ControlLeft" });
    // Shift beside them is another chord, and one of the two alone is no chord
    r.input.keyDown({ code: "ShiftLeft" });
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    r.input.keyDown({ code: "AltLeft", ctrlKey: true });
    r.input.keyUp({ code: "AltLeft" });
    r.input.release();
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    r.input.keyUp({ code: "ControlLeft" });
    expect(r.left()).toBe(0);
  });

  it("takes either Alt on a Mac, and only the left one elsewhere: the right one is AltGr, which arrives as Ctrl with Alt", () => {
    const pc = rig();
    pc.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    pc.input.keyDown({ code: "AltRight", ctrlKey: true });
    pc.input.keyUp({ code: "AltRight" });
    expect(pc.left()).toBe(0);
    const mac = rig(true);
    mac.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    mac.input.keyDown({ code: "AltRight", ctrlKey: true });
    mac.input.keyUp({ code: "ControlLeft" });
    expect(mac.left()).toBe(1);
  });
});

describe("the window the picture is in", () => {
  it("lets go of every key he holds when that window loses focus, the pop-out's own and not the main window's", () => {
    const r = rig();
    const view = new EventTarget();
    const el = Object.assign(new EventTarget(), { ownerDocument: { defaultView: view }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }) as unknown as HTMLElement;
    const detach = attachInput(el, r.input);
    r.input.keyDown({ code: "KeyA" });
    expect(r.keys()).toEqual(["+4"]);
    view.dispatchEvent(new Event("blur"));
    // the far side lets go of everything at once
    expect(r.keys()).toEqual(["+4", "releaseAll"]);
    detach();
  });
});
