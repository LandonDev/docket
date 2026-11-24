// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellStore } from "../stores/shell";
import { messageListFold } from "./messageListFold";
import { awayStore, resetAwayForTest } from "./away";
import { registry } from "./connection/registry";
import { liveFocused, MENU_STATE_CLOCK_MS, MENU_STATE_THROTTLE_MS, menuStateOf, publishMenuState, type MenuFacts } from "./nativeMenuState";
import { rightPanel } from "./rightPanel";
import { sessionStore } from "./tcserver/store";
import type { SessionMeta } from "./tcserver/types";
import { workspaceStore } from "./tcserver/workspaces";

const NONE = { pause: 0, resume: 0, stop: 0, archiveDone: 0 };
const facts = (over: Partial<MenuFacts> = {}): MenuFacts => ({
  sidebarOpen: false,
  panel: "closed",
  dockOpen: false,
  messageList: false,
  split: false,
  dockUsable: true,
  unread: 1,
  counts: { pause: 1, resume: 1, stop: 1, archiveDone: 1 },
  away: false,
  workFile: true,
  workOn: true,
  print: true,
  export: true,
  saveWord: true,
  ...over,
});

describe("menuStateOf", () => {
  it("opens each toggle the window shows", () => {
    expect(menuStateOf(facts({ sidebarOpen: true, panel: "open", dockOpen: true, messageList: true }))).toEqual({
      open: ["toggle_sidebar", "toggle_panel", "toggle_terminal", "toggle_message_list"],
      disabled: [],
      checked: { toggle_away: false },
    });
    expect(menuStateOf(facts())).toEqual({ open: [], disabled: [], checked: { toggle_away: false } });
  });

  it("names ⌘W Close Pane while the active tab is split", () => {
    expect(menuStateOf(facts({ split: true })).open).toEqual(["close_tab"]);
  });

  it("greys the panel with no root thread on screen and the terminal outside a project", () => {
    expect(menuStateOf(facts({ panel: "none", dockUsable: false })).disabled).toEqual(["toggle_panel", "toggle_terminal"]);
  });

  it("greys Mark All Read with nothing unread, and never Notes", () => {
    expect(menuStateOf(facts({ unread: 0 })).disabled).toEqual(["mark_all_read"]);
  });

  it("greys each fleet switch whose count is zero", () => {
    expect(menuStateOf(facts({ counts: NONE })).disabled).toEqual([
      "pause_all_threads",
      "resume_all_threads",
      "stop_all_threads",
      "archive_done_threads",
    ]);
    expect(menuStateOf(facts({ counts: { ...NONE, resume: 2 } })).disabled).not.toContain("resume_all_threads");
  });

  it("ticks Away from Computer while Away is on", () => {
    expect(menuStateOf(facts({ away: true })).checked).toEqual({ toggle_away: true });
  });

  it("hides Work's own rows (Go → Search Work…, Today) while no host has Work on, and names none hidden while one has", () => {
    expect(menuStateOf(facts({ workOn: false })).hidden).toEqual(["save_word", "search_work", "open_today"]);
    expect(menuStateOf(facts({ workOn: true })).hidden).toBeUndefined();
  });

  it("names Today open while its page is on screen, so the row reads Close Today", () => {
    expect(menuStateOf(facts({ workOn: true })).open).not.toContain("open_today");
    expect(menuStateOf(facts({ workOn: true, today: true })).open).toContain("open_today");
  });

  it("greys Open File… with no Work thread, draft or view in front", () => {
    expect(menuStateOf(facts({ workFile: false })).disabled).toEqual(["open_file"]);
    expect(menuStateOf(facts({ workOn: false })).disabled).toEqual(["open_digest"]);
  });

  it("greys Digest while no host has Work on", () => {
    expect(menuStateOf(facts({ workOn: false })).disabled).toContain("open_digest");
    expect(menuStateOf(facts({ workOn: true })).disabled).not.toContain("open_digest");
  });
});

describe("first paint", () => {
  it("takes the menu's state from its own module, never the tree: the tree is 6 kB the launch does not need", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of ["nativeMenuState.ts", "appCommands.ts", "native.ts"]) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8");
      expect(source, file).not.toMatch(/import\s+(?!type\b)[^;]*["']@shared\/menuTree["']/);
    }
    const state = readFileSync(join(import.meta.dirname, "../../../shared/menuState.ts"), "utf8");
    expect(state).not.toMatch(/^import /m);
  });
});

