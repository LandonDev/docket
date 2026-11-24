// @vitest-environment jsdom
/**
 * A code-only control never reaches a Work thread (docs/agents/work.md "No code parts on a Work thread or workspace").
 *
 * Each surface that shows a thread's controls is asked, with every fact that could add a row turned on, for a stamped
 * Work thread, for a draft in a Work workspace before the host stamps it, and for a code thread: the thread menu
 * (lib/threadMenu.ts), the title bar (chrome/ThreadHeader.tsx and its ⋯, chrome/ThreadMenu.tsx), the right panel's
 * sections (lib/rightPanel.ts) and the native menu (lib/nativeMenuState.ts over shared/menuTree.ts). Whether a row is
 * Work's is read by the one predicate every surface uses (lib/workRow.ts `isWorkSession`).
 *
 * Every id a surface can offer stands in exactly one list below: WORK (Work's alone), SHARED (both kinds) or CODE (a
 * code project's). A Work row must offer exactly WORK and SHARED, less what its facts leave out, and no CODE id but one
 * listed in KNOWN with its reason; a code row keeps every CODE id. A new id in none of the lists fails: classify it.
 */
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MENU_COMMANDS } from "@shared/menuTree";
import type { MenuRow } from "../chrome/menuRows";
import { menuStateOf, type MenuFacts } from "./nativeMenuState";
import { sectionsFor, SECTIONS, type PanelFacts } from "./rightPanel";
import { sessionStore } from "./tcserver/store";
import type { SessionMeta, SessionStatus } from "./tcserver/types";
import { workspaceStore } from "./tcserver/workspaces";
import { threadMenuRows, type ThreadMenuFacts } from "./threadMenu";
import { isWorkSession } from "./workRow";

// The title bar's parts that read stores of their own draw a marker; ThreadMenu is real, its RowsMenu lists its rows.
const marker = vi.hoisted(() => (name: string, control: string) => async () => {
  const { createElement: h } = await import("react");
  return { [name]: () => h("span", { "data-control": control }) };
});
vi.mock("../chrome/useThreadMenu", () => ({ useThreadMenu: () => ({ rowsFor: () => [], onPick: () => {}, onOpenChange: () => {}, dialogs: null }) }));
vi.mock("../chrome/ThreadHostChip", () => ({ useThreadHost: () => ({ host: null }) }));
vi.mock("./masterThread", async (original) => ({ ...(await original<typeof import("./masterThread")>()), useMasterIds: () => new Set<string>() }));
vi.mock("../chrome/AgentsCue", marker("AgentsCue", "agents-cue"));
vi.mock("../chrome/ComputerCue", marker("ComputerCue", "computer-cue"));
vi.mock("../chrome/NewThreadChooser", marker("NewThreadChooser", "new-thread"));
vi.mock("../chrome/ProjectPlanChip", marker("ProjectPlanChip", "plan-chip"));
vi.mock("../chrome/ThreadHeaderStrip", async () => {
  const { createElement: h } = await import("react");
  return { ThreadHeaderStrip: ({ trailing, end }: { trailing: ReactNode; end: ReactNode }) => h("div", null, trailing, end), chipTitle: () => "" };
});
vi.mock("../chrome/menuRows", async (original) => {
  const { createElement: h } = await import("react");
  return {
    ...(await original<typeof import("../chrome/menuRows")>()),
    RowsMenu: ({ rows }: { rows: readonly MenuRow[] }) =>
      h("span", { "data-control": "thread-menu" }, ...rows.flatMap((row) => (row.kind === "item" ? [h("span", { key: row.id, "data-row": row.id })] : []))),
    LazyPopover: () => null,
  };
});

import { ThreadHeader } from "../chrome/ThreadHeader";

/** A Work thread may show these, and only a Work thread needs them. */
const WORK = {
  threadMenu: ["save-play"],
  header: [],
  panel: ["results"],
  nativeMenu: ["open_file", "save_word", "share", "export", "print", "search_work", "open_today", "open_digest", "away_work"],
} as const;

