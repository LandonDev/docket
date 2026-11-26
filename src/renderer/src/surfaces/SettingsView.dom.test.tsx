// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stub = (name: string) => () => <div data-page={name} />;
vi.mock("./settings/General", () => ({ GeneralPage: stub("general") }));
vi.mock("./settings/Updates", () => ({ UpdatesPage: stub("updates") }));
vi.mock("./settings/Computer", () => ({ ComputerPage: stub("computer") }));
vi.mock("./settings/ThreadDefaults", () => ({ ThreadDefaultsPage: stub("defaults") }));
vi.mock("./settings/Appearance", () => ({ AppearancePage: stub("appearance") }));
vi.mock("./settings/Editor", () => ({ EditorPage: stub("editor") }));
vi.mock("./settings/Keybindings", () => ({ KeybindingsPage: stub("keybindings") }));
vi.mock("./settings/computers/ThreadsPage", () => ({ ThreadsPage: stub("here") }));
vi.mock("./settings/computers/SharingPage", () => ({ SharingPage: stub("sharing") }));
vi.mock("./settings/computers/SyncPage", () => ({ SyncPage: stub("sync"), SyncLine: () => "This Mac keeps the box the same as itself." }));
vi.mock("./settings/computers/PublishPage", () => ({ PublishPage: stub("publish"), usePublishKnown: () => {} }));
vi.mock("./settings/computers/Winvm", () => ({ WinvmPage: stub("winvm"), useWinvmKnown: () => {} }));
vi.mock("./settings/computers/ComputerPage", () => ({ OtherComputerPage: stub("computer-page"), ComputerLine: () => "Connected at docket.landonhale.com." }));
vi.mock("./settings/computers/MaySheet", () => ({ MaySheetHost: () => null }));
vi.mock("./settings/Work", () => ({ WorkPage: stub("work") }));
vi.mock("./settings/Workspace", () => ({ WorkspacePage: stub("workspace") }));
vi.mock("./settings/Orchestration", () => ({ OrchestrationPage: stub("orchestration") }));
vi.mock("./settings/Archive", () => ({ ArchivePage: stub("archive") }));
vi.mock("@aliax/pages", () => ({ AccountsPage: () => <div data-testid="accounts-page" /> }));
vi.mock("./ReviewSettings", () => ({ ReviewsPage: stub("reviews") }));
vi.mock("./AppshotsSettings", () => ({ AppshotsPage: stub("appshots") }));
vi.mock("./settings/addons/AddonsPage", () => ({ AddonsPage: stub("addons") }));
vi.mock("./settings/skills/SkillsPage", () => ({ SkillsPage: stub("skills") }));
vi.mock("../lib/tcserver/workspaces", async (original) => ({ ...(await original<typeof import("../lib/tcserver/workspaces")>()), useWorkspaces: () => [] }));
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));

const { SettingsView } = await import("./SettingsView");
const { asWebPage } = await import("../test/webMode");
const { useState } = await import("react");
const { shell, shellStore } = await import("../stores/shell");
const { settingsSearch, FOCUS_SEARCH_EVENT } = await import("../lib/settings/searchStore");
const { requestSettings, OPEN_SETTINGS_EVENT, peekSettingsRow: peekRow } = await import("../lib/monaco/debugTab");
const { FOUND_HOLD_MS } = await import("../lib/settings/reveal");
const { useSettingsKnown } = await import("../lib/settings/useListWindow");
const { openAddComputer } = await import("../lib/settings/addComputer");

// jsdom has no scrolling: the results' highlight and a found row ask for it.
Element.prototype.scrollIntoView = () => {};

/** What App.tsx does with a request for Settings: open the page. The row asked for is the page's to take. */
const opened: { section: string; row: string | null }[] = [];
window.addEventListener(OPEN_SETTINGS_EVENT, (event) => {
  const section = (event as CustomEvent<string>).detail;
  opened.push({ section, row: peekRow() });
  shell.openSettings(section as never);
});

const noop = () => {};
const view = () => (
  <SettingsView
    cwd="/tmp"
    onOpenSession={noop}
    onArchiveSession={noop}
    onDeleteSession={noop}
    onOpenWhatsNew={noop}
  />
);

beforeEach(() => {
  opened.length = 0;
  act(() => shell.openSettings("general"));
});
afterEach(cleanup);

