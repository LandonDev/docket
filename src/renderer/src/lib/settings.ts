import { joinCaps, keyCaps } from "./keys";
import { requestSettings } from "./monaco/debugTab";

const SECTION_KEY = "docket.settingsSection";

/** The fixed pages. `here` is "Threads on this Mac"; `orchestration` is Subagents, `defaults` New threads and
 *  `keybindings` Shortcuts: an id outlives its page's name, so every stored or sent id keeps its page. */
export type StaticSettingsSectionId =
  | "general"
  | "appearance"
  | "editor"
  | "keybindings"
  | "updates"
  | "appshots"
  | "computer"
  | "here"
  | "sharing"
  | "publish"
  | "defaults"
  | "reviews"
  | "orchestration"
  | "away"
  | "addons"
  | "skills"
  | "sync"
  | "accounts"
  | "winvm"
  | "work"
  | "digest"
  | "mail"
  | "files"
  | "connections"
  | "archive";

/** A page: a fixed one, one workspace's own (`ws:<workspace id>`) or another computer's (`computer:<environment id>`). */
export type SettingsPageId = StaticSettingsSectionId | `ws:${string}` | `computer:${string}`;

/** Ids a page once had, still taken wherever a page is asked for (a stored id, a link from the rail, a fix a
 *  computer sends as `settings:<id>`) and read as the page that holds its settings now (`settingsPageOf`). */
export type RetiredSettingsSectionId = "environments" | "remote" | "providers";

/** What may be asked for: a page, or a retired id. */
export type SettingsSectionId = SettingsPageId | RetiredSettingsSectionId;

/**
 * The list's groups, in order (docs/agents/settings.md "By place"): a group is named for what a row in it changes.
 * `mac` is this app and this computer; `every` one set kept on the box ("Everywhere"); `others` a page per machine; then Work's own
 * pages. Jobs and Workspaces follow them (chrome/SettingsRail.tsx), and Archive stands last, alone.
 */
export const SETTINGS_GROUPS = [{ id: "mac" }, { id: "every" }, { id: "others" }, { id: "work" }, { id: "last" }] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

/** What a window is: the box's web page or the desktop app, and on which platform. */
export type SettingsWindow = { web: boolean; platform: string };

/** A group's heading as this window says it: "This PC" on Windows and "This browser" at /ui; "Everywhere" for the one
 *  set every computer reads, in every window (a word for a scope, so it never reads as a list of machines beside
 *  "Other computers"); none for the last group, which is Archive alone. */
export function settingsGroupLabel(id: SettingsGroupId | "jobs" | "workspaces", window: SettingsWindow): string {
  switch (id) {
    case "mac":
      return window.web ? "This browser" : window.platform === "win32" ? "This PC" : "This Mac";
    case "every":
      return "Everywhere";
    case "others":
      return window.web ? "Computers" : "Other computers";
    case "work":
      return "Work";
    case "jobs":
      return "Jobs";
    case "workspaces":
      // A job is a workspace too: these are the code ones, as Appearance says Code and Work.
      return "Code workspaces";
    default:
      return "";
  }
}

export type SettingsSectionDef = {
  id: StaticSettingsSectionId;
  group: SettingsGroupId;
  label: string;
  /** The page's own title where it says more than the list's row ("Threads on this Mac"). */
  title?: string;
  /** The one line under the title, only where the page's name and place cannot carry it. */
  description: string;
  /** Only the desktop app can show it: absent from the list at /ui. */
  desktopOnly?: true;
  /** Only a window on a Mac can show it: absent from the list elsewhere. */
  macOnly?: true;
  /** Only while Work is on for some computer: absent from the list otherwise. */
  workOnly?: true;
  /** Only where the thing it sets exists: a release folder (Publish), a computer that can hold a Windows VM, another
   *  computer to keep in step (Sync). */
  when?: "publish" | "winvm" | "others";
};

