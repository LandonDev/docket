import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("tells the caller a copy or a cut went to the Windows VM, whose clipboard is not his, and never for the box's browser", () => {
    let copies = 0;
    const vm = new VideoInput(() => undefined, { mac: false, paste: () => undefined, screen: "vm", copied: () => void copies++ });
    vm.keyDown({ code: "ControlLeft", ctrlKey: true });
    vm.keyDown({ code: "KeyC", ctrlKey: true });
    vm.keyDown({ code: "KeyC", ctrlKey: true, repeat: true });
    vm.keyDown({ code: "KeyX", ctrlKey: true });
    vm.keyDown({ code: "KeyA", ctrlKey: true });
    expect(copies).toBe(2);
    const mac = new VideoInput(() => undefined, { mac: true, paste: () => undefined, screen: "vm", copied: () => void copies++ });
    mac.keyDown({ code: "KeyC", command: true });
    expect(copies).toBe(3);
    const box = new VideoInput(() => undefined, { mac: false, paste: () => undefined, screen: "browser", copied: () => void copies++ });
    box.keyDown({ code: "KeyC", ctrlKey: true });
    expect(copies).toBe(3);
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

describe("the full-screen map", () => {
  /** A Mac in full screen on the Windows VM, main holding the keyboard. */
  function full(screen: DrivenScreen = "vm") {
    const r = rig(true, screen);
    r.input.fullScreen = true;
    return r;
  }
  const W = K.MetaLeft;
  const C = K.ControlLeft;

  it("leaves full screen on ⌃⌘F that reaches the picture, and never sends it to the guest (it reached Windows as Ctrl+F from his Mac)", () => {
    const sent: InputEvent[] = [];
    let leaves = 0;
    const input = new VideoInput((e) => sent.push(e), { mac: true, paste: () => undefined, screen: "vm", leaveFullScreen: () => void leaves++ });
    input.fullScreen = true;
    input.keyDown({ code: "ControlLeft", ctrlKey: true });
    input.keyDown({ code: "MetaLeft", command: true, ctrlKey: true });
    expect(input.keyDown({ code: "KeyF", command: true, ctrlKey: true })).toBe(true);
    expect(leaves).toBe(1);
    // nothing of F went down, and whatever was held was let go
    expect(sent.some((e) => "key" in e && e.key === K.KeyF)).toBe(false);
    expect(sent.at(-1)?.type).toBe("releaseAll");
  });

  it("makes ⌘ Ctrl for every letter: ⌘S, ⌘F, ⌘T and ⌘W reach Windows as Ctrl+S, Ctrl+F, Ctrl+T and Ctrl+W", () => {
    for (const code of ["KeyS", "KeyF", "KeyT", "KeyW", "KeyK", "KeyL"]) {
      const r = full();
      expect(r.input.keyDown({ code: "MetaLeft", command: true }), code).toBe(true);
      expect(r.input.keyDown({ code, command: true }), code).toBe(true);
      // held, the guest repeats it itself
      expect(r.input.keyDown({ code, command: true, repeat: true }), code).toBe(true);
      expect(r.input.keyUp({ code, command: true }), code).toBe(true);
      expect(r.input.keyUp({ code: "MetaLeft" }), code).toBe(true);
      expect(r.keys(), code).toEqual([`+${C}`, `+${K[code]}`, `-${K[code]}`, `-${C}`]);
      expect(r.sent[1].modifiers, code).toBe(1);
    }
  });

  it("keeps Ctrl down for as long as ⌘ is: two chords in one press", () => {
    const r = full();
    r.input.keyDown({ code: "MetaLeft", command: true });
    for (const code of ["KeyS", "KeyW"]) {
      r.input.keyDown({ code, command: true });
      r.input.keyUp({ code, command: true });
    }
    r.input.keyUp({ code: "MetaLeft" });
    expect(r.keys()).toEqual([`+${C}`, `+${K.KeyS}`, `-${K.KeyS}`, `+${K.KeyW}`, `-${K.KeyW}`, `-${C}`]);
  });

  it("sends the Windows key for ⌘ pressed alone and let go, and none once anything came between", () => {
    const r = full();
    r.input.keyDown({ code: "MetaLeft", command: true });
    r.input.keyDown({ code: "MetaLeft", command: true, repeat: true });
    r.input.keyUp({ code: "MetaLeft" });
    expect(r.keys()).toEqual([`+${W}`, `-${W}`]);
    expect(r.sent[0].modifiers).toBe(1 << 3);
    for (const between of [
      () => r.input.keyDown({ code: "ShiftLeft", command: true }),
      () => r.input.keyDown({ code: "ControlLeft", ctrlKey: true }),
      () => r.input.buttonDown(0, 0.5, 0.5),
      // a key main kept (the F of ⌃⌘F, the Q of ⌘Q) whose key-up still comes
      () => r.input.keyUp({ code: "KeyF" }),
    ]) {
      r.input.release();
      r.sent.length = 0;
      r.input.keyDown({ code: "MetaLeft", command: true });
      between();
      r.input.keyUp({ code: "MetaLeft" });
      expect(r.keys().filter((k) => k === `+${W}`)).toEqual([]);
    }
    // ⌘ pressed while Ctrl is down: ⌃⌘F's way
    r.input.release();
    r.sent.length = 0;
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    r.input.keyDown({ code: "MetaLeft", command: false, ctrlKey: true });
    r.input.keyUp({ code: "KeyF" });
    r.input.keyUp({ code: "MetaLeft" });
    expect(r.keys()).toEqual([`+${C}`]);
  });

  it("lets go of a letter sent under ⌘ itself: a Mac gives no key-up for it", () => {
    const r = full();
    r.input.keyDown({ code: "MetaLeft", command: true });
    r.input.keyDown({ code: "KeyF", command: true });
    // held, it repeats there; nothing more is sent
    r.input.keyDown({ code: "KeyF", command: true, repeat: true });
    r.input.keyUp({ code: "MetaLeft" });
    expect(r.keys()).toEqual([`+${C}`, `+${K.KeyF}`, `-${K.KeyF}`, `-${C}`]);
    // two chords under one ⌘, and the same letter twice: each goes up before the next comes down
    r.sent.length = 0;
    r.input.keyDown({ code: "MetaLeft", command: true });
    for (const code of ["KeyW", "KeyT", "KeyT"]) r.input.keyDown({ code, command: true });
    r.input.keyUp({ code: "MetaLeft" });
    expect(r.keys()).toEqual([`+${C}`, `+${K.KeyW}`, `-${K.KeyW}`, `+${K.KeyT}`, `-${K.KeyT}`, `+${K.KeyT}`, `-${K.KeyT}`, `-${C}`]);
    // ⌘Q after a letter: the letter goes up before Alt+F4
    r.sent.length = 0;
    r.input.keyDown({ code: "MetaLeft", command: true });
    r.input.keyDown({ code: "KeyS", command: true });
    r.input.closeWindow();
    expect(r.keys().slice(0, 3)).toEqual([`+${C}`, `+${K.KeyS}`, `-${K.KeyS}`]);
  });

  it("sends no Windows key for a ⌘ whose chord something else took", () => {
    for (const code of ["Tab", "Space", "KeyQ", "AudioVolumeUp", "IntlRo"]) {
      const r = full();
      r.input.keyDown({ code: "MetaLeft", command: true });
      r.input.keyDown({ code, command: true });
      r.input.keyUp({ code: "MetaLeft" });
      expect(r.keys(), code).toEqual([]);
    }
  });

  it("sends no Windows key for a ⌘ held when focus is lost", () => {
    const r = full();
    r.input.keyDown({ code: "MetaLeft", command: true });
    r.input.release();
    r.input.keyUp({ code: "MetaLeft" });
    expect(r.keys()).toEqual([]);
  });

  it("makes ⌘Q, which main hears, Alt+F4 on the Windows VM and nothing on the shared browser", () => {
    const r = full();
    r.input.keyDown({ code: "MetaLeft", command: true });
    // main keeps the Q itself: the page never sends it, and the menu's Quit runs where main does not hold the keyboard
    expect(r.input.keyDown({ code: "KeyQ", command: true })).toBe(false);
    r.input.closeWindow();
    r.input.keyUp({ code: "KeyQ" });
    r.input.keyUp({ code: "MetaLeft" });
    expect(r.keys()).toEqual([`+${K.AltLeft}`, `+${K.F4}`, `-${K.F4}`, `-${K.AltLeft}`]);
    expect(r.sent[1].modifiers).toBe(1 << 2);
    // after ⌘S in the same press, the Ctrl ⌘ stands for is let go first
    const s = full();
    s.input.keyDown({ code: "MetaLeft", command: true });
    s.input.keyDown({ code: "KeyS", command: true });
    s.input.keyUp({ code: "KeyS" });
    s.input.closeWindow();
    expect(s.keys()).toEqual([`+${C}`, `+${K.KeyS}`, `-${K.KeyS}`, `-${C}`, `+${K.AltLeft}`, `+${K.F4}`, `-${K.F4}`, `-${K.AltLeft}`]);
    const b = full("browser");
    b.input.closeWindow();
    expect(b.sent).toEqual([]);
  });

  it("leaves ⌘Tab and ⌘Space to the Mac", () => {
    const r = full();
    r.input.keyDown({ code: "MetaLeft", command: true });
    expect(r.input.keyDown({ code: "Tab", command: true })).toBe(false);
    expect(r.input.keyDown({ code: "Space", command: true })).toBe(false);
    r.input.keyUp({ code: "MetaLeft" });
    expect(r.sent).toEqual([]);
  });

  it("keeps ⌘V his clipboard's paste and ⌘C the copy out of the VM", () => {
    let copies = 0;
    let pastes = 0;
    const sent: InputEvent[] = [];
    const input = new VideoInput((e) => sent.push(e), { mac: true, paste: () => void pastes++, screen: "vm", copied: () => void copies++ });
    input.fullScreen = true;
    input.keyDown({ code: "MetaLeft", command: true });
    expect(input.keyDown({ code: "KeyV", command: true })).toBe(true);
    input.keyDown({ code: "KeyC", command: true });
    expect([pastes, copies]).toEqual([1, 1]);
    expect(sent.map((e) => ("key" in e ? e.key : e.type))).toEqual([C, K.KeyC]);
  });

  it("keeps the shared browser's never-sent chords from it in full screen too", () => {
    const r = full("browser");
    r.input.keyDown({ code: "MetaLeft", command: true });
    expect(r.input.keyDown({ code: "KeyW", command: true })).toBe(true);
    expect(r.keys()).toEqual([`+${C}`]);
  });

  it("never sends ⌃⌥ to the guest, still leaves on it, and sends the held-back key once another comes", () => {
    const r = full();
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    r.input.keyDown({ code: "AltLeft", ctrlKey: true });
    r.input.keyUp({ code: "AltLeft" });
    expect(r.left()).toBe(1);
    expect(r.keys()).toEqual([`+${C}`]);
    r.input.release();
    r.sent.length = 0;
    // Ctrl+Alt+Delete is still the guest's
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    r.input.keyDown({ code: "AltLeft", ctrlKey: true });
    r.input.keyDown({ code: "Delete", ctrlKey: true });
    r.input.keyUp({ code: "Delete" });
    r.input.keyUp({ code: "AltLeft" });
    r.input.keyUp({ code: "ControlLeft" });
    expect(r.keys()).toEqual([`+${C}`, `+${K.AltLeft}`, `+${K.Delete}`, `-${K.Delete}`, `-${K.AltLeft}`, `-${C}`]);
    expect(r.left()).toBe(1);
    // the first of the two let go first: Ctrl goes up there, and the held-back Alt never went down
    r.sent.length = 0;
    r.input.keyDown({ code: "AltLeft" });
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    r.input.keyUp({ code: "AltLeft" });
    expect(r.keys()).toEqual([`+${K.AltLeft}`, `-${K.AltLeft}`]);
    expect(r.left()).toBe(2);
  });

  it("leaves the window's map exactly as it was", () => {
    const r = rig(true, "vm");
    expect(r.input.keyDown({ code: "MetaLeft", command: true })).toBe(false);
    expect(r.input.keyDown({ code: "KeyS", command: true })).toBe(false);
    expect(r.input.keyUp({ code: "MetaLeft" })).toBe(false);
    r.input.keyDown({ code: "ControlLeft", ctrlKey: true });
    r.input.keyDown({ code: "AltLeft", ctrlKey: true });
    expect(r.keys()).toEqual([`+${C}`, `+${K.AltLeft}`]);
    // off a Mac full screen changes no ⌘: there is none
    const pc = rig(false, "vm");
    pc.input.fullScreen = true;
    expect(pc.input.keyDown({ code: "MetaLeft" })).toBe(true);
    pc.input.keyUp({ code: "MetaLeft" });
    expect(pc.sent).toEqual([]);
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

describe("pointer delivery", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
  afterEach(() => vi.useRealTimers());

  function picture(raw: boolean) {
    const r = rig();
    const el = Object.assign(new EventTarget(), {
      ownerDocument: { defaultView: new EventTarget() },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      focus: () => undefined,
      ...(raw ? { onpointerrawupdate: null } : {}),
    }) as unknown as HTMLElement;
    const detach = attachInput(el, r.input);
    const emit = (type: string, x: number, samples: number[] = []) =>
      el.dispatchEvent(Object.assign(new Event(type), {
        clientX: x, clientY: 50, button: 0, pointerId: 1,
        getCoalescedEvents: () => samples.map((clientX) => ({ clientX, clientY: 50 })),
      }));
    return { ...r, el, emit, detach };
  }

  it("uses the last coalesced point and sends each pending move before its button", () => {
    const r = picture(true);
    r.emit("pointerrawupdate", 5);
    r.emit("pointerrawupdate", 20, [10, 20]);
    r.emit("pointerdown", 20);
    r.emit("pointerrawupdate", 50, [30, 40]);
    r.emit("pointerup", 40);
    expect(r.keys()).toEqual(["pointerMove"]);
    vi.advanceTimersByTime(4);
    expect(r.sent.slice(1)).toMatchObject([{ type: "pointerMove", x: 0.2, buttons: 0 }, { type: "buttonDown", x: 0.2, buttons: 1 }]);
    vi.advanceTimersByTime(4);
    expect(r.sent.slice(3)).toMatchObject([{ type: "pointerMove", x: 0.4, buttons: 1 }, { type: "buttonUp", x: 0.4, buttons: 0 }]);
    r.detach();
  });

  it("sends at most 250 moves per second and sends the last position after the pointer stops", () => {
    const r = picture(true);
    r.emit("pointermove", 90);
    for (let i = 0; i < 1000; i++) {
      r.emit("pointerrawupdate", i === 999 ? 99 : 40);
      vi.advanceTimersByTime(1);
      if (i === 998) expect(r.sent).toHaveLength(250);
    }
    expect(r.sent).toHaveLength(251);
    expect(r.sent.at(-1)).toMatchObject({ type: "pointerMove", x: 0.99 });
    r.detach();
  });

  it("sends a key at once if only a move is waiting for the cap", () => {
    const r = picture(true);
    r.emit("pointerrawupdate", 5);
    r.emit("pointerrawupdate", 20);
    r.input.keyDown({ code: "ShiftLeft" });
    expect(r.keys()).toEqual(["pointerMove", "+225"]);
    vi.advanceTimersByTime(4);
    expect(r.sent.at(-1)).toMatchObject({ type: "pointerMove", x: 0.2, modifiers: 2 });
    r.detach();
  });

  it("falls back to pointermove when the element does not support raw input", () => {
    const r = picture(false);
    r.emit("pointerrawupdate", 90);
    r.emit("pointermove", 10);
    r.emit("pointermove", 20);
    expect(r.sent).toMatchObject([{ type: "pointerMove", x: 0.1 }, { type: "pointerMove", x: 0.2 }]);
    r.detach();
    r.emit("pointermove", 30);
    expect(r.sent).toHaveLength(2);
  });

  it("cancels an unsent press on blur so it cannot land after release-all", () => {
    const r = picture(true);
    r.emit("pointerrawupdate", 5);
    r.emit("pointerdown", 5);
    r.emit("pointerrawupdate", 20);
    r.emit("pointerup", 20);
    r.el.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(20);
    expect(r.keys()).toEqual(["pointerMove", "buttonDown", "releaseAll"]);
    r.detach();
  });
});
