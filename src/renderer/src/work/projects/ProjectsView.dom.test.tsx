// @vitest-environment jsdom
/**
 * A Work workspace's Projects: the shared project screens (work-kit/projects)
 * mounted on the workspace's LifeOS session with TempCode's kit. The store is
 * work-kit's fake; what is proven here is the host's side: the header's two
 * slots, the place kept a workspace, New project on the workspace's sector,
 * threads in the project's mirror with a chip, the thread mark, and what
 * Documents' rows and items do.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { fakeProjectsClient, type FakeProjectsClient, type Project, type ProjectTask } from "work-kit/projects";
import type { ContextChip } from "@shared/work";
import { registry } from "../../lib/connection";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { openWorkView, workOpenPort, workSwitch, workViewNow } from "../../lib/workSwitch";
import type { LifeosSession } from "../shell/lifeos";
import type { WorkViewProps } from "../views/registry";

if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.scrollTo ??= () => {};

// The store is work-kit's fake: one made a test, handed out as the LifeOS client would be.
const fake = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("work-kit/lifeos", async (original) => ({
  ...(await original<object>()),
  createLifeosProjectsClient: () => fake.client,
}));
// The window holds one thread, running: the one LifeOS links to "Network for 64 seats".
vi.mock("../tasks/links", () => ({ useLinkedThread: (taskId: string) => (taskId === "t-network" ? "th1" : null) }));
vi.mock("../../lib/tcserver/store", async (original) => ({
  ...(await original<object>()),
  useSessionMetaValue: (id: string | null | undefined, read: (meta: { status: string }) => unknown) => (id === "th1" ? read({ status: "running" }) : undefined),
}));
const opened = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("../../lib/native", async (original) => ({ ...(await original<object>()), openUrl: async (url: string) => void opened.urls.push(url) }));
// The document editor is the Docs view's own, proven there: here it is a mark that it was mounted on the right source.
vi.mock("../docs/DocumentCanvas", () => ({
  MARGIN_FROM: 1104,
  Scroller: ({ children }: { children: (width: number) => unknown }) => <div data-scroller>{children(900) as never}</div>,
  useOpened: (_env: string, source: { id: string }) => ({ host: {}, open: { doc: source.id, title: "Run of show", role: "edit", source } }),
  useDocument: () => ({}),
  DocumentFrame: ({ open }: { open: { doc: string } }) => <div data-document-frame={open.doc} />,
}));
// The Work project's sheet is its own, proven in work/shell: here it is a mark of which mirror it was opened on.
vi.mock("../../surfaces/chunks", async (original) => ({
  ...(await original<object>()),
  dialogsChunk: { surface: () => ({ project }: { project: { id: string } }) => <div data-settings-for={project.id} /> },
}));
vi.mock("./Description", () => ({ Description: ({ docId, lead }: { docId: string; lead: string }) => <div data-description={docId}>{lead}</div> }));

const { View, Head, Title } = await import("./ProjectsView");
const { addRows, hintKeys, openItemIn, projectChip, taskChip } = await import("./kit");
const { placeOf, resetPlaces } = await import("./place");
const { openerOf } = await import("../canvas/SentChips");

const BOX = "env_box";
const WORKSPACE = { id: "ws", name: "Purdue Esports", path: "/srv/work/Work/Purdue", git: false, kind: "work", sector: "purdue", createdAt: 1, environmentId: BOX } as WorkspaceMeta;
const LAN = { id: "p-lan", name: "Spring LAN" } as Project;

let client: FakeProjectsClient;
let started: { about: ContextChip | readonly ContextChip[]; at?: { cwd: string; projectId: string | null } }[];
let hostCalls: { method: string; params: Record<string, unknown> }[];
let refuse: Record<string, string>;
let convexCalls: { fn: string; args: Record<string, unknown> }[];
const convex = {
  mutation: async (ref: never, args: Record<string, unknown>) => void convexCalls.push({ fn: getFunctionName(ref), args }),
  // `tasks:get`, asked for a card chip's way back: the task is the LAN's.
  query: async () => ({ task: { projectId: "p-lan" } }),
} as unknown as ConvexReactClient;

const props = (over: Partial<WorkViewProps> = {}): WorkViewProps => ({
  env: BOX,
  workspace: WORKSPACE,
  sector: "purdue",
  lifeos: { environmentId: BOX, sector: "purdue", client: convex, state: "connected" } as LifeosSession,
  startThread: (about, at) => void started.push({ about, at }),
  ...over,
});

/** The view under its frame's header, as WorkViewPage draws them. */
function Screen(p: WorkViewProps) {
  return (
    <div>
      <header data-view-head>
        <Title {...p} />
        <Head {...p} />
      </header>
      <View {...p} />
    </div>
  );
}
const head = () => document.querySelector("[data-view-head]") as HTMLElement;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  client = fakeProjectsClient();
  fake.client = client;
  started = [];
  hostCalls = [];
  convexCalls = [];
  refuse = {};
  opened.urls = [];
  vi.spyOn(registry, "linkOf").mockReturnValue({
    environmentId: BOX,
    connected: true,
    onOpen: () => () => {},
    onPush: () => () => {},
    request: async (method: string, params: Record<string, unknown> = {}) => {
      hostCalls.push({ method, params });
      if (refuse[method]) throw new Error(refuse[method]);
      if (method === "work.project.open") return { id: "mirror-1", workspaceId: "ws", name: "Spring LAN", lifeosProjectId: params.lifeosProjectId };
      if (method === "work.docs.create") return { source: { at: "lifeos", table: "docs", id: "d-new" }, title: "Untitled" };
      if (method === "work.docs.find")
        return {
          entries: [
            { key: "lifeos:docs:d9", title: "Sponsor deck notes", kind: "document", where: "lifeos", source: { at: "lifeos", table: "docs", id: "d9" }, editedAt: 2, createdAt: 1, shared: false, guest: false, comments: 0 },
            { key: "file:/w/budget.xlsx", title: "budget.xlsx", kind: "sheet", where: "folder", source: { at: "file", host: BOX, path: "/w/budget.xlsx" }, editedAt: 1, createdAt: 1, shared: false, guest: false, comments: 0 },
          ],
          projects: [],
          hits: [],
          complete: true,
        };
      if (method === "work.projects.link") return { as: "doc", id: "d9" };
      return null;
    },
  } as never);
  // The catalog's own read after a mirror is made is the store's business, proven there.
  vi.spyOn(workspaceStore, "refresh").mockResolvedValue();
});