export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  { id: "general", group: "mac", label: "General", description: "" },
  { id: "appearance", group: "mac", label: "Appearance", description: "" },
  { id: "editor", group: "mac", label: "Editor", description: "" },
  { id: "keybindings", group: "mac", label: "Shortcuts", description: "" },
  { id: "updates", group: "mac", label: "Updates", description: "Docket on {mac}.", desktopOnly: true },
  { id: "appshots", group: "mac", label: "Appshots", description: "Double-tap ⌘ over another app to drop its window into a chat.", desktopOnly: true },
  { id: "computer", group: "mac", label: "Computer use", description: "How threads use this Mac's apps.", desktopOnly: true, macOnly: true },
  { id: "here", group: "mac", label: "Threads", title: "Threads on {mac}", description: "", desktopOnly: true },
  { id: "sharing", group: "mac", label: "Sharing", description: "Who and what may reach {mac}.", desktopOnly: true },
  { id: "publish", group: "mac", label: "Publish", description: "Ships a Docket release to everyone who runs it.", desktopOnly: true, macOnly: true, when: "publish" },
  { id: "defaults", group: "every", label: "New threads", description: "" },
  { id: "reviews", group: "every", label: "Reviews", description: "" },
  { id: "orchestration", group: "every", label: "Subagents", description: "" },
  {
    id: "away",
    group: "every",
    label: "Away",
    description: "While on, a thread that would wait for you decides for itself. Sends, posts and payments still wait. For every computer.",
  },
  { id: "addons", group: "every", label: "Add-ons", description: "" },
  { id: "skills", group: "every", label: "Skills", description: "" },
  { id: "sync", group: "every", label: "Sync", description: "", desktopOnly: true, when: "others" },
  { id: "accounts", group: "every", label: "AI accounts", description: "The sign-ins and keys threads run on.", desktopOnly: true },
  { id: "winvm", group: "others", label: "Windows VM", description: "A Windows computer inside the box, for Office and Teams.", workOnly: true, when: "winvm" },
  // With Work off on every computer the page holds the switches alone (docs/agents/work.md "The switch").
  // Its row is not "Work" under the heading "Work", nor a second "General": Setup is what the page is (where Work is
  // on, what its threads may do, where new jobs go), and its title says Work.
  { id: "work", group: "work", label: "Setup", title: "Work", description: "Threads for your jobs." },
  { id: "digest", group: "work", label: "Digest", description: "What Work tells you, and when. One set for every computer with Work on.", workOnly: true },
  { id: "mail", group: "work", label: "Mail", description: "Kept in LifeOS, the same on every computer and your phone.", workOnly: true },
  { id: "files", group: "work", label: "Files", description: "", workOnly: true },
  // docs/agents/work-connections.md: every sign-in and helper Work leans on, per computer.
  { id: "connections", group: "work", label: "Connections", description: "Every sign-in Work leans on, and how to fix one.", workOnly: true },
  { id: "archive", group: "last", label: "Archive", description: "Projects and threads you archived." },
];

export const SETTINGS_SECTION_DEFAULT: SettingsPageId = "general";

/** Ids a page once had, and the page that holds its settings now. Hosts (and Environments before it) became Sharing,
 *  this computer's own side of it; Providers became the Agent apps of Threads. */
const SECTION_ALIASES: Record<RetiredSettingsSectionId, StaticSettingsSectionId> = { environments: "sharing", remote: "sharing", providers: "here" };

/** The page a stored or requested id names now. */
export function normalizeSettingsSection(value: unknown): unknown {
  return typeof value === "string" && Object.hasOwn(SECTION_ALIASES, value) ? SECTION_ALIASES[value as RetiredSettingsSectionId] : value;
}

/** The page an id opens: itself, or the page a retired id became. */
export const settingsPageOf = (id: SettingsSectionId): SettingsPageId => normalizeSettingsSection(id) as SettingsPageId;

/** What a window can show beyond its kind: where a release folder was found, where a computer can hold a Windows VM,
 *  and whether it is linked to any other computer. */
export type SettingsHas = { publish?: boolean; winvm?: boolean; others?: boolean };