/** Both kinds. */
const SHARED = {
  threadMenu: [
    "open", "new-pass", "start-now", "side", "close-tab", "rename", "type", "type:chat", "type:research", "tune", "goal", "resume", "pause",
    "compact", "killBackground", "stop", "mac-bridge", "mac-bridge-rules", "resources", "master", "batch-new", "batch-adopt", "move:box",
    "remove-queue", "archive", "delete",
  ],
  header: ["new-thread", "agents-cue", "computer-cue", "thread-menu", "pause-all", "recent", "archived", "panel"],
  panel: ["agents", "activity", "computer", "notes"],
  nativeMenu: [
    "check_for_updates", "open_settings", "quit", "new_tab", "new_window", "open_project", "save_all", "close_tab", "find", "find_in_project",
    "go_to_file", "toggle_sidebar", "toggle_panel", "toggle_message_list", "split_right", "split_down", "focus_left", "focus_right",
    "focus_up", "focus_down", "force_reload", "zoom_in", "zoom_out", "zoom_reset", "open_search", "back_tab", "forward_tab", "prev_tab",
    "next_tab", "prev_environment", "next_environment", "open_inbox", "open_computers", "open_notes", "open_model_picker", "mark_all_read",
    "away_code", "pause_all_threads", "resume_all_threads", "stop_all_threads", "archive_done_threads", "whats_new", "show_logs",
    "profile_host",
  ],
} as const;

/** A code project's: never on a Work row (but KNOWN), always on a code row whose facts ask for it. */
const CODE = {
  threadMenu: ["dev", "type:planning", "type:project-plan", "type:implementation", "type:orchestration"],
  header: ["plan-chip", "terminal"],
  panel: ["changes", "files", "build", "debug"],
  nativeMenu: ["new_terminal", "toggle_terminal", "go_to_symbol", "show_hierarchy"],
} as const;

type Surface = keyof typeof WORK;

/**
 * Code-only controls that DO reach a Work thread today: walls for the build to fix (not here: this guard changes no
 * product code). Each says why it is code's and what it does with a Work thread in front.
 */
const KNOWN: Partial<Record<Surface, Record<string, string>>> = {};

const WORKSPACE = { work: "w-job", code: "w-code" };
const ROWS = {
  stamped: { id: "t-work", scope: "work", workspaceId: WORKSPACE.work },
  draft: { id: "t-draft", workspaceId: WORKSPACE.work },
  code: { id: "t-code", scope: "code", workspaceId: WORKSPACE.code, projectId: "p1" },
} as const;
type Kind = keyof typeof ROWS;

beforeEach(() => {
  workspaceStore.reset();
  workspaceStore.hydrate([
    {
      environmentId: "env_a",
      workspaces: [
        { id: WORKSPACE.work, name: "Job", path: "/w/job", kind: "work" },
        { id: WORKSPACE.code, name: "Code", path: "/w/code" },
      ],
      projects: [{ id: "p1", workspaceId: WORKSPACE.code, cwd: "/w/code/app", name: "app" }],
    },
  ]);
  sessionStore.reset();
  for (const row of Object.values(ROWS))
    sessionStore.adopt({ title: row.id, status: "idle", environmentId: "env_a", projectId: null, updatedAt: 1, ...row } as unknown as SessionMeta);
});
afterEach(() => {
  cleanup();
  sessionStore.reset();
  workspaceStore.reset();
});

/** Work, by the predicate every surface asks. */
const workOf = (kind: Kind): boolean => isWorkSession(ROWS[kind], workspaceStore.getSnapshot().workspaces);

const STATUSES: SessionStatus[] = ["idle", "running", "paused", "stopped", "watching", "queued", "waiting"];

/** Every id the thread menu offers over every status and type the row may take, with every fact that adds a row on. */
function threadMenuIds(kind: Kind): string[] {
  const work = workOf(kind);
  const ids = new Set<string>();
  for (const status of STATUSES)
    for (const threadType of ["chat", "research", "orchestration"] as const) {
      const facts: ThreadMenuFacts = {
        status,
        threadType,
        projectId: "p1",
        parentId: null,
        master: true,
        resources: 1,
        removable: 1,
        goal: false,
        bridge: { on: true, online: true, inherited: false, known: true },
        moves: [{ kind: "item", id: "move:box", label: "Move to box…" }],
        side: true,
        close: { split: false },
        dev: { open: false },
        draft: false,
        play: work,
        work,
      };
      // A Work thread is only ever a chat or research thread (work-scope.md "Types").
      if (work && threadType === "orchestration") continue;
      for (const row of threadMenuRows(facts, { open: true, newPass: true })) {
        if (row.kind === "item") ids.add(row.id);
        if (row.kind === "sub") {
          ids.add(row.id);
          for (const item of row.items) if (item.kind === "item") ids.add(item.id);
        }
      }
    }
  return [...ids];
}