afterEach(() => {
  cleanup();
  resetPlaces();
  openWorkView(null);
  workSwitch.reset();
  workOpenPort.set(null);
  vi.restoreAllMocks();
});

describe("the Projects view", () => {
  it("draws the sector's projects under the view's own header: its name, then List or Board and a quiet New project", () => {
    render(<Screen {...props()} />);
    expect(head().querySelector("[data-projects-title]")!.textContent).toBe("Projects");
    const controls = head().querySelector("[data-projects-controls]") as HTMLElement;
    const verb = within(controls).getByRole("button", { name: "New project" });
    // The header's own buttons: quiet, 28px (docs/DESIGN.md), never the kit's primary.
    expect(verb.getAttribute("data-variant")).toBe("ghost");
    expect(verb.className.split(/\s+/)).toContain("h-7");
    expect(within(controls).getByRole("tab", { name: "List" })).toBeTruthy();
    for (const name of ["Spring LAN", "Varsity tryouts", "Arena lighting", "Budget FY27"]) expect(screen.getByText(name)).toBeTruthy();
  });

  it("is bones while the workspace's LifeOS session is on its way, and mounts nothing of the screens", () => {
    render(<Screen {...props({ lifeos: { environmentId: BOX, sector: "purdue", client: null, state: "connecting" } })} />);
    expect(screen.getByLabelText("Loading Projects")).toBeTruthy();
    expect(screen.queryByText("Spring LAN")).toBeNull();
    // The header keeps its name with no screen to fill it.
    expect(head().querySelector("[data-projects-title]")!.textContent).toBe("");
    expect(head().querySelector("[data-projects-title]")!.className).toContain("empty:before:content-['Projects']");
  });

  it("opens a project in place and keeps the place for the workspace; the header's name becomes the way back", async () => {
    const first = render(<Screen {...props()} />);
    fireEvent.click(screen.getByText("Spring LAN"));
    expect(placeOf("ws")).toMatchObject({ at: "project", id: "p-lan" });
    expect(screen.getByText("Network for 64 seats")).toBeTruthy();
    const back = within(head().querySelector("[data-projects-title]") as HTMLElement).getByRole("button", { name: "Back to Projects" });
    // Leaving the view and coming back lands on the project.
    first.unmount();
    render(<Screen {...props()} />);
    expect(screen.getByText("Network for 64 seats")).toBeTruthy();
    expect(back.isConnected).toBe(false);
    fireEvent.click(within(head().querySelector("[data-projects-title]") as HTMLElement).getByRole("button", { name: "Back to Projects" }));
    expect(placeOf("ws").at).toBe("list");
  });

  it("draws one way back on every screen: an arrow, then where it goes, then what the screen adds beside it", async () => {
    render(<Screen {...props()} />);
    const title = () => head().querySelector("[data-projects-title]") as HTMLElement;
    // The list: the view's name, and nothing to go back to.
    expect(title().textContent).toBe("Projects");
    expect(within(title()).queryByRole("button")).toBeNull();
    // A project: back to Projects.
    fireEvent.click(await screen.findByText("Spring LAN"));
    expect(within(title()).getByRole("button", { name: "Back to Projects" })).toBeTruthy();
    expect(title().textContent).toBe("Projects");
    // A task's own page: back, with the task's key beside it.
    act(() => openWorkView({ workspaceId: "ws", view: "projects", task: "t-network" }));
    await waitFor(() => expect(placeOf("ws")).toMatchObject({ at: "task", id: "t-network" }));
    await waitFor(() => expect(within(title()).getByRole("button", { name: "Back" })).toBeTruthy());
    expect(title().textContent).toContain("PUR-2");
    // New project: back to Projects, and what he is making.
    fireEvent.click(within(title()).getByRole("button", { name: "Back" }));
    fireEvent.click(within(title()).getByRole("button", { name: "Back to Projects" }));
    fireEvent.click(within(head()).getByRole("button", { name: "New project" }));
    expect(title().textContent).toBe("ProjectsNew project");
    expect(within(title()).getByRole("button", { name: "Back to Projects" })).toBeTruthy();
  });

  it("a project's menu reaches its settings: the mirror is made at the ask and the Work project's sheet opens on it", async () => {
    render(<Screen {...props()} />);
    fireEvent.click(await screen.findByText("Spring LAN"));
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Spring LAN" }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: "Project settings…" }));
    });
    await waitFor(() => expect(hostCalls.find((c) => c.method === "work.project.open")?.params).toMatchObject({ workspaceId: "ws", lifeosProjectId: "p-lan" }));
    await waitFor(() => expect(document.querySelector("[data-settings-for='mirror-1']")).toBeTruthy());
  });

  it("says why when its settings cannot open, and opens nothing", async () => {
    refuse["work.project.open"] = "Fall LAN is done: reopen it to start a thread in it";
    render(<Screen {...props()} />);
    fireEvent.click(await screen.findByText("Spring LAN"));
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Spring LAN" }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: "Project settings…" }));
    });
    await flush();
    expect(document.querySelector("[data-settings-for]")).toBeNull();
  });

  it("makes a new project on the workspace's sector, from the header's New project", async () => {
    render(<Screen {...props()} />);
    fireEvent.click(within(head()).getByRole("button", { name: "New project" }));
    expect(placeOf("ws").at).toBe("new");
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Fall tryouts" } });
    await act(async () => {
      fireEvent.click(within(head()).getByRole("button", { name: "Create" }));
    });
    await waitFor(() => expect(client.acts.some((a) => a.startsWith("createProject"))).toBe(true));
    expect(client.acts.find((a) => a.startsWith("createProject"))).toContain("Fall tryouts");
    await waitFor(() => expect(placeOf("ws").at).toBe("project"));
  });

  it("a column card's Open project stands the view on that project, once", async () => {
    render(<Screen {...props()} />);
    act(() => openWorkView({ workspaceId: "ws", view: "projects", project: "p-tryouts" }));
    await waitFor(() => expect(placeOf("ws")).toMatchObject({ at: "project", id: "p-tryouts" }));
    expect(screen.getByText("Sign-up sheet")).toBeTruthy();
    // Taken once: going back to the list is not undone by the ask.
    fireEvent.click(within(head().querySelector("[data-projects-title]") as HTMLElement).getByRole("button", { name: "Back to Projects" }));
    await flush();
    expect(placeOf("ws").at).toBe("list");
  });
});