/** The sections this window can show: the desktop-only ones left out in
 *  web mode, the Mac-only ones in a window off macOS, Work's own while Work is off everywhere. */
export function visibleSettingsSections(web: boolean, mac: boolean, work = false, has: SettingsHas = {}) {
  return SETTINGS_SECTIONS.filter(
    (section) => !(web && section.desktopOnly) && !(!mac && section.macOnly) && !(!work && section.workOnly) && !(section.when && !has[section.when]),
  );
}

/** The keybinding groups this window handles: the terminal's only in the desktop app. */
export function visibleKeybindingGroups(web: boolean, work = false): KeybindingGroup[] {
  return KEYBINDING_GROUPS.filter((group) => !(web && group.desktopOnly) && (work || !group.work));
}

const prefixed = (value: unknown, prefix: string): value is string => typeof value === "string" && value.startsWith(prefix) && value.length > prefix.length;

export function isSettingsSectionId(
  value: unknown,
): value is SettingsSectionId {
  const page = normalizeSettingsSection(value);
  return SETTINGS_SECTIONS.some((section) => section.id === page) || prefixed(page, "ws:") || prefixed(page, "computer:");
}

export const workspaceSettingsSection = (workspaceId: string): SettingsPageId =>
  `ws:${workspaceId}`;

/** The workspace a section belongs to, or null for the fixed pages. */
export function workspaceOfSection(id: SettingsSectionId): string | null {
  return id.startsWith("ws:") ? id.slice(3) : null;
}

export const computerSettingsSection = (environmentId: string): SettingsPageId => `computer:${environmentId}`;

/** The computer a section is the page of (its environment id), or null. */
export function computerOfSection(id: SettingsSectionId): string | null {
  return id.startsWith("computer:") ? id.slice("computer:".length) : null;
}

/** Open Settings on one workspace's page (new threads, after each turn, accounts, build, rules, projects). */
export function openWorkspaceSettings(workspaceId: string, row?: string): void {
  requestSettings(workspaceSettingsSection(workspaceId), row);
}

/** "{mac}" in a page's words as this window says it mid-line: "this Mac", or "this PC" on Windows. */
const inWindow = (text: string, platform: string): string => text.replaceAll("{mac}", platform === "win32" ? "this PC" : "this Mac");

export function settingsSectionLabel(id: SettingsSectionId): string {
  const page = settingsPageOf(id);
  if (workspaceOfSection(page)) return "Workspace";
  if (computerOfSection(page)) return "Computer";
  return SETTINGS_SECTIONS.find((section) => section.id === page)?.label ?? "General";
}

/** A fixed page's title: its row's label, or its own fuller one ("Threads on this Mac"). */
export function settingsSectionTitle(id: SettingsSectionId, platform = ""): string {
  const page = settingsPageOf(id);
  const section = SETTINGS_SECTIONS.find((s) => s.id === page);
  return inWindow(section?.title ?? section?.label ?? "General", platform);
}

export function settingsSectionDescription(id: SettingsSectionId, platform = ""): string {
  const page = settingsPageOf(id);
  return inWindow(SETTINGS_SECTIONS.find((section) => section.id === page)?.description ?? "", platform);
}

export function loadSettingsSection(): SettingsPageId {
  try {
    const raw = normalizeSettingsSection(localStorage.getItem(SECTION_KEY));
    return isSettingsSectionId(raw) ? settingsPageOf(raw) : SETTINGS_SECTION_DEFAULT;
  } catch {
    return SETTINGS_SECTION_DEFAULT;
  }
}

export function saveSettingsSection(id: SettingsSectionId) {
  try {
    localStorage.setItem(SECTION_KEY, id);
  } catch {
    // private mode / quota
  }
}

// Key caps, one per key: macOS glyphs, words elsewhere.
const [CMD, OPT, SHF, CTL, DEL, RET] = keyCaps("mod+alt+shift+ctrl+delete+enter");

