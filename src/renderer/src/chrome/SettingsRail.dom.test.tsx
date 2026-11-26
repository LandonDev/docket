// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry, type Environment } from "../lib/connection";
import type { WorkspaceMeta } from "../lib/tcserver/types";
import { SettingsNav, workspaceHint } from "./SettingsRail";
import { asWebPage } from "../test/webMode";
import { focusSettingsSearch, settingsSearch } from "../lib/settings/searchStore";
import { tellSettingsList } from "../lib/settings/useListWindow";

const workspaces = vi.hoisted(() => ({ list: [] as WorkspaceMeta[] }));
vi.mock("../lib/tcserver/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tcserver/workspaces")>()),
  useWorkspaces: () => workspaces.list,
}));

const env = (id: string, name: string): Environment => ({ id, name, routes: [], credentialRef: null });
const ws = (id: string, name: string, environmentId: string): WorkspaceMeta =>
  ({ id, name, path: `/w/${id}`, environmentId, createdAt: 1 }) as WorkspaceMeta;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  settingsSearch.clear();
  tellSettingsList({ addComputer: null, vmOn: null, has: { publish: false, winvm: false } });
});

function hosts(environments: Environment[]) {
  vi.spyOn(registry, "environmentsSnapshot").mockReturnValue(environments);
  vi.spyOn(registry, "primaryEnvironmentId", "get").mockReturnValue("local");
}

