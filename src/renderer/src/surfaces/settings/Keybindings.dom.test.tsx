// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mac = vi.hoisted(() => ({ on: true }));
vi.mock("../../lib/platform", () => ({
  get IS_MAC() {
    return mac.on;
  },
}));

const { KeybindingsPage } = await import("./Keybindings");
const { asWebPage } = await import("../../test/webMode");
const { setWorkOn, workSwitch } = await import("../../lib/workSwitch");

/** The desktop's capture key as main answers it. */
const capture = vi.hoisted(() => ({ set: vi.fn() }));
const state = { key: "Alt+Shift+Space", defaultKey: "Alt+Shift+Space", held: true, error: null as string | null, workOn: true };

beforeEach(() => {
  mac.on = true;
  capture.set.mockReset();
  capture.set.mockImplementation(async (key: string | null) => ({ ...state, key }));
  (window as unknown as { api: unknown }).api = { ...(window as unknown as { api?: object }).api, captureKey: { get: async () => state, set: capture.set } };
});
afterEach(() => {
  cleanup();
  act(() => workSwitch.reset());
});

const row = (name: string) =>
  [...document.querySelectorAll("[data-slot=page-row]")].find((el) => el.querySelector("[data-slot=item-title]")?.textContent === name);
const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("Shortcuts", () => {
  it("draws each chord as key caps in a section per group, the hosts' keys named for computers", () => {
    render(<KeybindingsPage />);
    expect(headings()).toEqual(["From any app", "App", "Tabs", "Computers", "Panes", "Terminal", "Files", "Editor"]);
    expect(row("Search")?.querySelectorAll("kbd[data-slot=kbd]")).toHaveLength(2);
    expect(row("Next Computer")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bHosts?\b/);
  });

  it("lists Find a setting under App, held in Settings", () => {
    render(<KeybindingsPage />);
    expect(row("Find a Setting")?.textContent).toContain("In Settings");
  });

  it("says the Appshot's double ⌘ is turned on in Appshots, on a Mac only", () => {
    render(<KeybindingsPage />);
    expect(row("Appshot")?.textContent).toContain("Turned on in Appshots");
    expect(row("Appshot")?.querySelectorAll("kbd[data-slot=kbd]")).toHaveLength(2);
    cleanup();
    mac.on = false;
    render(<KeybindingsPage />);
    expect(row("Appshot")).toBeUndefined();
  });

  it("records the capture key while Work is on for this computer, and saves it with the mark", async () => {
    render(<KeybindingsPage />);
    expect(row("Open capture")).toBeUndefined();
    cleanup();
    act(() => setWorkOn("local", true));
    render(<KeybindingsPage />);
    await act(async () => {});
    const button = row("Open capture")!.querySelector("button")!;
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    await act(async () => {});
    expect(capture.set).toHaveBeenCalledWith("Control+Alt+K");
    expect(row("Open capture")?.querySelector("[data-slot=save-mark]")?.getAttribute("data-state")).toBe("saved");
  });

  it("says a refused capture key on its row", async () => {
    act(() => setWorkOn("local", true));
    capture.set.mockImplementation(async () => ({ ...state, error: "Another app holds that key." }));
    render(<KeybindingsPage />);
    await act(async () => {});
    const button = row("Open capture")!.querySelector("button")!;
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    await act(async () => {});
    expect(row("Open capture")?.textContent).toContain("Another app holds that key.");
  });

  it("leaves From any app and the terminal's group out at /ui", () => {
    act(() => setWorkOn("local", true));
    const restore = asWebPage();
    try {
      render(<KeybindingsPage />);
      expect(headings()).not.toContain("Terminal");
      expect(headings()).not.toContain("From any app");
      expect(headings()).toContain("Tabs");
    } finally {
      restore();
    }
  });

  it("puts or between alternatives", () => {
    render(<KeybindingsPage />);
    const goToFile = row("Go to File");
    expect(goToFile?.querySelectorAll("[data-slot=kbd-group]")).toHaveLength(2);
    expect(goToFile?.textContent).toContain("or");
  });

  it("says where a scoped binding holds", () => {
    render(<KeybindingsPage />);
    expect(row("Split Right")?.textContent).toContain("Outside the editor");
  });

  it("finds a shortcut across every group, From any app too, and says so when nothing matches", () => {
    render(<KeybindingsPage />);
    const find = screen.getByRole("textbox", { name: "Find a shortcut" });
    fireEvent.change(find, { target: { value: "show or hide" } });
    expect(headings()).toEqual(["Terminal"]);
    fireEvent.change(find, { target: { value: "appshot" } });
    expect(headings()).toEqual(["From any app"]);
    fireEvent.change(find, { target: { value: "zzz" } });
    expect(screen.getByText("No shortcut matches")).toBeTruthy();
    expect(document.querySelector("[data-slot=page-row]")).toBeNull();
  });
});
