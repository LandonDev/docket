import { describe, expect, it } from "vitest";
import { acceleratorHint, acceleratorOf, altOnly, bareKey, chordKey, ctrlOnly, joinCaps, keyCaps, keyHint, macCommand, modKey, modOrCtrl } from "./keys";

const key = (mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("the command modifier", () => {
  it("is ⌘ on a Mac and Ctrl everywhere else", () => {
    expect(modKey(key({ metaKey: true }), true)).toBe(true);
    expect(modKey(key({ ctrlKey: true }), true)).toBe(false);
    expect(modKey(key({ ctrlKey: true }), false)).toBe(true);
    // The Windows key is the system's: it is never the command modifier there.
    expect(modKey(key({ metaKey: true }), false)).toBe(false);
  });

  it("is one of the two alone, never both", () => {
    expect(modKey(key({ metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(modKey(key({ metaKey: true, ctrlKey: true }), false)).toBe(false);
  });

  it("modOrCtrl takes either key on every platform, as the chords here always have", () => {
    expect(modOrCtrl(key({ metaKey: true }))).toBe(true);
    expect(modOrCtrl(key({ ctrlKey: true }))).toBe(true);
    expect(modOrCtrl(key({ altKey: true }))).toBe(false);
  });

  it("⌘ on a Mac has no twin for a key Ctrl already owns on Windows", () => {
    // ⌘C copies in a terminal; Ctrl+C must still reach the shell on Windows.
    expect(macCommand(key({ metaKey: true }), true)).toBe(true);
    expect(macCommand(key({ ctrlKey: true }), true)).toBe(false);
    expect(macCommand(key({ ctrlKey: true }), false)).toBe(false);
    expect(macCommand(key({ metaKey: true }), false)).toBe(false);
  });

  it("tells Control alone, Alt alone, a chord and a bare key", () => {
    expect(ctrlOnly(key({ ctrlKey: true }))).toBe(true);
    expect(ctrlOnly(key({ ctrlKey: true, metaKey: true }))).toBe(false);
    expect(altOnly(key({ altKey: true }))).toBe(true);
    expect(altOnly(key({ altKey: true, shiftKey: true }))).toBe(false);
    expect(chordKey(key({ altKey: true }))).toBe(true);
    expect(chordKey(key({ shiftKey: true }))).toBe(false);
    expect(bareKey(key())).toBe(true);
    expect(bareKey(key({ shiftKey: true }))).toBe(false);
  });
});

describe("key hints", () => {
  it("a Mac runs its glyphs together; Windows and Linux write words joined by a plus", () => {
    expect(keyHint("mod+shift+M", true)).toBe("⌘⇧M");
    expect(keyHint("mod+shift+M", false)).toBe("Ctrl+Shift+M");
    expect(keyHint("mod+alt+F", true)).toBe("⌘⌥F");
    expect(keyHint("mod+alt+F", false)).toBe("Ctrl+Alt+F");
    expect(keyHint("ctrl+D", true)).toBe("⌃D");
    expect(keyHint("ctrl+D", false)).toBe("Ctrl+D");
  });

  it("Enter is a word off the Mac, whichever of its two glyphs the Mac draws", () => {
    expect(keyHint("mod+enter", true)).toBe("⌘⏎");
    expect(keyHint("mod+return", true)).toBe("⌘↩");
    expect(keyHint("mod+enter", false)).toBe("Ctrl+Enter");
    expect(keyHint("mod+return", false)).toBe("Ctrl+Enter");
  });

  it("gives the caps one by one for a row of key caps", () => {
    expect(keyCaps("mod+S", true)).toEqual(["⌘", "S"]);
    expect(keyCaps("mod+S", false)).toEqual(["Ctrl", "S"]);
    expect(keyCaps("mod+alt+shift+ctrl+delete+enter", false)).toEqual(["Ctrl", "Alt", "Shift", "Ctrl", "Delete", "Enter"]);
    expect(joinCaps(["Ctrl", "W"], false)).toBe("Ctrl+W");
    expect(joinCaps(["⌘", "W"], true)).toBe("⌘W");
  });

  it("keeps a plus, a comma and a digit as the key", () => {
    expect(keyHint("mod++", false)).toBe("Ctrl++");
    expect(keyHint("mod++", true)).toBe("⌘+");
    expect(keyHint("mod+,", false)).toBe("Ctrl+,");
    expect(keyHint("mod+1", true)).toBe("⌘1");
  });
});

describe("a global key", () => {
  it("reads a chord by the key's place, in each platform's names", () => {
    expect(acceleratorOf({ ...key({ metaKey: true, shiftKey: true }), code: "Space" }, true)).toBe("Command+Shift+Space");
    expect(acceleratorOf({ ...key({ altKey: true, shiftKey: true }), code: "Space" }, false)).toBe("Alt+Shift+Space");
    expect(acceleratorOf({ ...key({ ctrlKey: true, altKey: true }), code: "KeyK" }, true)).toBe("Control+Alt+K");
    expect(acceleratorOf({ ...key({ metaKey: true }), code: "Digit3" }, false)).toBe("Super+3");
    expect(acceleratorOf({ ...key({ ctrlKey: true }), code: "F12" }, false)).toBe("Control+F12");
    expect(acceleratorOf({ ...key({ ctrlKey: true }), code: "Slash" }, false)).toBe("Control+/");
  });

  it("waits for a key that is not a modifier, with a modifier that is not Shift alone", () => {
    expect(acceleratorOf({ ...key({ metaKey: true }), code: "MetaLeft" }, true)).toBeNull();
    expect(acceleratorOf({ ...key({ shiftKey: true }), code: "KeyA" }, true)).toBeNull();
    expect(acceleratorOf({ ...key(), code: "Space" }, true)).toBeNull();
  });

  it("writes an accelerator as the platform writes a hint", () => {
    expect(acceleratorHint("Command+Shift+Space", true)).toBe("⌘⇧Space");
    expect(acceleratorHint("Alt+Shift+Space", false)).toBe("Alt+Shift+Space");
    expect(acceleratorHint("Control+Alt+K", true)).toBe("⌃⌥K");
    expect(acceleratorHint("CommandOrControl+Return", false)).toBe("Ctrl+Enter");
  });
});