describe("the screens' tips", () => {
  it("never name a chord the app takes first: ⌘B folds the sidebar, so List and Board promise no key", () => {
    expect(hintKeys("mod+b")).toBeUndefined();
    expect(hintKeys("c")).toBeTruthy();
    expect(hintKeys(undefined)).toBeUndefined();
  });
});

describe("a sent chip", () => {
  const at = { environmentId: BOX, sessionId: "th1", workspaceId: "ws" };
  const chip = (noun: string, ref: string) => ({ noun, label: "x", ref }) as Parameters<typeof openerOf>[0];

  it("of a project opens its page, of a card the task's own page, and a plain task still opens Tasks", async () => {
    render(<Screen {...props()} />);
    void openerOf(chip("project", "LifeOS projects p-tryouts"), at)!();
    await waitFor(() => expect(placeOf("ws")).toMatchObject({ at: "project", id: "p-tryouts" }));
    void openerOf(chip("card", "LifeOS tasks t-network"), at)!();
    // The task's own page, and its Back goes to the project that holds it, which LifeOS names.
    await waitFor(() => expect(placeOf("ws")).toMatchObject({ at: "task", id: "t-network", from: "p-lan" }));
    expect(screen.getByText("Network for 64 seats")).toBeTruthy();
    fireEvent.click(within(head()).getByRole("button", { name: "Back" }));
    expect(placeOf("ws")).toMatchObject({ at: "project", id: "p-lan" });
    void openerOf(chip("task", "LifeOS tasks t-network"), at)!();
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "tasks" });
  });

  it("of a mail opens Mail's reader on that mail", () => {
    void openerOf(chip("mail", "LifeOS mailThreads mt_9"), at)!();
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "mail", mail: "mt_9" });
  });

  it("outside a workspace names nothing to open", () => {
    expect(openerOf(chip("project", "LifeOS projects p-lan"), { ...at, workspaceId: null })).toBeNull();
    expect(openerOf(chip("card", "LifeOS tasks t-network"), { ...at, workspaceId: null })).toBeNull();
  });
});

