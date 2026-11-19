// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialProjectState, project, projectStore } from "../stores/project";
import { shell } from "../stores/shell";
import { saveThemePreference, SCHEME_CHANGE_EVENT } from "./appearance";
import { applyPlaceScheme, changeScheme, currentPlaceKind, initPlaceScheme, placeKind } from "./placeScheme";
import type { WorkspaceCatalog, WorkspaceMeta } from "./tcserver/types";
import { WORK_CHATS, workspaceStore } from "./tcserver/workspaces";

const root = document.documentElement;
const light = (): boolean => root.classList.contains("theme-light");

const CODE = "/Users/me/repo";
const WORK = "/Users/me/Work/purdue";
const row = (id: string, path: string, kind?: "work"): WorkspaceMeta => ({ environmentId: "local", id, name: id, path, git: true, createdAt: 1, ...(kind ? { kind } : {}) }) as WorkspaceMeta;
const catalogOf = (workspaces: WorkspaceMeta[], loaded = true): WorkspaceCatalog =>
  ({ workspaces, projects: [], icons: new Map(), defaults: new Map(), defaultsErrors: new Map(), loaded }) as unknown as WorkspaceCatalog;
const BOTH = [row("wCode", CODE), row("wWork", WORK, "work")];

let catalog: WorkspaceCatalog;
/** A catalog push: the store's own listeners fire, and they read `catalog`. */
function arrive(next: WorkspaceCatalog): void {
  catalog = next;
  workspaceStore.hydrate([{ environmentId: `late-${Math.random()}`, workspaces: [row("wLate", `/late/${Math.random()}`)], projects: [] }]);
}

let stop: (() => void) | undefined;
/** The window as it launches: on `cwd`, with these choices saved. */
function launch(cwd: string, choices: { code?: "light" | "dark" | "system"; work?: "light" | "dark" | "system" } = {}): void {
  if (choices.code) saveThemePreference("code", choices.code);
  if (choices.work) saveThemePreference("work", choices.work);
  projectStore.setState(initialProjectState({ projectCwd: cwd, selectedProjectId: null }));
  stop = initPlaceScheme();
}

/** A `document.startViewTransition` that runs its callback when told to, as the browser does a frame later. */
function stubTransitions() {
  const made: { run: () => void; finish: () => void; skipped: boolean }[] = [];
  const start = vi.fn((callback: () => void) => {
    let settle!: () => void;
    const finished = new Promise<void>((resolve) => (settle = resolve));
    const entry = { run: callback, finish: settle, skipped: false };
    made.push(entry);
    return { finished, skipTransition: () => void (entry.skipped = true) };
  });
  Object.defineProperty(document, "startViewTransition", { value: start, configurable: true });
  return { start, made };
}

beforeEach(() => {
  localStorage.clear();
  root.className = "";
  catalog = catalogOf(BOTH);
  vi.spyOn(workspaceStore, "getSnapshot").mockImplementation(() => catalog);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 1;
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  Reflect.deleteProperty(document, "startViewTransition");
  Reflect.deleteProperty(window, "api");
  vi.restoreAllMocks();
  workspaceStore.reset();
  window.history.replaceState(null, "", "/");
});

describe("placeKind", () => {
  it("is code for a code workspace and for Chats, work for a Work workspace and for Work Chats", () => {
    const known = catalogOf(BOTH);
    expect(placeKind(CODE, known)).toBe("code");
    expect(placeKind("~", known)).toBe("code");
    expect(placeKind(WORK, known)).toBe("work");
    expect(placeKind(WORK_CHATS, known)).toBe("work");
    // The two homes need no catalog at all.
    expect(placeKind("~", catalogOf([], false))).toBe("code");
    expect(placeKind(WORK_CHATS, catalogOf([], false))).toBe("work");
  });

  it("cannot say for a folder no row names until every row has arrived; then it is a code folder", () => {
    expect(placeKind("/elsewhere", catalogOf(BOTH, false))).toBeNull();
    expect(placeKind("/elsewhere", catalogOf(BOTH, true))).toBe("code");
    // A row that has arrived is enough, loaded or not.
    expect(placeKind(WORK, catalogOf(BOTH, false))).toBe("work");
  });
});

