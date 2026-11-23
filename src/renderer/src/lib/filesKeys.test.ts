import { afterEach, describe, expect, it, vi } from "vitest";

// The platform the window runs on, switched per case (lib/keys.ts reads it at each call).
let mac = true;
vi.mock("./platform", () => ({
  get IS_MAC() {
    return mac;
  },
}));
import { FILES_KEYS, FILES_VIEW, filesChord } from "../work/files/chords";
import { filesPort, type FilesCommand } from "./filesKeys";
import { tabCommand } from "./tabKeys";

type Mods = Partial<Record<"mod" | "ctrl" | "alt" | "shift", boolean>>;

/** A keydown as the platform's keyboard sends it: `mod` is ⌘ on a Mac and Ctrl elsewhere. */
function key(k: string, mods: Mods = {}, code = k.length === 1 ? `Key${k.toUpperCase()}` : k): KeyboardEvent {
  return {
    key: k,
    code,
    metaKey: !!mods.mod && mac,
    ctrlKey: !!mods.ctrl || (!!mods.mod && !mac),
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    isComposing: false,
    repeat: false,
    target: null,
  } as unknown as KeyboardEvent;
}

const CHORDS: [string, () => KeyboardEvent, FilesCommand][] = [
  ["mod+T", () => key("t", { mod: true }), "new-tab"],
  ["mod+W", () => key("w", { mod: true }), "close-tab"],
  ["mod+[", () => key("[", { mod: true }, "BracketLeft"), "back"],
  ["mod+]", () => key("]", { mod: true }, "BracketRight"), "forward"],
  ["Ctrl+Tab", () => key("Tab", { ctrl: true }), "next-tab"],
  ["Ctrl+Shift+Tab", () => key("Tab", { ctrl: true, shift: true }), "prev-tab"],
  ["mod+Shift+]", () => key("}", { mod: true, shift: true }, "BracketRight"), "next-tab"],
  ["mod+Shift+[", () => key("{", { mod: true, shift: true }, "BracketLeft"), "prev-tab"],
];

afterEach(() => {
  mac = true;
  filesPort.set(null);
});

describe.each([
  ["on a Mac", true],
  ["on Windows and Linux", false],
])("filesChord %s", (_name, onMac) => {
  it.each(CHORDS)("%s is %s", (_chord, make, command) => {
    mac = onMac;
    expect(filesChord(make())).toBe(command);
  });

  it("reads the same physical chords tabKeys reads for the thread tabs", () => {
    mac = onMac;
    const same: Record<FilesCommand, unknown> = {
      "new-tab": null,
      "close-tab": "close",
      "next-tab": "next",
      "prev-tab": "prev",
      back: "back",
      forward: "forward",
    };
    for (const [, make, command] of CHORDS) expect(tabCommand(make())).toBe(same[command]);
  });

  it("reads the Files place's own chords: the tab last closed, Go to and Search", () => {
    mac = onMac;
    expect(filesChord(key("t", { mod: true, shift: true }))).toBe("reopen-tab");
    expect(filesChord(key("p", { mod: true }))).toBe("go-to");
    expect(filesChord(key("f", { mod: true }))).toBe("search");
  });

  it("leaves near misses and the app's other chords alone", () => {
    mac = onMac;
    expect(filesChord(key("t", { mod: true, shift: true, alt: true }))).toBeNull();
    expect(filesChord(key("w", { mod: true, alt: true }))).toBeNull();
    expect(filesChord(key("Tab"))).toBeNull();
    expect(filesChord(key("Tab", { shift: true }))).toBeNull();
    expect(filesChord(key("Tab", { ctrl: true, alt: true }))).toBeNull();
    expect(filesChord(key("1", { mod: true }, "Digit1"))).toBeNull();
    expect(filesChord(key("n", { mod: true }))).toBeNull();
    expect(filesChord(key("k", { mod: true }))).toBeNull();
    expect(filesChord(key("t"))).toBeNull();
    expect(filesChord({ ...key("t", { mod: true }), isComposing: true } as KeyboardEvent)).toBeNull();
  });
});

describe("filesPort", () => {
  it("runs the mounted view's handler and says whether one took the command", () => {
    expect(filesPort.mounted()).toBe(false);
    expect(filesPort.run("new-tab")).toBe(false);
    const run = vi.fn();
    filesPort.set(run);
    expect(filesPort.mounted()).toBe(true);
    expect(filesPort.run("close-tab")).toBe(true);
    expect(run).toHaveBeenCalledWith("close-tab");
    filesPort.set(null);
    expect(filesPort.mounted()).toBe(false);
    expect(filesPort.run("back")).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("whose focus it is", () => {
  const inside = (...selectors: string[]) => ({
    closest: (selector: string) => (selectors.some((s) => selector.includes(s)) ? {} : null),
  }) as unknown as EventTarget;

  it("holds inside a mounted Files view only", () => {
    expect(filesPort.owns(inside(FILES_VIEW))).toBe(false);
    filesPort.set(() => {}, FILES_KEYS);
    expect(filesPort.owns(inside(FILES_VIEW))).toBe(true);
    expect(filesPort.owns(inside())).toBe(false);
    expect(filesPort.owns(null)).toBe(false);
  });

  it("leaves a dialog or a menu inside the view its own keys", () => {
    filesPort.set(() => {}, FILES_KEYS);
    expect(filesPort.owns(inside(FILES_VIEW, 'role="dialog"'))).toBe(false);
    expect(filesPort.owns(inside(FILES_VIEW, 'role="alertdialog"'))).toBe(false);
    expect(filesPort.owns(inside(FILES_VIEW, 'role="menu"'))).toBe(false);
  });
});