describe("threads", () => {
  it("New thread opens a composer in the project's mirror with the project as its chip", async () => {
    render(<Screen {...props()} />);
    fireEvent.click(screen.getByText("Spring LAN"));
    await act(async () => {
      fireEvent.click(within(head()).getByRole("button", { name: "New thread" }));
    });
    await waitFor(() => expect(started).toHaveLength(1));
    expect(hostCalls.find((c) => c.method === "work.project.open")?.params).toMatchObject({ workspaceId: "ws", lifeosProjectId: "p-lan" });
    expect(started[0]).toEqual({ about: projectChip(LAN), at: { cwd: WORKSPACE.path, projectId: "mirror-1" } });
    expect(started[0].about).toEqual({ kind: "project", label: "Spring LAN", ref: { at: "lifeos", table: "projects", id: "p-lan" } });
  });

  it("says why when the mirror cannot be opened, and starts nothing", async () => {
    refuse["work.project.open"] = "Spring LAN is done: reopen it to start a thread in it";
    render(<Screen {...props()} />);
    fireEvent.click(screen.getByText("Spring LAN"));
    await act(async () => {
      fireEvent.click(within(head()).getByRole("button", { name: "New thread" }));
    });
    await flush();
    expect(started).toEqual([]);
  });

  it("a task's chip is the task itself, as the Tasks view's is, so the host links the thread and Done names it", () => {
    expect(taskChip({ id: "t-network", title: "Network for 64 seats" } as ProjectTask)).toEqual({ kind: "task", label: "Network for 64 seats", ref: { at: "lifeos", table: "tasks", id: "t-network" } });
  });

  it("a task a thread works on shows that thread's mark, and a press opens the thread", () => {
    const openThread = vi.fn();
    workOpenPort.set(openThread);
    render(<Screen {...props()} />);
    fireEvent.click(screen.getByText("Spring LAN"));
    const marks = document.querySelectorAll("[data-task-thread]");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.getAttribute("data-task-thread")).toBe("working");
    expect(marks[0]!.getAttribute("aria-label")).toBe("Open the thread on Network for 64 seats");
    fireEvent.click(marks[0]!);
    expect(openThread).toHaveBeenCalledWith("th1");
  });
});