describe("SettingsNav", () => {
  it("marks the page on screen with aria-current and goes to another on a click", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [];
    const onSelect = vi.fn();
    render(<SettingsNav section="general" onSelect={onSelect} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(onSelect).toHaveBeenCalledWith("appearance");
  });

  it("leaves a Mac's own pages out of a window that is not a Mac's desktop: no Appshots at /ui or on a PC", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [];
    // jsdom's window has no platform: it is no Mac (lib/settings.test.ts holds the Mac's list).
    render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Appshots" })).toBeNull();
    expect(screen.getByRole("button", { name: "Updates" })).toBeTruthy();
    cleanup();
    const restore = asWebPage();
    try {
      render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
      expect(screen.queryByRole("button", { name: "Appshots" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Updates" })).toBeNull();
      expect(screen.getByRole("button", { name: "Reviews" })).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("names another host's workspace as muted trailing text, never after a middle dot", () => {
    hosts([env("local", "This Mac"), env("env_box", "box")]);
    workspaces.list = [ws("w1", "temp-code", "local"), ws("w2", "temp-code", "env_box")];
    const { container } = render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    const rows = [...container.querySelectorAll('[aria-labelledby="settings-group-workspaces"] [data-rail-row]')];
    expect(rows.map((r) => r.querySelector("[data-rail-trailing]")?.textContent ?? null)).toEqual([null, "box"]);
    expect(container.textContent).not.toContain("·");
  });

  it("names a workspace as the rail does: the name Customize set, else its own", async () => {
    const { saveTabGroupLabel } = await import("../lib/tabGroups");
    hosts([env("local", "This Mac")]);
    workspaces.list = [ws("w1", "temp-code", "local"), ws("w2", "lifeos", "local")];
    saveTabGroupLabel("w1", "Alpha");
    try {
      const { container } = render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
      const rows = [...container.querySelectorAll('[aria-labelledby="settings-group-workspaces"] [data-rail-row]')];
      expect(rows.map((r) => r.textContent)).toEqual(["Alpha", "lifeos"]);
    } finally {
      saveTabGroupLabel("w1", "");
    }
  });

  it("tells two workspaces of one name on one host apart by their parent folder, and says nothing without a collision", () => {
    hosts([env("local", "This Mac"), env("env_box", "box")]);
    workspaces.list = [
      { ...ws("w1", "app", "local"), path: "/Users/me/work/app" },
      { ...ws("w2", "app", "local"), path: "/Users/me/old/app" },
      ws("w3", "solo", "local"),
      { ...ws("w4", "app", "env_box"), path: "/srv/app" },
    ];
    const { container } = render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    const rows = [...container.querySelectorAll('[aria-labelledby="settings-group-workspaces"] [data-rail-row]')];
    // The host still wins on another host's row.
    expect(rows.map((r) => r.querySelector("[data-rail-trailing]")?.textContent ?? null)).toEqual(["work", "old", null, "box"]);
  });

  it("names the parent's path as far as it differs, and the whole path when the parents are one folder", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [
      { ...ws("w1", "app", "local"), path: "/Users/me/work/app" },
      { ...ws("w2", "app", "local"), path: "/Users/you/work/app" },
      { ...ws("w3", "site", "local"), path: "/srv/site" },
      { ...ws("w4", "site", "local"), path: "/srv/site/" },
    ];
    const { container } = render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    const rows = [...container.querySelectorAll('[aria-labelledby="settings-group-workspaces"] [data-rail-row]')];
    expect(rows.map((r) => r.querySelector("[data-rail-trailing]")?.textContent ?? null)).toEqual([
      "me/work",
      "you/work",
      "/srv/site",
      "/srv/site/",
    ]);
  });

  it("workspaceHint: no twin, no hint; a parent that differs by name, its name", () => {
    const a = { ...ws("a", "x", "local"), path: "/p/one/x" };
    const b = { ...ws("b", "x", "local"), path: "/p/two/x" };
    expect(workspaceHint(a, [])).toBeNull();
    expect(workspaceHint(a, [b])).toBe("one");
  });

  it("ends in Back at the foot", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [];
    const onClose = vi.fn();
    render(<SettingsNav section="general" onSelect={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  const headings = (container: HTMLElement) => [...container.querySelectorAll('[role="group"]')].map((group) => group.getAttribute("aria-label") ?? document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent);

  it("groups the list by place: this Mac, every computer, each other computer, with Archive last and alone", () => {
    hosts([env("local", "This Mac"), env("env_box", "The box")]);
    workspaces.list = [ws("w1", "temp-code", "env_box")];
    const { container } = render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    expect(headings(container)).toEqual(["This Mac", "Everywhere", "Other computers", "Work", "Code workspaces"]);
    const rows = (group: string) => [...container.querySelectorAll(`[aria-labelledby="settings-group-${group}"] [data-rail-row]`)].map((row) => row.textContent);
    expect(rows("mac")).toEqual(["General", "Appearance", "Editor", "Shortcuts", "Updates", "Threads", "Sharing"]);
    expect(rows("every")).toEqual(["New threads", "Reviews", "Subagents", "Away", "Add-ons", "Skills", "Sync", "AI accounts"]);
    expect(rows("others")).toEqual(["The box"]);
    // Archive stands alone in the foot, over Back, under the one hairline: no workspace's neighbour.
    const foot = screen.getByRole("button", { name: "Back" }).closest("div.border-t")!;
    expect([...foot.querySelectorAll("[data-rail-row]")].map((row) => row.textContent)).toEqual(["Archive", "Back"]);
    expect(container.querySelector('[aria-label="Settings"]')?.textContent).not.toContain("Archive");
  });

  it("opens another computer's own page from its row", () => {
    hosts([env("local", "This Mac"), env("env_box", "The box")]);
    workspaces.list = [];
    const onSelect = vi.fn();
    render(<SettingsNav section="computer:env_box" onSelect={onSelect} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "The box" }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Sharing" }));
    expect(onSelect).toHaveBeenCalledWith("sharing");
  });

  it("marks the page an old id became: a link to Hosts lands on Sharing", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [];
    render(<SettingsNav section="remote" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Sharing" }).getAttribute("aria-current")).toBe("true");
  });

  it("calls the shared set Everywhere on a Mac with no other computer too, with no Sync to show", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [];
    const { container } = render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    expect(headings(container)).toEqual(["This Mac", "Everywhere", "Other computers", "Work"]);
    expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
  });

  it("heads the box's web page This browser and Computers", () => {
    hosts([env("web", "The box")]);
    vi.spyOn(registry, "primaryEnvironmentId", "get").mockReturnValue("web");
    workspaces.list = [];
    const restore = asWebPage();
    try {
      const { container } = render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
      expect(headings(container)).toEqual(["This browser", "Everywhere", "Computers", "Work"]);
      expect(container.querySelector('[aria-labelledby="settings-group-others"] [data-rail-row]')?.textContent).toBe("The box");
      expect(screen.queryByRole("button", { name: "Sharing" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("offers Add a computer… at the foot of the other computers once its dialog is there, and Publish and the Windows VM where there is one", () => {
    hosts([env("local", "This Mac"), env("env_box", "The box")]);
    workspaces.list = [];
    render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Add a computer…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    const add = vi.fn();
    act(() => tellSettingsList({ addComputer: add, has: { publish: true } }));
    fireEvent.click(screen.getByRole("button", { name: "Add a computer…" }));
    expect(add).toHaveBeenCalledOnce();
  });

  it("has a search field over the list; while something is typed no row is the current one", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [];
    render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    const field = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(field, { target: { value: "away" } });
    expect(settingsSearch.get().query).toBe("away");
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBeNull();
  });

  it("types in the field's own ink, and offers Clear search only while something is typed", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [];
    render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    const field = screen.getByRole("searchbox", { name: "Search settings" });
    expect(field.className).toContain("text-foreground");
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.change(field, { target: { value: "away" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(settingsSearch.get().query).toBe("");
    expect(document.activeElement).toBe(field);
  });

  it("clears what was typed when a row is pressed, so the list shows where he is", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [];
    const onSelect = vi.fn();
    render(<SettingsNav section="general" onSelect={onSelect} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "away" } });
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    expect(settingsSearch.get().query).toBe("");
    expect(onSelect).toHaveBeenCalledWith("editor");
  });

  it("takes the caret on ⌘F's ask", () => {
    hosts([env("local", "This Mac")]);
    workspaces.list = [];
    render(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    act(() => focusSettingsSearch());
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });
});