export type Keybinding = {
  name: string;
  /** Each entry is one chord as caps; a second entry is an alternative. */
  keys: string[][];
  /** Where the binding holds, when not everywhere. */
  scope?: "editor" | "outside-editor" | "files" | "work-search" | "outbox" | "settings";
};

/** `desktopOnly`: the bindings act only in the desktop app (the terminal), so /ui leaves the group out.
 *  `work`: the bindings act only in Work's screens, so the list has them only while Work is on. */
export type KeybindingGroup = { title: string; bindings: Keybinding[]; desktopOnly?: true; work?: true };

/**
 * Mirrors the bindings we actually handle: the command map in
 * lib/appCommands.ts (native menu accelerators, `tabCommand`, window keys).
 */
export const KEYBINDING_GROUPS: KeybindingGroup[] = [
  {
    title: "App",
    bindings: [
      { name: "Search", keys: [[CMD, "K"]] },
      { name: "Go to File", keys: [[CMD, "P"], [SHF, SHF]] },
      { name: "Open Project", keys: [[CMD, "O"]] },
      { name: "Go to Symbol", keys: [[CMD, SHF, "O"]] },
      { name: "Type Hierarchy", keys: [[CMD, "T"]] },
      { name: "Find in Files", keys: [[CMD, SHF, "F"]] },
      { name: "Save", keys: [[CMD, "S"]] },
      { name: "New Window", keys: [[CMD, SHF, "N"]] },
      { name: "Sidebar", keys: [[CMD, "B"]] },
      { name: "Panel", keys: [[CMD, SHF, "R"]] },
      { name: "Switch Model", keys: [[CMD, "."]] },
      { name: "Settings", keys: [[CMD, ","]] },
      { name: "Find a Setting", keys: [[CMD, "F"]], scope: "settings" },
    ],
  },
  {
    title: "Tabs",
    bindings: [
      { name: "New Thread", keys: [[CMD, "N"]] },
      { name: "Next", keys: [[CMD, SHF, "]"]] },
      { name: "Previous", keys: [[CMD, SHF, "["]] },
      { name: "Cycle Next", keys: [[CTL, "Tab"]] },
      { name: "Cycle Previous", keys: [[CTL, SHF, "Tab"]] },
      { name: "Back", keys: [[CMD, "["]] },
      { name: "Forward", keys: [[CMD, "]"]] },
      { name: "Activate 1 to 8", keys: [[CMD, "1–8"]] },
      { name: "Activate Last", keys: [[CMD, "9"]] },
    ],
  },
  {
    title: "Computers",
    bindings: [
      { name: "Next Computer", keys: [[CMD, OPT, "]"]] },
      { name: "Previous Computer", keys: [[CMD, OPT, "["]] },
      { name: "Activate 1 to 9", keys: [[CMD, OPT, "1–9"]] },
    ],
  },
  {
    title: "Panes",
    bindings: [
      { name: "Close", keys: [[CMD, "W"]] },
      { name: "Split Right", keys: [[CMD, "D"]], scope: "outside-editor" },
      { name: "Split Down", keys: [[CMD, SHF, "D"]], scope: "outside-editor" },
      { name: "Focus Left", keys: [[CMD, OPT, "←"]] },
      { name: "Focus Right", keys: [[CMD, OPT, "→"]] },
      { name: "Focus Up", keys: [[CMD, OPT, "↑"]] },
      { name: "Focus Down", keys: [[CMD, OPT, "↓"]] },
    ],
  },
  {
    title: "Terminal",
    desktopOnly: true,
    bindings: [
      { name: "New", keys: [[CTL, "`"]] },
      { name: "New Tab", keys: [[CTL, SHF, "`"]] },
      { name: "Show or Hide", keys: [[CMD, "J"]] },
    ],
  },
  {
    title: "Files",
    bindings: [
      { name: "Cut", keys: [[CMD, "X"]], scope: "files" },
      { name: "Copy", keys: [[CMD, "C"]], scope: "files" },
      { name: "Paste", keys: [[CMD, "V"]], scope: "files" },
      { name: "Rename", keys: [["F2"]], scope: "files" },
      { name: "Delete", keys: [[DEL]], scope: "files" },
      { name: "Open in Editor", keys: [[OPT, RET]], scope: "files" },
    ],
  },
  {
    title: "Editor",
    bindings: [
      { name: "Find", keys: [[CMD, "F"]], scope: "editor" },
      { name: "Replace", keys: [[CMD, OPT, "F"]], scope: "editor" },
    ],
  },
  {
    // Work search (work/search), then the canvas pane's selection bar (work/canvas/SelectionBar.tsx): Ask puts the selection in the thread's composer.
    title: "Work",
    bindings: [
      { name: "Today", keys: [[CMD, SHF, "T"]] },
      { name: "Search Work", keys: [[CMD, SHF, "K"]] },
      { name: "This Job or All Jobs", keys: [[CMD, SHF, "K"]], scope: "work-search" },
      { name: "Choose a Job", keys: [[OPT, "↓"]], scope: "work-search" },
      { name: "Open Result", keys: [[RET]], scope: "work-search" },
      { name: "New Thread About Result", keys: [[CMD, RET]], scope: "work-search" },
      { name: "Ask about the selection", keys: [[CMD, "L"]] },
      // The Outbox's own keys (work/outbox/OutboxView.tsx onKeyDown).
      { name: "Edit Held Item", keys: [["E"]], scope: "outbox" },
      { name: "Discard Held Item", keys: [["D"]], scope: "outbox" },
      { name: "Clear Ticks", keys: [["Esc"]], scope: "outbox" },
    ],
    work: true,
  },
];