describe("menuStateOf, with a Work editor", () => {
  it("greys Print… and Export… until an editor on screen answers them", () => {
    expect(menuStateOf(facts({ print: false, export: false })).disabled).toEqual(["print", "export"]);
    expect(menuStateOf(facts({ print: true, export: false })).disabled).toEqual(["export"]);
    const { print: _p, export: _e, saveWord: _w, ...bare } = facts();
    expect(menuStateOf(bare).disabled).toEqual(["print", "export", "save_word"]);
    // Save as Word to… is live only while a document of a Work workspace on screen answers it.
    expect(menuStateOf(facts({ saveWord: false })).disabled).toEqual(["save_word"]);
  });

  it("says live while a live Office file's guest has the focus, and nothing otherwise", () => {
    expect(menuStateOf(facts({ live: true })).live).toBe(true);
    expect("live" in menuStateOf(facts())).toBe(false);
    const guest = document.createElement("webview");
    guest.setAttribute("data-office-live", "");
    expect(liveFocused(guest)).toBe(true);
    expect(liveFocused(document.createElement("webview"))).toBe(false);
    expect(liveFocused(document.body)).toBe(false);
    expect(liveFocused(null)).toBe(false);
  });

  it("names the rows the editor holds, and says nothing of editing when it holds none", () => {
    expect(menuStateOf(facts({ editing: ["toggle_sidebar", "open_search"] })).editing).toEqual(["toggle_sidebar", "open_search"]);
    expect("editing" in menuStateOf(facts({ editing: [] }))).toBe(false);
    expect("editing" in menuStateOf(facts())).toBe(false);
  });
});

