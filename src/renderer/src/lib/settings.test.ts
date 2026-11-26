import "../work/files/bindings";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEALTH_PAGES } from "@shared/work/health";
import {
  filterKeybindings,
  isSettingsSectionId,
  KEYBINDING_GROUPS,
  KEYBINDING_SCOPE_LABEL,
  loadSettingsSection,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  visibleSettingsSections,
  visibleKeybindingGroups,
  settingsSectionLabel,
  settingsSectionTitle,
  settingsSectionDescription,
  settingsGroupLabel,
  settingsPageOf,
  computerOfSection,
  computerSettingsSection,
  type SettingsSectionId,
  loadMidTurnDefault,
  MID_TURN_DEFAULT,
  saveMidTurnDefault,
} from "./settings";


function mockLocalStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
}

describe("settings sections", () => {
  it("puts every section in exactly one known group", () => {
    const groups = new Set<string>(SETTINGS_GROUPS.map((group) => group.id));
    for (const section of SETTINGS_SECTIONS) expect(groups.has(section.group)).toBe(true);
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists each group's pages together, in the groups' order", () => {
    const order = SETTINGS_SECTIONS.map((section) => SETTINGS_GROUPS.findIndex((group) => group.id === section.group));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("names a group for what a row in it changes, in this window's words", () => {
    const mac = { web: false, platform: "darwin" };
    expect((["mac", "every", "others", "work"] as const).map((id) => settingsGroupLabel(id, mac))).toEqual(["This Mac", "Everywhere", "Other computers", "Work"]);
    expect(settingsGroupLabel("mac", { ...mac, platform: "win32" })).toBe("This PC");
    // The box's web page: the window is a browser, and the one computer is the one that serves it.
    expect(settingsGroupLabel("mac", { web: true, platform: "" })).toBe("This browser");
    expect(settingsGroupLabel("others", { web: true, platform: "" })).toBe("Computers");
    // One word for the shared set in every window: a scope, never a list of machines.
    expect(settingsGroupLabel("every", { web: true, platform: "" })).toBe("Everywhere");
    expect(settingsGroupLabel("last", mac)).toBe("");
  });

  it("lists Add-ons then Skills among the shared pages, on every surface", () => {
    const every = SETTINGS_SECTIONS.filter((section) => section.group === "every").map((section) => section.id);
    expect(every).toEqual(["defaults", "reviews", "orchestration", "away", "addons", "skills", "sync", "accounts"]);
    expect(settingsSectionLabel("addons")).toBe("Add-ons");
    expect(settingsSectionLabel("skills")).toBe("Skills");
    for (const id of ["addons", "skills"]) expect(SETTINGS_SECTIONS.find((section) => section.id === id)?.desktopOnly).toBeUndefined();
  });

  it("holds this Mac's pages together: the app's, then the computer's, Computer use only on a Mac", () => {
    const ids = (web: boolean, mac: boolean) => visibleSettingsSections(web, mac).filter((s) => s.group === "mac").map((section) => section.id);
    expect(ids(false, true)).toEqual(["general", "appearance", "editor", "keybindings", "updates", "appshots", "computer", "here", "sharing"]);
    // Sync shows once there is another computer to keep in step.
    expect(visibleSettingsSections(false, true).map((s) => s.id)).not.toContain("sync");
    expect(visibleSettingsSections(false, true, false, { others: true }).map((s) => s.id)).toContain("sync");
    expect(settingsSectionLabel("computer")).toBe("Computer use");
    expect(ids(false, false)).not.toContain("computer");
    expect(ids(false, false)).toContain("appshots");
  });

  it("shows a browser at /ui what a browser has: no page about a computer it is not", () => {
    const ids = visibleSettingsSections(true, false, true, { winvm: true }).map((section) => section.id);
    expect(ids.slice(0, 4)).toEqual(["general", "appearance", "editor", "keybindings"]);
    for (const id of ["updates", "appshots", "computer", "here", "sharing", "publish", "sync", "accounts"]) expect(ids).not.toContain(id);
    expect(ids).toContain("skills");
    expect(ids).toContain("away");
  });

  it("offers Publish and the Windows VM only where there is one", () => {
    const ids = (has: { publish?: boolean; winvm?: boolean }) => visibleSettingsSections(false, true, true, has).map((section) => section.id);
    expect(ids({})).not.toContain("publish");
    expect(ids({})).not.toContain("winvm");
    expect(ids({ publish: true, winvm: true })).toEqual(expect.arrayContaining(["publish", "winvm"]));
    // Publishing is a Mac's job.
    expect(visibleSettingsSections(false, false, true, { publish: true }).map((s) => s.id)).not.toContain("publish");
  });

  it("lists Work's own pages after the Work page, only while Work is on somewhere", () => {
    const ids = (work: boolean) => visibleSettingsSections(false, true, work).filter((s) => s.group === "work").map((section) => section.id);
    expect(ids(false)).toEqual(["work"]);
    expect(ids(true)).toEqual(["work", "digest", "mail", "files", "connections"]);
    expect(settingsSectionLabel("connections")).toBe("Connections");
    // Its row is Setup; its page is still Work.
    expect(settingsSectionLabel("work")).toBe("Setup");
    expect(settingsSectionTitle("work")).toBe("Work");
  });

  it("stands Archive last, alone", () => {
    expect(SETTINGS_SECTIONS.at(-1)?.id).toBe("archive");
    expect(SETTINGS_SECTIONS.filter((section) => section.group === "last").map((s) => s.id)).toEqual(["archive"]);
  });

  it("titles a page by its row, or by its own fuller name, in this window's words", () => {
    expect(settingsSectionTitle("here", "darwin")).toBe("Threads on this Mac");
    expect(settingsSectionTitle("here", "win32")).toBe("Threads on this PC");
    expect(settingsSectionTitle("sharing")).toBe("Sharing");
    expect(settingsSectionDescription("sharing", "win32")).toBe("Who and what may reach this PC.");
    expect(settingsSectionLabel("keybindings")).toBe("Shortcuts");
    expect(settingsSectionLabel("defaults")).toBe("New threads");
    expect(settingsSectionLabel("orchestration")).toBe("Subagents");
  });

  // Every id Settings was ever asked for keeps a page: a stored id, a link from the rail or a view, a fix a computer sends.
  const STORED_OR_SENT = ["general", "appearance", "editor", "keybindings", "remote", "environments", "defaults", "providers", "addons", "skills", "orchestration", "reviews", "appshots", "computer", "archive", "work", "connections"];
  // The callers listed in the plan's inventory ("Inbound Settings links"), and src/shared/work/health.ts HEALTH_PAGES.
  const INBOUND = ["remote", "archive", "editor", "appshots", "defaults", "connections", "work", "ws:w1"];
  const HOST_SENT = HEALTH_PAGES.filter((page) => page.startsWith("settings:")).map((page) => page.slice("settings:".length));

  it("keeps a page for every old id, every inbound link and every page a computer can send", () => {
    const pages = new Set<string>(SETTINGS_SECTIONS.map((section) => section.id));
    for (const id of [...STORED_OR_SENT, ...INBOUND, ...HOST_SENT]) {
      expect(isSettingsSectionId(id), id).toBe(true);
      const page = settingsPageOf(id as SettingsSectionId);
      expect(pages.has(page) || page.startsWith("ws:"), `${id} → ${page}`).toBe(true);
    }
    expect(HOST_SENT).toEqual(expect.arrayContaining(["work", "remote", "connections", "files", "winvm"]));
    // A fix that means the Windows VM or Files lands on that page, not on Work.
    expect(settingsPageOf("files" as SettingsSectionId)).toBe("files");
    expect(settingsPageOf("winvm" as SettingsSectionId)).toBe("winvm");
  });

  it("opens Sharing for the old Hosts and Environments ids, and Threads for Providers", () => {
    expect(settingsPageOf("remote")).toBe("sharing");
    expect(settingsPageOf("environments")).toBe("sharing");
    expect(settingsPageOf("providers")).toBe("here");
    expect(settingsSectionLabel("remote")).toBe("Sharing");
    mockLocalStorage();
    localStorage.setItem("docket.settingsSection", "environments");
    expect(loadSettingsSection()).toBe("sharing");
    localStorage.setItem("docket.settingsSection", "providers");
    expect(loadSettingsSection()).toBe("here");
  });

  it("takes a workspace's and another computer's page by id, and refuses an empty one", () => {
    expect(isSettingsSectionId("ws:w1")).toBe(true);
    expect(isSettingsSectionId("computer:env_box")).toBe(true);
    expect(isSettingsSectionId("ws:")).toBe(false);
    expect(isSettingsSectionId("computer:")).toBe(false);
    expect(computerOfSection(computerSettingsSection("env_box"))).toBe("env_box");
    expect(computerOfSection("general")).toBeNull();
  });

  it("has no Build page; a saved one loads as the default", () => {
    expect(SETTINGS_SECTIONS.some((section) => (section.id as string) === "build")).toBe(false);
    mockLocalStorage();
    localStorage.setItem("docket.settingsSection", "build");
    expect(loadSettingsSection()).toBe("general");
  });
});

describe("keybindings", () => {
  const all = KEYBINDING_GROUPS.flatMap((group) => group.bindings);

  it("gives every binding at least one chord of caps", () => {
    for (const binding of all) {
      expect(binding.keys.length).toBeGreaterThan(0);
      for (const chord of binding.keys) {
        expect(chord.length).toBeGreaterThan(0);
        for (const cap of chord) expect(cap).not.toMatch(/\+$/);
      }
    }
  });

  it("says where a binding holds in words, never code", () => {
    for (const binding of all) {
      // plain words; one may be a name ("In Work search")
      if (binding.scope) expect(KEYBINDING_SCOPE_LABEL[binding.scope]).toMatch(/^[A-Z][a-z]*( [A-Za-z][a-z]*)*$/);
    }
    expect(JSON.stringify(KEYBINDING_GROUPS)).not.toMatch(/editorFocus|deckLayout|Always/);
  });

  it("filters by name, by group and by keys", () => {
    expect(filterKeybindings(KEYBINDING_GROUPS, "symbol").flatMap((g) => g.bindings.map((b) => b.name))).toEqual([
      "Go to Symbol",
    ]);
    expect(filterKeybindings(KEYBINDING_GROUPS, "terminal").map((g) => g.title)).toEqual(["Terminal"]);
    const byKeys = filterKeybindings(KEYBINDING_GROUPS, "ctrl k").flatMap((g) => g.bindings.map((b) => b.name));
    const byGlyph = filterKeybindings(KEYBINDING_GROUPS, "⌘K").flatMap((g) => g.bindings.map((b) => b.name));
    expect([...byKeys, ...byGlyph]).toContain("Search");
    expect(filterKeybindings(KEYBINDING_GROUPS, "nothing like this")).toEqual([]);
  });

  it("lists the Files place's chords apart from the file tree's, only while Work is on", () => {
    const titles = (work: boolean) => visibleKeybindingGroups(false, work).map((group) => group.title);
    expect(titles(false)).not.toContain("Files (Work)");
    expect(titles(true)).toContain("Files (Work)");
    expect(titles(true)).toContain("Files");
    const files = KEYBINDING_GROUPS.find((group) => group.title === "Files (Work)");
    expect(files?.bindings.map((binding) => binding.name)).toEqual(["New Tab", "Close Tab", "Reopen Closed Tab", "Next Tab", "Previous Tab", "Back", "Forward", "Go to", "Search", "Open", "Quick Look", "Parent Folder", "New Folder", "Rename", "Delete", "Select All", "Leave Full Window"]);
  });
});

describe("mid-turn default", () => {
  beforeEach(() => {
    mockLocalStorage();
  });

  it("is steer: a follow-up reaches the running turn", () => {
    expect(MID_TURN_DEFAULT).toBe("steer");
    expect(loadMidTurnDefault()).toBe("steer");
  });

  it("a stored preference wins either way", () => {
    saveMidTurnDefault("queue");
    expect(loadMidTurnDefault()).toBe("queue");
    saveMidTurnDefault("steer");
    expect(loadMidTurnDefault()).toBe("steer");
    localStorage.setItem("docket.midTurnDefault", "nonsense");
    expect(loadMidTurnDefault()).toBe("steer");
  });
});