/**
 * A group a lazy place brings with its own chunk (the Files place's, work/files/bindings.ts): it is listed after
 * the app's own, once. The Keybindings page loads each such table before it draws, so the list is whole there.
 */
export function addKeybindingGroup(group: KeybindingGroup): void {
  if (!KEYBINDING_GROUPS.some((g) => g.title === group.title)) KEYBINDING_GROUPS.push(group);
}

/** The first chord of a binding as one key cap's text ("⌘W" on macOS,
 *  "Ctrl+W" elsewhere): the only source of a shortcut a menu row or a `Tip`
 *  shows, so a hint never names a key the app does not handle
 *  (lib/menuShortcuts.test.ts holds every call to a real binding). */
export function shortcutFor(group: string, name: string): string | undefined {
  const chord = KEYBINDING_GROUPS.find((g) => g.title === group)?.bindings.find((b) => b.name === name)?.keys[0];
  return chord && joinCaps(chord);
}

export const KEYBINDING_SCOPE_LABEL: Record<NonNullable<Keybinding["scope"]>, string> = {
  editor: "In the editor",
  "outside-editor": "Outside the editor",
  files: "In the file tree",
  "work-search": "In Work search",
  outbox: "In the Outbox",
  settings: "In Settings",
};

/** The groups with only the bindings whose name, group or keys match;
 *  a group with none left is dropped. Keys match typed with or without spaces. */
export function filterKeybindings(groups: KeybindingGroup[], query: string): KeybindingGroup[] {
  const needle = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!needle) return groups;
  return groups
    .map((group) => ({
      ...group,
      bindings: group.bindings.filter((binding) =>
        [group.title, binding.name, ...binding.keys.map((chord) => chord.join(""))].some((text) =>
          text.toLowerCase().replace(/\s+/g, "").includes(needle),
        ),
      ),
    }))
    .filter((group) => group.bindings.length > 0);
}

// ── editor ───────────────────────────────────────────────────────────

const AUTO_SAVE_KEY = "docket.editor.autoSave";
export const AUTO_SAVE_DEFAULT = true;
export const AUTO_SAVE_CHANGE_EVENT = "docket:auto-save-change";

export function loadAutoSave(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_SAVE_KEY);
    if (raw == null) return AUTO_SAVE_DEFAULT;
    return raw === "1" || raw === "true";
  } catch {
    return AUTO_SAVE_DEFAULT;
  }
}