describe("SettingsView", () => {
  it("names the page once, with its description under it", () => {
    render(view());
    expect(screen.getAllByText("General")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("General");
    act(() => shell.openSettings("sharing"));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sharing");
    expect(screen.getByText("Who and what may reach this Mac.")).toBeTruthy();
  });

  it("says where a job or a code workspace is under its title: its sector or its folder, on its computer", async () => {
    const { workspaceLine } = await import("./SettingsView");
    expect(workspaceLine({ kind: "work", path: "/home/work/Purdue Esports", sector: "purdue" }, "the box")).toBe("Purdue, on the box");
    expect(workspaceLine({ kind: "work", path: "/home/work/Site", sector: null }, "the box")).toBe("On the box");
    expect(workspaceLine({ kind: "code", path: "/tmp/temp-code" }, "this Mac")).toBe("/tmp/temp-code, on this Mac");
    expect(workspaceLine({ kind: "work", path: "/home/work/Purdue Esports" })).toBeUndefined();
    expect(workspaceLine(undefined)).toBe("This workspace was removed.");
  });

  it("shows the desktop-only line for a stored Appshots route at /ui, and the page on the desktop", () => {
    act(() => shell.openSettings("appshots"));
    render(view());
    expect(document.querySelector("[data-page=appshots]")).not.toBeNull();
    cleanup();
    const restore = asWebPage();
    try {
      render(view());
      expect(document.querySelector("[data-page=appshots]")).toBeNull();
      expect(screen.getByText("Available in the desktop app").closest("[data-slot=empty]")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("loads the Accounts page inside desktop Settings", async () => {
    act(() => shell.openSettings("accounts"));
    render(view());
    expect(await screen.findByTestId("accounts-page")).toBeTruthy();
  });

  it("routes Updates to its own page, and leaves Updates and Computer use out at /ui", () => {
    act(() => shell.openSettings("updates"));
    render(view());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Updates");
    expect(document.querySelector("[data-page=updates]")).not.toBeNull();
    expect(document.querySelector("[data-page=general]")).toBeNull();
    cleanup();
    const restore = asWebPage();
    try {
      for (const page of ["updates", "computer"] as const) {
        act(() => shell.openSettings(page));
        render(view());
        expect(document.querySelector(`[data-page=${page}]`)).toBeNull();
        expect(screen.getByText("Available in the desktop app")).toBeTruthy();
        cleanup();
      }
    } finally {
      restore();
    }
  });

  it("leaves Computer use out in a window off macOS", () => {
    const was = (window as { api?: unknown }).api;
    (window as { api?: unknown }).api = { ...(was as object), platform: "win32" };
    try {
      act(() => shell.openSettings("computer"));
      render(view());
      expect(document.querySelector("[data-page=computer]")).toBeNull();
      expect(screen.getByText("Available on a Mac")).toBeTruthy();
    } finally {
      (window as { api?: unknown }).api = was;
    }
  });

  it("opens Sharing for a link that still asks for Hosts", () => {
    act(() => shell.openSettings("remote"));
    render(view());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sharing");
    expect(document.querySelector("[data-page=sharing]")).toBeTruthy();
  });

  it("routes each of this Mac's machine pages to its own page, the Windows VM off the Work page", () => {
    for (const page of ["here", "sharing", "sync", "publish", "winvm"] as const) {
      act(() => shell.openSettings(page));
      render(view());
      expect(document.querySelector(`[data-page=${page}]`), page).toBeTruthy();
      expect(document.querySelector("[data-page=work]"), page).toBeNull();
      cleanup();
    }
    act(() => shell.openSettings("providers"));
    render(view());
    expect(document.querySelector("[data-page=here]")).toBeTruthy();
  });

  it("draws Sync's own line under its title", () => {
    act(() => shell.openSettings("sync"));
    render(view());
    expect(screen.getByText("This Mac keeps the box the same as itself.")).toBeTruthy();
  });

  it("holds Add a computer…: the list's row opens the dialog, a page's Add… opens it on a way, and /ui offers none", async () => {
    // The list's row presses what Settings told it (chrome/SettingsRail.tsx draws the row only while it is told).
    function ListRow() {
      const { addComputer } = useSettingsKnown();
      return addComputer ? <button onClick={addComputer}>Add a computer…</button> : null;
    }
    const first = render(
      <>
        {view()}
        <ListRow />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add a computer…" }));
    expect((await screen.findByRole("dialog", { name: "Add a computer" })).getAttribute("data-add-computer")).toBe("choose");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => openAddComputer({ way: "link" }));
    expect((await screen.findByRole("dialog")).getAttribute("data-add-computer")).toBe("link");
    first.unmount();
    // Settings closed: the row has nothing to press.
    render(<ListRow />);
    expect(screen.queryByRole("button", { name: "Add a computer…" })).toBeNull();
    cleanup();
    const restore = asWebPage();
    try {
      render(
        <>
          {view()}
          <ListRow />
        </>,
      );
      expect(screen.queryByRole("button", { name: "Add a computer…" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("titles Threads by its computer", () => {
    act(() => shell.openSettings("here"));
    render(view());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Threads on this Mac");
  });

  it("routes Add-ons and Skills to their pages", () => {
    act(() => shell.openSettings("addons"));
    render(view());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Add-ons");
    expect(document.querySelector("[data-page=addons]")).toBeTruthy();
    cleanup();
    act(() => shell.openSettings("skills"));
    render(view());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Skills");
    expect(document.querySelector("[data-page=skills]")).toBeTruthy();
  });

  it("opens each section at its top, with the scroller's gutter held", () => {
    render(view());
    const scroller = () => document.querySelector("[data-slot=page]")!.parentElement as HTMLElement;
    expect(scroller().className).toContain("[scrollbar-gutter:stable]");
    scroller().scrollTop = 400;
    const before = scroller();
    act(() => shell.openSettings("editor"));
    expect(scroller()).not.toBe(before);
    expect(scroller().scrollTop).toBe(0);
  });

  it("closes on Escape", () => {
    render(view());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shellStore.getState().settingsOpen).toBe(false);
  });

  it("leaves Escape to a dialog that has focus", () => {
    render(
      <>
        {view()}
        <div role="dialog">
          <input aria-label="Name" />
        </div>
      </>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" });
    expect(shellStore.getState().settingsOpen).toBe(true);
  });

  it("lets a focused field take Escape: the edit is undone, the field lets go, Settings stays", () => {
    function Field() {
      const [value, setValue] = useState("box");
      return <input aria-label="Host name" value={value} onChange={(event) => setValue(event.target.value)} />;
    }
    render(
      <>
        {view()}
        <Field />
      </>,
    );
    const field = screen.getByRole("textbox", { name: "Host name" }) as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: "box two" } });
    expect(field.value).toBe("box two");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("box");
    expect(document.activeElement).not.toBe(field);
    expect(shellStore.getState().settingsOpen).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(shellStore.getState().settingsOpen).toBe(false);
  });
});

describe("search in Settings", () => {
  afterEach(() => act(() => settingsSearch.clear()));

  it("replaces the page with results while something is typed, and brings it back when cleared", () => {
    render(view());
    act(() => settingsSearch.setQuery("away"));
    // The field beside it says what was typed: the title does not say it again.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Results");
    expect(document.querySelector("[data-page=general]")).toBeNull();
    expect(screen.getAllByRole("option")[0].textContent).toContain("Away");
    act(() => settingsSearch.clear());
    expect(document.querySelector("[data-page=general]")).not.toBeNull();
  });

  it("says so when nothing matches", () => {
    render(view());
    act(() => settingsSearch.setQuery("zzzz"));
    expect(screen.getByText("Nothing in Settings matches “zzzz”")).toBeTruthy();
  });

  it("moves the highlight with the arrows from the field and opens it with Enter", () => {
    render(
      <>
        <input data-settings-search="" aria-label="Search settings" />
        {view()}
      </>,
    );
    const field = screen.getByRole("textbox", { name: "Search settings" });
    field.focus();
    act(() => settingsSearch.setQuery("largest"));
    const selected = () => screen.getAllByRole("option").findIndex((option) => option.getAttribute("aria-selected") === "true");
    expect(selected()).toBe(0);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(selected()).toBe(screen.getAllByRole("option").length - 1);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(selected()).toBe(0);
    fireEvent.keyDown(field, { key: "Enter" });
    // The result's page opens with its row asked for, and the field is clean.
    expect(settingsSearch.get().query).toBe("");
    expect(opened).toEqual([{ section: "here", row: "here.attachment" }]);
  });

  it("opens a result on a click", () => {
    render(view());
    act(() => settingsSearch.setQuery("ghost text"));
    fireEvent.click(screen.getAllByRole("option")[0]);
    expect(opened).toEqual([{ section: "editor", row: "editor.inline" }]);
  });

  it("clears the field on Escape, and closes Settings on the next from an empty field", () => {
    render(
      <>
        <input data-settings-search="" aria-label="Search settings" />
        {view()}
      </>,
    );
    const field = screen.getByRole("textbox", { name: "Search settings" });
    field.focus();
    act(() => settingsSearch.setQuery("away"));
    fireEvent.keyDown(field, { key: "Escape" });
    expect(settingsSearch.get().query).toBe("");
    expect(shellStore.getState().settingsOpen).toBe(true);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(shellStore.getState().settingsOpen).toBe(false);
  });

  it("asks the search field for the caret on ⌘F, and leaves ⌘F to a dialog", () => {
    const asked = vi.fn();
    window.addEventListener(FOCUS_SEARCH_EVENT, asked);
    render(
      <>
        {view()}
        <div role="dialog">
          <input aria-label="Name" />
        </div>
      </>,
    );
    const key = new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(key));
    expect(asked).toHaveBeenCalledOnce();
    expect(key.defaultPrevented).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "f", metaKey: true });
    expect(asked).toHaveBeenCalledOnce();
    window.removeEventListener(FOCUS_SEARCH_EVENT, asked);
  });
});

describe("a row that was asked for", () => {
  it("is scrolled to and holds its fill for 900 ms once its page has drawn it", async () => {
    vi.useFakeTimers();
    render(view());
    const page = document.querySelector("[data-page=general]")!;
    act(() => requestSettings("general", "general.sounds"));
    // The page draws the row late (a chunk, its computer's answer).
    const row = document.createElement("div");
    row.setAttribute("data-setting", "general.sounds");
    row.scrollIntoView = vi.fn();
    await act(async () => {
      page.append(row);
      await Promise.resolve();
    });
    expect(row.hasAttribute("data-found")).toBe(true);
    await act(async () => vi.advanceTimersByTime(FOUND_HOLD_MS + 1));
    expect(row.hasAttribute("data-found")).toBe(false);
    vi.useRealTimers();
  });
});