/** What the title bar draws, its ⋯'s rows included, with the row in front and a terminal to show. */
function headerIds(kind: Kind): string[] {
  const { container } = render(
    createElement(ThreadHeader, {
      model: { activeId: ROWS[kind].id, live: [], dormant: [{ id: "old" }] } as never,
      planReady: new Map() as never,
      archived: [{ id: "gone" }] as never,
      workspaceId: ROWS[kind].workspaceId,
      cost: null,
      running: 1,
      railOpen: false,
      projectTerminalActive: true,
      onSelect: () => {},
      onRename: () => {},
      onArchive: () => {},
      onDelete: () => {},
      onSetRules: () => {},
      onRestore: () => {},
      onNew: () => {},
      onPauseAll: async () => {},
      onToggleRail: () => {},
      onSetType: () => {},
      onShowTerminal: () => {},
      onNewTerminal: () => {},
      stripRef: () => {},
      activeRef: () => {},
    } as never),
  );
  const ids = [...container.querySelectorAll<HTMLElement>("[data-control], [data-row]")].map((el) => el.dataset.control ?? el.dataset.row!);
  if (container.querySelector('button[aria-label="Panel"]')) ids.push("panel");
  cleanup();
  return ids;
}

function panelIds(kind: Kind): string[] {
  const facts: PanelFacts = {
    root: true, notes: true, project: true, checkout: true, agents: 1, activity: 1, computer: true, computerLive: true, results: 1, debug: true,
    work: workOf(kind),
  };
  return sectionsFor(facts).sections;
}

function nativeMenuIds(kind: Kind): string[] {
  const facts: MenuFacts = {
    sidebarOpen: false, panel: "closed", dockOpen: false, messageList: false, split: false, dockUsable: true, unread: 1,
    counts: { pause: 1, resume: 1, stop: 1, archiveDone: 1 }, away: false, workFile: true, workOn: true, print: true, export: true, saveWord: true,
    workThread: workOf(kind),
  };
  const hidden = new Set(menuStateOf(facts).hidden ?? []);
  return MENU_COMMANDS.map((c) => c.id).filter((id) => !hidden.has(id));
}

const OFFERED: Record<Surface, (kind: Kind) => string[]> = { threadMenu: threadMenuIds, header: headerIds, panel: panelIds, nativeMenu: nativeMenuIds };
const SURFACES = Object.keys(OFFERED) as Surface[];

describe("the lists", () => {
  it.each(SURFACES)("%s: an id stands in one list alone, and KNOWN names only CODE ids", (surface) => {
    const all = [...WORK[surface], ...SHARED[surface], ...CODE[surface]];
    expect(new Set(all).size, "an id is in two lists").toBe(all.length);
    for (const id of Object.keys(KNOWN[surface] ?? {})) expect(CODE[surface] as readonly string[], `${id} is in KNOWN but not in CODE`).toContain(id);
  });

  it("the panel lists every section there is, and the native menu every command", () => {
    expect([...WORK.panel, ...SHARED.panel, ...CODE.panel].sort()).toEqual([...SECTIONS].sort());
    expect([...WORK.nativeMenu, ...SHARED.nativeMenu, ...CODE.nativeMenu].sort()).toEqual(MENU_COMMANDS.map((c) => c.id).sort());
  });

  it("the predicate: a stamped Work thread and a draft in a Work workspace are Work, a code thread is not", () => {
    expect([workOf("stamped"), workOf("draft"), workOf("code")]).toEqual([true, true, false]);
  });
});

describe.each(SURFACES)("%s", (surface) => {
  const listed = new Set<string>([...WORK[surface], ...SHARED[surface], ...CODE[surface]]);
  const unlisted = (ids: string[]) => ids.filter((id) => !listed.has(id));

  it.each(["stamped", "draft", "code"] as const)("every id offered to a %s row is classified", (kind) => {
    expect(unlisted(OFFERED[surface](kind)), `new ${surface} ids: put each in WORK, SHARED or CODE in workControlsGuard.test.ts`).toEqual([]);
  });

  it.each(["stamped", "draft"] as const)("a %s Work row offers exactly Work's and the shared ids, and no code id but KNOWN", (kind) => {
    const offered = OFFERED[surface](kind);
    const known = Object.keys(KNOWN[surface] ?? {});
    expect(offered.filter((id) => (CODE[surface] as readonly string[]).includes(id)).sort()).toEqual([...known].sort());
    expect([...offered].sort()).toEqual([...WORK[surface], ...SHARED[surface], ...known].sort());
  });

  it("a code row keeps every code id", () => {
    expect(OFFERED[surface]("code")).toEqual(expect.arrayContaining([...CODE[surface]]));
  });
});
