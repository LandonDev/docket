// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHeldKeys } from "../heldKeys";
import { attachKeyboardHold } from "./keyboardHold";
import { VideoInput } from "./videoInput";

const h = vi.hoisted(() => ({
  asks: [] as boolean[],
  /** what main answers: whether it holds the keyboard */
  holds: true,
  heldKey: null as ((key: "freed" | "closeWindow") => void) | null,
  full: null as ((state: { on: boolean; popOut: boolean }) => void) | null,
}));
// a Mac's keyboard: ⌘ is the Command key (lib/keys.ts `macCommand`)
vi.mock("../platform", () => ({ IS_MAC: true }));
vi.mock("../native", () => ({
  holdKeyboard: async (on: boolean) => (h.asks.push(on), on && h.holds),
  onHeldKey: (fn: (key: "freed" | "closeWindow") => void) => ((h.heldKey = fn), () => void (h.heldKey = null)),
  onWindowFullScreen: (fn: (state: { on: boolean; popOut: boolean }) => void) => ((h.full = fn), () => void (h.full = null)),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
// as main.tsx does, before any other key listener
installHeldKeys(window);

function setup() {
  const el = document.createElement("div");
  el.tabIndex = 0;
  document.body.append(el);
  const input = new VideoInput(() => undefined, { mac: true, paste: () => undefined, screen: "vm" });
  const leave = vi.fn();
  const undo = attachKeyboardHold(el, input, leave);
  return { el, input, leave, undo };
}

beforeEach(() => {
  h.asks.length = 0;
  h.holds = true;
});
afterEach(() => void document.body.replaceChildren());

describe("the page's half of the keyboard hold", () => {
  it("asks main as the picture takes the focus, and takes the full-screen map only once main holds it", async () => {
    const s = setup();
    s.el.focus();
    expect(s.input.fullScreen).toBe(false);
    await flush();
    expect(h.asks).toEqual([true]);
    expect(s.input.fullScreen).toBe(true);
    s.el.blur();
    expect(s.input.fullScreen).toBe(false);
    await flush();
    expect(h.asks).toEqual([true, false]);
    s.undo();
  });

  it("keeps the window's map when main does not hold it, and asks again once the window is full screen", async () => {
    h.holds = false;
    const s = setup();
    s.el.focus();
    await flush();
    expect(s.input.fullScreen).toBe(false);
    h.holds = true;
    h.full?.({ on: true, popOut: true });
    await flush();
    expect(s.input.fullScreen).toBe(false);
    h.full?.({ on: true, popOut: false });
    await flush();
    expect(s.input.fullScreen).toBe(true);
    s.undo();
  });

  it("leaves the picture when main lets go, and drops an answer that came after", async () => {
    const s = setup();
    s.el.focus();
    h.heldKey?.("freed");
    await flush();
    expect(s.leave).toHaveBeenCalledOnce();
    expect(s.input.fullScreen).toBe(false);
    s.undo();
  });

  it("sends Alt+F4 for main's ⌘Q", () => {
    const s = setup();
    const close = vi.spyOn(s.input, "closeWindow");
    h.heldKey?.("closeWindow");
    expect(close).toHaveBeenCalledOnce();
    s.undo();
  });

  it("lets go as it is undone: Hand back, a lost stream, full screen closed", async () => {
    const s = setup();
    s.el.focus();
    await flush();
    s.undo();
    expect(s.input.fullScreen).toBe(false);
    expect(h.asks.at(-1)).toBe(false);
    expect(h.heldKey).toBeNull();
    expect(h.full).toBeNull();
  });

  it("hears every key first while main holds it: the app's own capture listeners never see ⌘S", async () => {
    const sent: string[] = [];
    const el = document.createElement("div");
    el.tabIndex = 0;
    document.body.append(el);
    const input = new VideoInput((e) => void ("key" in e && sent.push(`${e.type === "keyDown" ? "+" : "-"}${e.key}`)), { mac: true, paste: () => undefined, screen: "vm" });
    // App.tsx's commands: a window capture listener that takes ⌘S for Save
    const app = vi.fn((e: KeyboardEvent) => void (e.metaKey && e.code === "KeyS" && e.preventDefault()));
    window.addEventListener("keydown", app, true);
    const undo = attachKeyboardHold(el, input, () => undefined);
    el.focus();
    await flush();
    const key = (type: string, code: string, metaKey: boolean) => el.dispatchEvent(new KeyboardEvent(type, { code, metaKey, bubbles: true, cancelable: true }));
    key("keydown", "MetaLeft", true);
    expect(key("keydown", "KeyS", true)).toBe(false);
    key("keyup", "MetaLeft", false);
    expect(app).not.toHaveBeenCalled();
    expect(sent).toEqual(["+224", "+22", "-22", "-224"]);
    // let go, the app hears its keys again
    undo();
    key("keydown", "KeyS", true);
    expect(app).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", app, true);
  });
});
