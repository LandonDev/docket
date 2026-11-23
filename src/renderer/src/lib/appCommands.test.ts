import { describe, expect, it, vi } from "vitest";

// These keys are a Mac's (⌘): the suite runs on any machine, so it says which platform it means (lib/keys.ts).
vi.mock("./platform", () => ({ IS_MAC: true }));
import { RENDERER_MENU_IDS } from "@shared/menuTree";
import { createKeyResolver, editorAnswers, editorHeld, editorKeys, isAppCommandId, menuCommandAllowed, pageOwnsKey, workCommands, DOUBLE_SHIFT_MS } from "./appCommands";

type Surface = "dialog" | "monaco" | "terminal" | "codemirror" | "composer" | "driving" | null;

const SELECTORS: Record<Exclude<Surface, null>, string> = {
  dialog: 'role="dialog"',
  monaco: ".monaco-editor",
  terminal: ".monocode-terminal",
  codemirror: ".cm-editor",
  composer: "[data-composer]",
  driving: "[data-driving]",
};

function key(
  k: string,
  mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {},
  surface: Surface = null,
): KeyboardEvent {
  const target = {
    closest: (selector: string) =>
      surface && selector.includes(SELECTORS[surface]) ? {} : null,
  };
  return {
    key: k,
    code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    isComposing: false,
    repeat: false,
    target,
  } as unknown as KeyboardEvent;
}

const ctx = { lightboxOpen: false };

describe("command map: chords", () => {
  const resolve = createKeyResolver();
  it.each([
    ["p", "go_to_file"],
    ["o", "open_project"],
    ["t", "show_hierarchy"],
    ["n", "new_tab"],
    ["s", "save_all"],
    ["k", "open_search"],
    ["b", "toggle_sidebar"],
    ["w", "close_tab"],
    ["=", "zoom_in"],
    ["-", "zoom_out"],
    ["0", "zoom_reset"],
  ])("⌘%s → %s", (k, id) => {
    expect(resolve(key(k, { meta: true }), ctx)).toEqual({ id });
  });

  it("⌘⇧F finds in project, ⌘⇧N opens a window, ⌘⇧R toggles the thread panel, ⌘1 activates a tab", () => {
    expect(resolve(key("f", { meta: true, shift: true }), ctx)).toEqual({ id: "find_in_project" });
    expect(resolve(key("n", { meta: true, shift: true }), ctx)).toEqual({ id: "new_window" });
    expect(resolve(key("r", { meta: true, shift: true }), ctx)).toEqual({ id: "toggle_panel" });
    expect(resolve(key("o", { meta: true, shift: true }), ctx)).toEqual({ id: "go_to_symbol" });
    expect(resolve(key("m", { meta: true, shift: true }), ctx)).toEqual({ id: "toggle_message_list" });
    expect(resolve(key("1", { meta: true }), ctx)).toEqual({ id: "activate_tab", index: 0 });
  });

  it("⌘T no longer opens a tab and plain letters do nothing", () => {
    expect(resolve(key("t", { meta: true }), ctx)?.id).not.toBe("new_tab");
    expect(resolve(key("p"), ctx)).toBeNull();
  });
});

describe("command map: environment chords", () => {
  const resolve = createKeyResolver();
  const chord = (code: string) =>
    ({ ...key("x", { meta: true, alt: true }), key: "‘", code }) as unknown as KeyboardEvent;
  it("⌘⌥] and ⌘⌥[ step environments, ⌘⌥1–9 jump (9 is the last)", () => {
    expect(resolve(chord("BracketRight"), ctx)).toEqual({ id: "next_environment" });
    expect(resolve(chord("BracketLeft"), ctx)).toEqual({ id: "prev_environment" });
    expect(resolve(chord("Digit1"), ctx)).toEqual({ id: "activate_environment", index: 0 });
    expect(resolve(chord("Digit3"), ctx)).toEqual({ id: "activate_environment", index: 2 });
    expect(resolve(chord("Digit9"), ctx)).toEqual({ id: "activate_environment", index: -1 });
    expect(resolve(chord("Digit0"), ctx)).toBeNull();
  });
  it("with Shift held, or without Option, they are not ours", () => {
    expect(resolve({ ...chord("BracketRight"), shiftKey: true } as unknown as KeyboardEvent, ctx)).toBeNull();
    expect(resolve(key("]", { meta: true }), ctx)).toEqual({ id: "forward_tab" });
  });
});