describe("changeScheme", () => {
  it("changes the class inside a view transition, with element transitions off until it has finished", async () => {
    const { start, made } = stubTransitions();
    const heard = vi.fn();
    window.addEventListener(SCHEME_CHANGE_EVENT, heard);
    changeScheme("light");
    window.removeEventListener(SCHEME_CHANGE_EVENT, heard);
    expect(start).toHaveBeenCalledTimes(1);
    // The old picture is taken first: nothing has changed yet.
    expect(light()).toBe(false);
    expect(root.classList.contains("theme-switching")).toBe(true);
    made[0].run();
    expect(light()).toBe(true);
    expect(root.classList.contains("theme-switching")).toBe(true);
    made[0].finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(root.classList.contains("theme-switching")).toBe(false);
    window.addEventListener(SCHEME_CHANGE_EVENT, heard);
    made[0].run();
    window.removeEventListener(SCHEME_CHANGE_EVENT, heard);
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toBe("light");
  });

  it("does nothing when the theme is the one already worn", () => {
    const { start } = stubTransitions();
    changeScheme("dark");
    expect(start).not.toHaveBeenCalled();
    expect(root.classList.contains("theme-switching")).toBe(false);
  });

  it("skips a dissolve still running when a second change comes, and ends on the second", async () => {
    const { made } = stubTransitions();
    changeScheme("light");
    made[0].run();
    changeScheme("dark");
    expect(made[0].skipped).toBe(true);
    made[1].run();
    expect(light()).toBe(false);
    // The first finishing late neither sets its class nor turns transitions back on under the second.
    made[0].finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(light()).toBe(false);
    expect(root.classList.contains("theme-switching")).toBe(true);
    made[1].finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(root.classList.contains("theme-switching")).toBe(false);
  });

  it("leaves the right class when the page refuses the transition", () => {
    Object.defineProperty(document, "startViewTransition", { value: () => { throw new Error("refused"); }, configurable: true });
    changeScheme("light");
    expect(light()).toBe(true);
    expect(root.classList.contains("theme-switching")).toBe(false);
  });

  it("leaves the right class when a transition ends without ever running its change", async () => {
    let settle!: (reason: unknown) => void;
    const finished = new Promise<void>((_resolve, reject) => (settle = reject));
    Object.defineProperty(document, "startViewTransition", { value: () => ({ finished, skipTransition: () => {} }), configurable: true });
    changeScheme("light");
    settle(new Error("aborted"));
    await Promise.resolve();
    await Promise.resolve();
    expect(light()).toBe(true);
    expect(root.classList.contains("theme-switching")).toBe(false);
  });

  it("sets the class at once without view transitions, in a hidden window, under reduced motion, and when told to", () => {
    // No API at all.
    changeScheme("light");
    expect(light()).toBe(true);
    const { start } = stubTransitions();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    changeScheme("dark");
    expect(light()).toBe(false);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    Object.defineProperty(window, "matchMedia", { value: (query: string) => ({ matches: query.includes("reduced-motion"), addEventListener: () => {}, removeEventListener: () => {} }), configurable: true });
    changeScheme("light");
    expect(light()).toBe(true);
    Reflect.deleteProperty(window, "matchMedia");
    changeScheme("dark", true);
    expect(light()).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("a window wears the theme of its place", () => {
  it("takes Code's theme on a code workspace and Work's on a Work one, in the same turn as the move", () => {
    launch(CODE, { code: "dark", work: "light" });
    expect(light()).toBe(false);
    expect(currentPlaceKind()).toBe("code");
    project.setProjectCwd(WORK);
    // No frame between the place and its theme: the store's own callback set the class.
    expect(light()).toBe(true);
    expect(currentPlaceKind()).toBe("work");
    expect(localStorage.getItem("monocode.placeKind")).toBe("work");
    project.setProjectCwd("~");
    expect(light()).toBe(false);
    project.setProjectCwd(WORK_CHATS);
    expect(light()).toBe(true);
    project.setProjectCwd(CODE);
    expect(light()).toBe(false);
  });

  it("dissolves between the two kinds, and moves nothing between two places of one kind", () => {
    launch(CODE, { code: "dark", work: "light" });
    const { start, made } = stubTransitions();
    project.setProjectCwd("~");
    expect(start).not.toHaveBeenCalled();
    project.setProjectCwd(WORK);
    expect(start).toHaveBeenCalledTimes(1);
    made[0].run();
    expect(light()).toBe(true);
  });

  it("has Work follow Code until Work is set", () => {
    launch(CODE, { code: "light" });
    expect(light()).toBe(true);
    project.setProjectCwd(WORK);
    expect(light()).toBe(true);
    saveThemePreference("work", "dark");
    applyPlaceScheme();
    expect(light()).toBe(false);
    project.setProjectCwd(CODE);
    expect(light()).toBe(true);
  });

  it("keeps the theme it wears until a late catalog names the place's kind, then moves once", () => {
    catalog = catalogOf([], false);
    launch(WORK, { code: "dark", work: "light" });
    // Nothing says what this folder is yet.
    expect(light()).toBe(false);
    expect(currentPlaceKind()).toBe("code");
    arrive(catalogOf(BOTH, false));
    expect(light()).toBe(true);
    expect(currentPlaceKind()).toBe("work");
  });

  it("opens on the kind in its own address, whatever another window saved last", () => {
    catalog = catalogOf([], false);
    localStorage.setItem("monocode.placeKind", "code");
    window.history.replaceState(null, "", "/?place=work");
    launch("/not/yet/known", { code: "dark", work: "light" });
    expect(currentPlaceKind()).toBe("work");
    expect(light()).toBe(true);
  });

  it("does not change when Settings, the Inbox, the Outbox, Search or Notes opens over the place", () => {
    launch(WORK, { code: "dark", work: "light" });
    expect(light()).toBe(true);
    const { start } = stubTransitions();
    for (const open of [() => shell.openSettings(), () => shell.openInbox(), () => shell.openOutbox(), () => shell.openNotes(), () => shell.openAccountsPage("stats")]) {
      open();
      expect(light()).toBe(true);
      expect(currentPlaceKind()).toBe("work");
    }
    expect(start).not.toHaveBeenCalled();
    shell.closeSettings();
    shell.closeInbox();
    shell.closeOutbox();
    shell.closeNotes();
    shell.closeAccountsPage();
  });

  it("changes when a Work thread is followed from a code workspace, and back with a code thread", () => {
    launch(CODE, { code: "dark", work: "light" });
    project.followSession({ cwd: WORK, projectId: null, workspaceId: "wWork", scope: "work" });
    expect(projectStore.getState().projectCwd).toBe(WORK);
    expect(light()).toBe(true);
    // A Work chat outside every workspace is Work's too.
    project.followSession({ cwd: "/anywhere", projectId: null, workspaceId: null, scope: "work" });
    expect(projectStore.getState().projectCwd).toBe(WORK_CHATS);
    expect(light()).toBe(true);
    project.followSession({ cwd: CODE, projectId: null, workspaceId: "wCode" });
    expect(light()).toBe(false);
  });

  it("applies a setting another window changed, for the kind of place this window is on", () => {
    launch(CODE, { code: "dark" });
    localStorage.setItem("monocode.colorScheme.work", "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "monocode.colorScheme.work" }));
    // Work's theme is not this window's business while it is on code.
    expect(light()).toBe(false);
    localStorage.setItem("monocode.colorScheme", "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "monocode.colorScheme" }));
    expect(light()).toBe(true);
    // Another window's place is not this window's.
    localStorage.setItem("monocode.placeKind", "work");
    window.dispatchEvent(new StorageEvent("storage", { key: "monocode.placeKind" }));
    expect(currentPlaceKind()).toBe("code");
    expect(light()).toBe(true);
  });

  it("follows the system when the place's choice is System", () => {
    let systemLight = false;
    const listeners = new Set<() => void>();
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => ({
        get matches() {
          return query.includes("prefers-color-scheme: light") && systemLight;
        },
        addEventListener: (_: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
      }),
      configurable: true,
    });
    launch(CODE, { code: "system" });
    expect(light()).toBe(false);
    systemLight = true;
    for (const cb of listeners) cb();
    expect(light()).toBe(true);
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("tells main the theme and the kind on every move, and says nothing on a page with no main", () => {
    const setAppearance = vi.fn();
    Object.defineProperty(window, "api", { value: { win: { setAppearance } }, configurable: true });
    launch(CODE, { code: "dark", work: "light" });
    expect(setAppearance).toHaveBeenLastCalledWith({ scheme: "dark", kind: "code" });
    project.setProjectCwd(WORK);
    expect(setAppearance).toHaveBeenLastCalledWith({ scheme: "light", kind: "work" });
    // The kind is told even where the theme stays.
    saveThemePreference("work", "dark");
    applyPlaceScheme();
    project.setProjectCwd(CODE);
    expect(setAppearance).toHaveBeenLastCalledWith({ scheme: "dark", kind: "code" });
    Reflect.deleteProperty(window, "api");
    expect(() => project.setProjectCwd(WORK)).not.toThrow();
  });
});

describe("the dissolve", () => {
  const css = readFileSync(join(__dirname, "../index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("is one cross-fade of the window's picture over the fast duration, on the tokens", () => {
    const rule = /html\.theme-switching::view-transition-old\(root\),\s*html\.theme-switching::view-transition-new\(root\) \{([^}]*)\}/.exec(css);
    expect(rule?.[1].replace(/\s+/g, " ").trim()).toBe("animation-duration: var(--dur-fast); animation-timing-function: var(--ease-out);");
  });

  it("takes no input, and holds every element's own transition off while the theme turns", () => {
    expect(css).toMatch(/html\.theme-switching::view-transition \{\s*pointer-events: none;\s*\}/);
    expect(css).toMatch(/html\.theme-switching \*,\s*html\.theme-switching \*::before,\s*html\.theme-switching \*::after \{\s*transition: none !important;\s*\}/);
  });

  it("belongs to a theme change alone: no other view transition takes its timing", () => {
    expect(css.match(/::view-transition/g)).toHaveLength(3);
    expect(css).not.toMatch(/(?<!theme-switching)::view-transition/);
  });
});