export function saveAutoSave(value: boolean) {
  try {
    localStorage.setItem(AUTO_SAVE_KEY, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(AUTO_SAVE_CHANGE_EVENT, { detail: value }),
  );
}

export function subscribeAutoSave(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(AUTO_SAVE_CHANGE_EVENT, onStoreChange);
  return () => window.removeEventListener(AUTO_SAVE_CHANGE_EVENT, onStoreChange);
}

const FORMAT_ON_SAVE_KEY = "docket.editor.formatOnSave";
export type FormatOnSave = { java: boolean; web: boolean };
export const FORMAT_ON_SAVE_DEFAULT: FormatOnSave = { java: false, web: false };
export const FORMAT_ON_SAVE_CHANGE_EVENT = "docket:format-on-save-change";

export function loadFormatOnSave(): FormatOnSave {
  try {
    const raw = localStorage.getItem(FORMAT_ON_SAVE_KEY);
    if (!raw) return FORMAT_ON_SAVE_DEFAULT;
    const parsed = JSON.parse(raw) as Partial<FormatOnSave>;
    return {
      java: parsed.java === true,
      web: parsed.web === true,
    };
  } catch {
    return FORMAT_ON_SAVE_DEFAULT;
  }
}

export function saveFormatOnSave(value: FormatOnSave) {
  try {
    localStorage.setItem(FORMAT_ON_SAVE_KEY, JSON.stringify(value));
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<FormatOnSave>(FORMAT_ON_SAVE_CHANGE_EVENT, { detail: value }),
  );
}

export function subscribeFormatOnSave(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(FORMAT_ON_SAVE_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(FORMAT_ON_SAVE_CHANGE_EVENT, onStoreChange);
}

const GHOST_TEXT_KEY = "docket.editor.ghostText";
export const GHOST_TEXT_DEFAULT = false;
export const GHOST_TEXT_CHANGE_EVENT = "docket:ghost-text-change";

export function loadGhostText(): boolean {
  try {
    const raw = localStorage.getItem(GHOST_TEXT_KEY);
    if (raw == null) return GHOST_TEXT_DEFAULT;
    return raw === "1" || raw === "true";
  } catch {
    return GHOST_TEXT_DEFAULT;
  }
}

export function saveGhostText(value: boolean) {
  try {
    localStorage.setItem(GHOST_TEXT_KEY, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(GHOST_TEXT_CHANGE_EVENT, { detail: value }),
  );
}

export function subscribeGhostText(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(GHOST_TEXT_CHANGE_EVENT, onStoreChange);
  return () => window.removeEventListener(GHOST_TEXT_CHANGE_EVENT, onStoreChange);
}

const MID_TURN_DEFAULT_KEY = "docket.midTurnDefault";

/** What Enter does while a turn runs; ⌘Enter does the other one. Steer by
 *  default: a follow-up reaches the running turn now (and releases a
 *  wait_for_agent the thread sits in); a stored preference wins. */
export type MidTurnDefault = "queue" | "steer";

export const MID_TURN_DEFAULT: MidTurnDefault = "steer";

/** Fired on `window` when the mid-turn default flips. */
export const MID_TURN_DEFAULT_CHANGE_EVENT = "docket:mid-turn-default-change";

export function loadMidTurnDefault(): MidTurnDefault {
  try {
    const raw = localStorage.getItem(MID_TURN_DEFAULT_KEY);
    return raw === "steer" || raw === "queue" ? raw : MID_TURN_DEFAULT;
  } catch {
    return MID_TURN_DEFAULT;
  }
}

export function saveMidTurnDefault(value: MidTurnDefault) {
  try {
    localStorage.setItem(MID_TURN_DEFAULT_KEY, value);
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<MidTurnDefault>(MID_TURN_DEFAULT_CHANGE_EVENT, { detail: value }),
  );
}

export function subscribeMidTurnDefault(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MID_TURN_DEFAULT_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(MID_TURN_DEFAULT_CHANGE_EVENT, onStoreChange);
}