describe("command map: double Shift", () => {
  it("fires on two bare Shifts inside the window", () => {
    let t = 0;
    const resolve = createKeyResolver(() => t);
    expect(resolve(key("Shift", { shift: true }), ctx)).toBeNull();
    t = DOUBLE_SHIFT_MS - 1;
    expect(resolve(key("Shift", { shift: true }), ctx)).toEqual({ id: "go_to_file" });
    // The pair is consumed; a third press starts over.
    t += 10;
    expect(resolve(key("Shift", { shift: true }), ctx)).toBeNull();
  });

  it("does not fire late, after another key, or in the terminal", () => {
    let t = 0;
    const resolve = createKeyResolver(() => t);
    resolve(key("Shift", { shift: true }), ctx);
    t = DOUBLE_SHIFT_MS + 1;
    expect(resolve(key("Shift", { shift: true }), ctx)).toBeNull();

    t = 1000;
    resolve(key("Shift", { shift: true }), ctx);
    resolve(key("A", { shift: true }), ctx);
    t = 1010;
    expect(resolve(key("Shift", { shift: true }), ctx)).toBeNull();

    t = 2000;
    resolve(key("Shift", { shift: true }, "terminal"), ctx);
    t = 2010;
    expect(resolve(key("Shift", { shift: true }, "terminal"), ctx)).toBeNull();
  });

  it("still fires from the composer", () => {
    let t = 0;
    const resolve = createKeyResolver(() => t);
    resolve(key("Shift", { shift: true }, "composer"), ctx);
    t = 100;
    expect(resolve(key("Shift", { shift: true }, "composer"), ctx)).toEqual({ id: "go_to_file" });
  });
});

describe("command map: guards", () => {
  const resolve = createKeyResolver();

  it("a dialog swallows everything but zoom and Save All", () => {
    expect(resolve(key("p", { meta: true }, "dialog"), ctx)).toBeNull();
    expect(resolve(key("n", { meta: true }, "dialog"), ctx)).toBeNull();
    expect(resolve(key("n", { meta: true, shift: true }, "dialog"), ctx)).toBeNull();
    expect(resolve(key("=", { meta: true }, "dialog"), ctx)).toEqual({ id: "zoom_in" });
    expect(resolve(key("s", { meta: true }, "dialog"), ctx)).toEqual({ id: "save_all" });
  });

  it("an open lightbox owns Escape and the arrows", () => {
    const lit = { lightboxOpen: true };
    expect(resolve(key("Escape"), lit)).toEqual({ id: "lightbox_close" });
    expect(resolve(key("ArrowLeft"), lit)).toEqual({ id: "lightbox_prev" });
    expect(resolve(key("ArrowRight"), lit)).toEqual({ id: "lightbox_next" });
    expect(resolve(key("p", { meta: true }), lit)).toBeNull();
    expect(resolve(key("=", { meta: true }), lit)).toEqual({ id: "zoom_in" });
  });

  it("a focused Monaco keeps ⌘P, ⌃T, ⌃D and ⌃H; other chords pass", () => {
    expect(resolve(key("p", { meta: true }, "monaco"), ctx)).toBeNull();
    expect(resolve(key("t", { ctrl: true }, "monaco"), ctx)).toBeNull();
    expect(resolve(key("d", { ctrl: true }, "monaco"), ctx)).toBeNull();
    expect(resolve(key("h", { ctrl: true }, "monaco"), ctx)).toBeNull();
    expect(resolve(key("o", { meta: true }, "monaco"), ctx)).toEqual({ id: "open_project" });
    expect(resolve(key("o", { meta: true, shift: true }, "monaco"), ctx)).toEqual({ id: "go_to_symbol" });
    expect(resolve(key("s", { meta: true }, "monaco"), ctx)).toEqual({ id: "save_all" });
  });

  it("CodeMirror keeps split chords; pickers keep ⌘digits", () => {
    expect(resolve(key("d", { meta: true }, "codemirror"), ctx)).toBeNull();
    expect(resolve(key("1", { meta: true }, "dialog"), ctx)).toBeNull();
  });

  it("the menu route mirrors the overlay guard", () => {
    expect(menuCommandAllowed("go_to_file", { dialogOpen: true, lightboxOpen: false })).toBe(false);
    expect(menuCommandAllowed("zoom_in", { dialogOpen: true, lightboxOpen: false })).toBe(true);
    expect(menuCommandAllowed("go_to_file", { dialogOpen: false, lightboxOpen: false })).toBe(true);
  });

  it("every renderer id in the menu tree is a command", () => {
    expect(RENDERER_MENU_IDS.filter((id) => !isAppCommandId(id))).toEqual([]);
  });
});