describe("Documents", () => {
  const mounted = () => {
    render(<Screen {...props()} />);
    fireEvent.click(screen.getByText("Spring LAN"));
  };
  const row = (id: string) => addRows(BOX, "ws", LAN).find((r) => r.id === id)!;

  it("adds four rows of TempCode's own before the kit's Add link", () => {
    expect(addRows(BOX, "ws", LAN).map((r) => r.label)).toEqual(["New document", "New sheet", "Link a document or sheet…", "Link a file or item…"]);
  });

  it("New document makes one in the project and opens it in place, with the way back to the project", async () => {
    mounted();
    await act(async () => row("new-document").run());
    expect(hostCalls.find((c) => c.method === "work.docs.create")?.params).toEqual({ sector: "purdue", projectId: "p-lan", title: "Untitled" });
    await waitFor(() => expect(document.querySelector("[data-document-frame='d-new']")).toBeTruthy());
    const title = head().querySelector("[data-projects-title]") as HTMLElement;
    expect(title.textContent).toBe("Spring LAN");
    const back = within(title).getByRole("button", { name: "Back to Spring LAN" });
    fireEvent.click(back);
    expect(document.querySelector("[data-document-frame]")).toBeNull();
    expect(screen.getByText("Network for 64 seats")).toBeTruthy();
  });

  it("New sheet makes a LifeOS sheet in the project on the workspace's own session", async () => {
    mounted();
    await act(async () => row("new-sheet").run());
    await waitFor(() => expect(convexCalls).toEqual([{ fn: "sheets:create", args: { projectId: "p-lan", title: "Untitled" } }]));
  });

  it("Link a document lists LifeOS's documents the project lacks, and a pick links it through the host", async () => {
    mounted();
    act(() => row("link-document").run());
    const picker = await screen.findByRole("dialog");
    const option = await within(picker).findByRole("option", { name: /Sponsor deck notes/ });
    // Every row here is LifeOS's, so a row says its kind and not its place.
    expect(option.textContent).toBe("Sponsor deck notesDocument");
    expect(within(picker).queryByRole("option", { name: /budget\.xlsx/ })).toBeNull();
    await act(async () => {
      fireEvent.click(option);
    });
    expect(hostCalls.find((c) => c.method === "work.projects.link")?.params).toEqual({ workspaceId: "ws", lifeosProjectId: "p-lan", source: { at: "lifeos", table: "docs", id: "d9" }, title: "Sponsor deck notes" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Link a file or item lists the workspace's files, and a refusal stays in the picker as its one line", async () => {
    refuse["work.projects.link"] = "forbidden: work.projects.link is outside app-managed roots";
    mounted();
    act(() => row("link-item").run());
    const picker = await screen.findByRole("dialog");
    const option = await within(picker).findByRole("option", { name: /budget\.xlsx/ });
    expect(within(picker).queryByRole("option", { name: /Sponsor deck notes/ })).toBeNull();
    await act(async () => {
      fireEvent.click(option);
    });
    expect(hostCalls.find((c) => c.method === "work.projects.link")?.params.source).toEqual({ at: "file", host: BOX, path: "/w/budget.xlsx" });
    await waitFor(() => expect(within(picker).getByText("forbidden: work.projects.link is outside app-managed roots")).toBeTruthy());
    expect(within(picker).getByRole("option", { name: /budget\.xlsx/ })).toBeTruthy();
  });

  it("a press opens each thing where it lives: a document here, a sheet, a note and an item beside a thread, a link in the browser", async () => {
    mounted();
    act(() => openItemIn("ws", { id: "i-run", kind: "doc", title: "Run of show" }, LAN));
    expect(document.querySelector("[data-document-frame='i-run']")).toBeTruthy();
    openItemIn("ws", { id: "i-seats", kind: "sheet", title: "Seat map" }, LAN);
    openItemIn("ws", { id: "n1", kind: "note", title: "Old notes" }, LAN);
    openItemIn("ws", { id: "x1", kind: "item", title: "Roster", source: { at: "google", account: "l@purdue.edu", fileId: "g1", mime: "application/vnd.google-apps.spreadsheet" } }, LAN);
    expect(started.map((s) => (s.about as ContextChip).ref)).toEqual([
      { at: "lifeos", table: "sheets", id: "i-seats" },
      { at: "lifeos", table: "projectDocs", id: "n1" },
      { at: "google", account: "l@purdue.edu", fileId: "g1", mime: "application/vnd.google-apps.spreadsheet" },
    ]);
    expect(started.every((s) => (s.about as ContextChip).kind === "selection")).toBe(true);
    openItemIn("ws", { id: "i-rules", kind: "link", title: "Tournament rules", url: "https://example.org/rules" }, LAN);
    expect(opened.urls).toEqual(["https://example.org/rules"]);
  });
});