describe("publishMenuState", () => {
  const meta = (over: Partial<SessionMeta>): SessionMeta =>
    ({ id: "s", environmentId: "local", parentId: null, cwd: "/tmp/a", title: "t", status: "running", archived: false, updatedAt: 1, ...over }) as SessionMeta;
  let metas: SessionMeta[] = [];
  let metaListener: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    rightPanel.reset();
    metas = [meta({ id: "a" })];
    vi.spyOn(sessionStore, "metas").mockImplementation(() => metas);
    vi.spyOn(sessionStore, "onMetaChange").mockImplementation((l) => {
      metaListener = l;
      return () => {};
    });
    vi.spyOn(workspaceStore, "getSnapshot").mockReturnValue({ workspaces: [], projects: [] } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends the first state at once and each change once", () => {
    const send = vi.fn();
    const publisher = publishMenuState(() => ({ dockOpen: false, dockUsable: true }), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].disabled).toContain("toggle_panel");
    expect(send.mock.calls[0][0].disabled).not.toContain("pause_all_threads");

    // A meta that moved without changing any fact sends nothing.
    metas = [meta({ id: "a", updatedAt: 2 })];
    metaListener();
    metaListener();
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(1);

    // The thread settles: nothing left to pause or stop.
    metas = [meta({ id: "a", status: "idle", updatedAt: 3 })];
    metaListener();
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].disabled).toEqual(expect.arrayContaining(["pause_all_threads", "stop_all_threads"]));

    // A root thread comes on screen with its panel open.
    rightPanel.open("a");
    rightPanel.visible("a", true);
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0].open).toContain("toggle_panel");
    expect(send.mock.calls[2][0].disabled).not.toContain("toggle_panel");

    shellStore.setState({ projectRailOpen: !shellStore.getState().projectRailOpen });
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(4);
    publisher.stop();
  });

  it("says at once when the caret enters or leaves a Work editor, and again as editors start to answer Print and Find", async () => {
    const { workCommands } = await import("./appCommands");
    const send = vi.fn();
    const publisher = publishMenuState(() => ({ dockOpen: false, dockUsable: true }), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect("editing" in send.mock.calls[0][0]).toBe(false);
    expect(send.mock.calls[0][0].disabled).toEqual(expect.arrayContaining(["print", "export"]));

    document.body.innerHTML = `<input id="outside" /><div id="doc"><div data-editor-keys="document"><input id="title" /><div id="text" tabindex="0"></div></div></div><div id="attachment"><div data-editor-keys="read"><div id="read" tabindex="0"></div></div></div>`;
    const focus = (id: string): void => document.getElementById(id)!.focus();
    /** What each Body's root says it answers, as `useWorkCommands` writes it. */
    const answer = (list: string): void => {
      for (const id of ["doc", "attachment"]) document.getElementById(id)!.setAttribute("data-editor-answers", list);
    };

    // The caret enters a document: no throttle, the next key must already be the editor's.
    focus("text");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].editing).toEqual(["toggle_sidebar", "open_search"]);

    // Moving inside the same editor, from the text to the title and back, says nothing: no menu is built twice.
    focus("title");
    focus("text");
    expect(send).toHaveBeenCalledTimes(2);
    const before = send.mock.calls.length;

    // An editor that answers Print… and Find takes ⌘P and ⌘F too, and the rows go live.
    answer("export find print");
    const offs = [workCommands.offer("print"), workCommands.offer("find"), workCommands.offer("export")];
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect(send.mock.calls.length).toBe(before + 1);
    expect(send.mock.calls.at(-1)![0].editing).toEqual(["toggle_sidebar", "open_search", "go_to_file", "find"]);
    expect(send.mock.calls.at(-1)![0].disabled).not.toContain("print");
    expect(send.mock.calls.at(-1)![0].disabled).not.toContain("export");

    // A read-only root holds only what it answers.
    focus("read");
    expect(send.mock.calls.at(-1)![0].editing).toEqual(["go_to_file", "find"]);

    // Out of every editor: the keys are the menu's again.
    focus("outside");
    expect("editing" in send.mock.calls.at(-1)![0]).toBe(false);

    // The editor closes under the caret: no focus event says so, and the throttled flush sends that nothing is held...
    focus("text");
    expect(send.mock.calls.at(-1)![0].editing).toEqual(["toggle_sidebar", "open_search", "go_to_file", "find"]);
    document.getElementById("doc")!.remove();
    for (const off of offs) off();
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect("editing" in send.mock.calls.at(-1)![0]).toBe(false);
    expect(send.mock.calls.at(-1)![0].disabled).toEqual(expect.arrayContaining(["print", "export"]));
    // ...so the next document he clicks into is said, though it holds the same keys the last one did.
    const next = document.createElement("div");
    next.innerHTML = `<div data-editor-keys="document"><div id="text" tabindex="0"></div></div>`;
    document.body.append(next);
    const sentBefore = send.mock.calls.length;
    focus("text");
    expect(send.mock.calls.length).toBe(sentBefore + 1);
    expect(send.mock.calls.at(-1)![0].editing).toEqual(["toggle_sidebar", "open_search"]);
    publisher.stop();
    const after = send.mock.calls.length;
    focus("text");
    expect(send.mock.calls.length).toBe(after);
    document.body.innerHTML = "";
  });

  it("says Hide Message List while the list is open, Show once it folds", () => {
    messageListFold.set(false);
    const send = vi.fn();
    const publisher = publishMenuState(() => ({ dockOpen: false, dockUsable: true }), send);
    expect(send.mock.calls[0][0].open).toContain("toggle_message_list");
    messageListFold.toggle();
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].open).not.toContain("toggle_message_list");
    expect(send.mock.calls[1][0].disabled).not.toContain("toggle_message_list");
    publisher.stop();
    messageListFold.set(false);
  });

  it("greys Show Panel for a subagent on screen: its view has no panel", () => {
    metas = [meta({ id: "a" }), meta({ id: "child", parentId: "a" })];
    vi.spyOn(sessionStore, "metaOf").mockImplementation((id) => metas.find((m) => m.id === id) ?? null);
    rightPanel.visible("child", true);
    const send = vi.fn();
    publishMenuState(() => ({ dockOpen: false, dockUsable: true }), send).stop();
    expect(send.mock.calls[0][0].disabled).toContain("toggle_panel");
  });

  it("ticks Away from Computer as this machine's Away store moves", () => {
    resetAwayForTest();
    const send = vi.fn();
    const publisher = publishMenuState(() => ({ dockOpen: false, dockUsable: true }), send);
    expect(send.mock.calls[0][0].checked).toEqual({ toggle_away: false });
    const host = { state: { enabled: true, at: 5, by: "env_mac" }, decided: { since: 5, threads: [] } };
    awayStore.setState({ hosts: { [registry.primaryEnvironmentId]: host } });
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].checked).toEqual({ toggle_away: true });
    // The flip in flight wins over the host's last word.
    awayStore.setState({ pending: { enabled: false, at: 6, by: "" } });
    vi.advanceTimersByTime(MENU_STATE_THROTTLE_MS);
    expect(send.mock.calls[2][0].checked).toEqual({ toggle_away: false });
    publisher.stop();
    resetAwayForTest();
  });

  it("reads the facts again as the clock moves, for Archive Done's age rule", () => {
    const send = vi.fn();
    const publisher = publishMenuState(() => ({ dockOpen: false, dockUsable: true }), send);
    metas = [meta({ id: "a", status: "idle" })];
    vi.advanceTimersByTime(MENU_STATE_CLOCK_MS + MENU_STATE_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    publisher.stop();
  });
});