describe("a live picture he drives holds the keyboard", () => {
  it("leaves every key to the page: the Ctrl chords, Escape and the arrows under the full view, and a double Shift", () => {
    let t = 0;
    const resolve = createKeyResolver(() => t);
    for (const k of ["s", "b", "k", "p", "o", "t", "w"]) expect(resolve(key(k, { ctrl: true }, "driving"), ctx)).toBeNull();
    expect(resolve(key("f", { ctrl: true, shift: true }, "driving"), ctx)).toBeNull();
    for (const k of ["Escape", "ArrowLeft", "ArrowRight"]) expect(resolve(key(k, {}, "driving"), { lightboxOpen: true })).toBeNull();
    expect(resolve(key("Shift", {}, "driving"), ctx)).toBeNull();
    t += 50;
    expect(resolve(key("Shift", {}, "driving"), ctx)).toBeNull();
    // the same keys anywhere else are the app's
    expect(resolve(key("s", { ctrl: true }), ctx)).toEqual({ id: "save_all" });
    expect(resolve(key("Escape"), { lightboxOpen: true })).toEqual({ id: "lightbox_close" });
  });

  it("says a key is the page's only inside the driven picture", () => {
    expect(pageOwnsKey(key("Escape", {}, "driving"))).toBe(true);
    expect(pageOwnsKey(key("Escape", {}, "dialog"))).toBe(false);
    expect(pageOwnsKey(key("Escape"))).toBe(false);
  });
});

describe("a Work editor holding the caret owns its keys", () => {
  /** What the editor under the next key answers itself (its Body's `data-editor-answers`); null: its Body answers nothing. */
  let answers: string | null = null;
  /** A key whose target sits in an editor root marked `mark` (null: outside any). */
  function inEditor(k: string, mark: string | null, mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = { meta: true }, code?: string): KeyboardEvent {
    const said = answers;
    const root = { getAttribute: (name: string) => (name === "data-editor-keys" ? mark : name === "data-editor-answers" ? said : null) };
    return {
      ...key(k, mods),
      ...(code ? { code } : {}),
      target: {
        closest: (selector: string) =>
          mark === null ? null : selector === "[data-editor-keys]" ? root : selector === "[data-editor-answers]" && said !== null ? root : null,
      },
    } as unknown as KeyboardEvent;
  }
  const resolve = createKeyResolver();

  it("reads the root's mark: one he can edit, a document, a read-only one, or none", () => {
    expect(editorKeys(inEditor("b", "").target)).toBe("");
    expect(editorKeys(inEditor("b", "document").target)).toBe("document");
    expect(editorKeys(inEditor("b", "read").target)).toBe("read");
    expect(editorKeys(inEditor("b", null).target)).toBeNull();
    expect(editorKeys(null)).toBeNull();
  });

  it("⌘B and ⌘K are the editor's in a root he can edit, the app's outside it and in a read-only one", () => {
    for (const mark of ["", "document"]) {
      expect(resolve(inEditor("b", mark), ctx)).toBeNull();
      expect(resolve(inEditor("k", mark), ctx)).toBeNull();
      // Ctrl is the same key off macOS
      expect(resolve(inEditor("b", mark, { ctrl: true }), ctx)).toBeNull();
    }
    expect(resolve(inEditor("b", null), ctx)).toEqual({ id: "toggle_sidebar" });
    expect(resolve(inEditor("k", null), ctx)).toEqual({ id: "open_search" });
    expect(resolve(inEditor("b", "read"), ctx)).toEqual({ id: "toggle_sidebar" });
    expect(resolve(inEditor("k", "read"), ctx)).toEqual({ id: "open_search" });
  });

  it("⌘P is Go to File and ⌘F the app's until the editor holding the caret answers them; then they are Print and its find, in a read-only root too", () => {
    expect(resolve(inEditor("p", "document"), ctx)).toEqual({ id: "go_to_file" });
    expect(resolve(inEditor("f", "document"), ctx)).toBeNull();
    answers = "export find print";
    for (const mark of ["", "document", "read"]) {
      expect(resolve(inEditor("p", mark), ctx)).toEqual({ id: "print" });
      expect(resolve(inEditor("f", mark), ctx)).toEqual({ id: "find" });
    }
    // outside the editor's root the keys are the app's, whatever is on screen
    expect(resolve(inEditor("p", null), ctx)).toEqual({ id: "go_to_file" });
    expect(resolve(inEditor("f", null), ctx)).toBeNull();
    answers = null;
    expect(resolve(inEditor("p", "document"), ctx)).toEqual({ id: "go_to_file" });
  });

  it("a sheet beside the document answering Print does not take ⌘P or ⌘F from a document that answers neither", () => {
    // Another editor on screen offers both: the menu's rows are live, and the keys under this caret are still the app's.
    const offs = [workCommands.offer("print"), workCommands.offer("find")];
    answers = "export";
    expect(resolve(inEditor("p", "document"), ctx)).toEqual({ id: "go_to_file" });
    expect(resolve(inEditor("f", "document"), ctx)).toBeNull();
    expect(editorHeld(inEditor("p", "document").target)).toEqual(["toggle_sidebar", "open_search"]);
    expect(editorAnswers(inEditor("p", "document").target, "export")).toBe(true);
    expect(editorAnswers(inEditor("p", "document").target, "print")).toBe(false);
    // "print" is a whole word of the list, never part of one
    answers = "printer";
    expect(editorAnswers(inEditor("p", "document").target, "print")).toBe(false);
    answers = null;
    expect(editorAnswers(inEditor("p", "document").target, "print")).toBe(false);
    expect(editorAnswers(null, "print")).toBe(false);
    for (const off of offs) off();
  });

  it("⇧⌘E is Export… while an editor answers it, wherever the caret is, and nothing before", () => {
    expect(resolve(inEditor("e", null, { meta: true, shift: true }), ctx)).toBeNull();
    const off = workCommands.offer("export");
    expect(resolve(inEditor("e", null, { meta: true, shift: true }), ctx)).toEqual({ id: "export" });
    expect(resolve(inEditor("e", "document", { meta: true, shift: true }), ctx)).toEqual({ id: "export" });
    off();
    expect(resolve(inEditor("e", "document", { meta: true, shift: true }), ctx)).toBeNull();
  });

  it("a document keeps ⌥⌘0 to ⌥⌘3 for its styles; elsewhere ⌥⌘1 is the first host", () => {
    for (const n of [0, 1, 2, 3]) expect(resolve(inEditor(String(n), "document", { meta: true, alt: true }, `Digit${n}`), ctx)).toBeNull();
    expect(resolve(inEditor("4", "document", { meta: true, alt: true }, "Digit4"), ctx)).toEqual({ id: "activate_environment", index: 3 });
    expect(resolve(inEditor("1", "", { meta: true, alt: true }, "Digit1"), ctx)).toEqual({ id: "activate_environment", index: 0 });
    expect(resolve(inEditor("1", null, { meta: true, alt: true }, "Digit1"), ctx)).toEqual({ id: "activate_environment", index: 0 });
  });

  it("every other chord is the app's inside an editor as outside it", () => {
    for (const [k, id] of [["o", "open_project"], ["s", "save_all"], ["n", "new_tab"], ["w", "close_tab"], [",", "open_settings"], ["=", "zoom_in"]] as const) {
      expect(resolve(inEditor(k, "document"), ctx)).toEqual({ id });
    }
    expect(resolve(inEditor("f", "document", { meta: true, shift: true }), ctx)).toEqual({ id: "find_in_project" });
    // a dialog over the editor still wins
    const dialog = { ...inEditor("b", "document"), target: { closest: (selector: string) => (selector.includes('role="dialog"') ? {} : null) } } as unknown as KeyboardEvent;
    expect(resolve(dialog, ctx)).toBeNull();
  });

  it("names the menu rows the editor holds: the menu drops those keys while the caret is there", () => {
    const target = (mark: string | null) => inEditor("b", mark).target;
    expect(editorHeld(target(null))).toEqual([]);
    expect(editorHeld(target("document"))).toEqual(["toggle_sidebar", "open_search"]);
    expect(editorHeld(target("read"))).toEqual([]);
    answers = "find print";
    expect(editorHeld(target("document"))).toEqual(["toggle_sidebar", "open_search", "go_to_file", "find"]);
    expect(editorHeld(target("read"))).toEqual(["go_to_file", "find"]);
    expect(editorHeld(target(null))).toEqual([]);
    answers = null;
  });

  it("runs a command only when an editor answers it, as one window event", () => {
    const heard: unknown[] = [];
    const window = { dispatchEvent: (event: { type: string; detail: unknown }) => (heard.push([event.type, event.detail]), true) };
    vi.stubGlobal("window", window);
    vi.stubGlobal("CustomEvent", class { constructor(readonly type: string, readonly init: { detail: unknown }) {} get detail() { return this.init.detail; } });
    expect(workCommands.run("print")).toBe(false);
    const changes: number[] = [];
    const unsubscribe = workCommands.subscribe(() => changes.push(1));
    const off = workCommands.offer("print");
    expect(workCommands.run("print")).toBe(true);
    expect(workCommands.run("export")).toBe(false);
    off();
    expect(workCommands.run("print")).toBe(false);
    expect(heard).toEqual([["work:command", { id: "print" }]]);
    expect(changes).toHaveLength(2);
    unsubscribe();
    vi.unstubAllGlobals();
  });
});
