// @vitest-environment jsdom
/**
 * The Files place on screen (docs/DESIGN.md "The Files place"): the sidebar, the tabs as the host keeps them, a
 * page's list and trail, a file in a tab of its own, the states, and the app's tab chords, against a stand-in
 * host that answers `work.files.*` from what a test gives it. A second stand-in answers only the old wire.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePage, FilesListing, FilesPlaces, FileTab } from "@shared/contract-work-files";
import type { TeamsLibrariesAnswer } from "@shared/contract-work-office";
import type { FileEntry, FilePlace, FolderRef } from "@shared/work/files";
import { refKey } from "@shared/work/files";
import { openMenus } from "../../chrome/menuRows";
import { filesPort } from "../../lib/filesKeys";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import type { WorkViewProps } from "../views/registry";

// The whole suite runs these beside a hundred other files: a wait for the screen is given room.
configure({ asyncUtilTimeout: 5000 });

type Push = Record<string, unknown>;
interface Host {
  name: string;
  platform: string;
  calls: { method: string; params: Record<string, unknown> }[];
  pushes: Set<(push: Push) => void>;
  answer(method: string, params: Record<string, unknown>): unknown;
}
const hosts = vi.hoisted(() => new Map<string, unknown>());
const settings = vi.hoisted(() => ({ mayUseDesktop: [] as string[], windowsVm: false, voice: false }));

vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => {
    const host = hosts.get(id) as Host | undefined;
    if (!host) throw new Error(`unknown environment ${id}`);
    return {
      environmentId: id,
      connected: true,
      request: async (method: string, params: Record<string, unknown> = {}) => {
        host.calls.push({ method, params });
        return host.answer(method, params);
      },
      onPush: (listener: (push: Push) => void) => (host.pushes.add(listener), () => host.pushes.delete(listener)),
      onOpen: () => () => undefined,
      onClose: () => () => undefined,
    };
  };
  return {
    ...(await original<typeof import("../../lib/connection")>()),
    registry: {
      linkOf,
      link: (id: string) => (hosts.has(id) ? linkOf(id) : null),
      has: (id: string) => hosts.has(id),
      environment: (id: string) => (hosts.has(id) ? { id, name: (hosts.get(id) as Host).name, platform: (hosts.get(id) as Host).platform } : undefined),
      environments: () => [...hosts].map(([id, h]) => ({ id, name: (h as Host).name, platform: (h as Host).platform })),
      onLink: () => () => undefined,
    },
  };
});
vi.mock("../shell/actions", () => ({
  workspaceSettings: async () => settings,
  localHostId: async () => null,
  windowDesktops: async () => [...hosts].filter(([, h]) => (h as Host).platform === "darwin").map(([id, h]) => ({ link: id, host: id, name: (h as Host).name })),
  linkIdOfHost: (id: string) => (hosts.has(id) ? id : null),
  allowComputers: vi.fn(async () => settings),
}));
vi.mock("../winvm/signIn", () => ({ openVm: vi.fn(), signInOnVm: vi.fn(async () => undefined) }));
// A file's own viewer is each kind's business: here the pane says only which item it was handed.
vi.mock("../canvas/CanvasPane", () => ({
  CanvasPane: ({ item, onAsk }: { item: { title: string; kind: string }; onAsk?(selection: unknown): void }) => (
    <>
      <div data-testid="pane">{`${item.kind}: ${item.title}`}</div>
      <button type="button" onClick={() => onAsk?.({ chip: { kind: "selection", label: "B2:C4", ref: { at: "item", id: "i1" }, quote: "42" } })}>
        Ask about the selection
      </button>
    </>
  ),
}));
// The docked chat: a stand-in for the thread's view whose composer shows its chips and sends through App's handler.
const dock = vi.hoisted(() => ({ submit: (_sessionId: string, _text: string) => undefined as void }));
vi.mock("../../surfaces/threadChat", () => ({
  useSessionActions: () => ({ onSubmit: (id: string, text: string) => dock.submit(id, text) }),
  useThreadChat: () => ({ renderChat: () => null, renderSlots: () => null, newPassArmed: false, armNewPass: () => undefined }),
}));
vi.mock("../../surfaces/threads/ThreadView", async () => {
  const { useContextChips } = await import("../canvas/chips");
  const { useActions } = { useActions: () => ({ submit: (id: string, text: string) => dock.submit(id, text) }) };
  return {
    ThreadView: ({ session, seat }: { session: { id: string }; seat?: boolean }) => {
      const chips = useContextChips(session.id);
      const act = useActions();
      return (
        <div data-testid="chat" data-session={session.id} data-seat={String(seat)}>
          <ul aria-label="Chips">{chips.map((c) => <li key={c.label}>{c.label}</li>)}</ul>
          <textarea data-composer-input aria-label="Message" />
          <button type="button" onClick={(e) => act.submit(session.id, ((e.currentTarget.previousSibling as HTMLTextAreaElement).value))}>
            Send
          </button>
        </div>
      );
    },
  };
});
vi.mock("../../surfaces/SessionPane", () => ({ LoadLine: () => null }));

const { View } = await import("./FilesView");
const { resetFilesStore } = await import("./store");
const { applyCanvasPush, resetCanvasStore } = await import("../canvas/store");
const { sessionStore } = await import("../../lib/tcserver/store");
const { send } = await import("../../lib/tcserver/commands");
const { chipPort } = await import("../../lib/contextChips");
const { newSession } = await import("../../lib/session");
const { workDockPort, workOpenPort } = await import("../../lib/workSwitch");
const { resetContextChips } = await import("../canvas/chips");
const { resetDocks } = await import("./dockThread");

const workspace = { id: "w1", environmentId: "box", path: "/w", name: "Dummy Esports", kind: "work", sector: "purdue" } as unknown as WorkspaceMeta;
const props = { env: "box", workspace, sector: "purdue", lifeos: {}, startThread: () => undefined } as unknown as WorkViewProps;

const place = (over: Partial<FilePlace> & Pick<FilePlace, "id" | "kind" | "name">): FilePlace => ({ host: "", env: "env_box", shared: over.kind === "teams", can: [], state: { state: "ok" }, root: { at: "place", id: over.id }, ...over });
const at = (path: string, host = "env_box"): FolderRef & { at: "file" } => ({ at: "file", host, path });
const file = (path: string, kind: FileEntry["kind"], over: Partial<FileEntry> = {}): FileEntry => ({ key: `file:env_box:${path}`, ref: at(path), folder: null, name: path.split("/").pop()!, kind, size: 10, changed: 1_700_000_000_000, ...over });
const dir = (path: string): FileEntry => ({ key: `file:env_box:${path}`, ref: null, folder: at(path), name: path.split("/").pop()!, kind: "folder" });

const PLACES: FilePlace[] = [
  place({ id: "recent", kind: "recent", name: "Recent" }),
  place({ id: "starred", kind: "starred", name: "Starred" }),
  place({ id: "folder", kind: "folder", name: "Dummy Esports", root: at("/w") }),
  place({ id: "b1/Events", kind: "teams", name: "Events", group: "Esports Staff", key: "esportsstaffevents", root: at("/cloud/Staff/Events") }),
  place({ id: "b1/General", kind: "teams", name: "General", group: "Esports Staff", key: "esportsstaffgeneral", root: at("/cloud/Staff/General") }),
];
const FOLDERS: Record<string, FileEntry[]> = {
  "/w": [dir("/w/Events"), file("/w/Budget.xlsx", "sheet"), file("/w/notes.txt", "text"), file("/w/bundle.zip", "archive")],
  "/w/Events": [file("/w/Events/Poster.png", "picture")],
  "/cloud/Staff/General": [file("/cloud/Staff/General/Plan.docx", "document", { key: "lib:esportsstaffgeneral:Plan.docx", shared: true, local: false, state: { is: "cloud" } })],
};

/** A host on the new wire: its places, its folders, and the workspace's tabs, which it keeps and says. */
function newHost(over: { places?: FilePlace[]; sources?: FilesPlaces["sources"]; fail?: Record<string, string>; asOf?: number; threads?: { sessionId: string; itemId: string; source: unknown }[] } = {}) {
  let tabs: FileTab[] = [];
  let rev = 0;
  let ids = 0;
  const items: { id: string; sessionId: string; workspaceId: string; kind: string; title: string; source: unknown; state: "open"; position: number; rev: number; createdAt: number; updatedAt: number }[] = [];
  const host: Host & { tabs(): FileTab[]; say(push: Push): void; closeElsewhere(tabId: string): void } = {
    name: "The box",
    platform: "linux",
    calls: [],
    pushes: new Set(),
    tabs: () => tabs,
    say: (push) => host.pushes.forEach((listener) => listener(push)),
    closeElsewhere(tabId) {
      tabs = tabs.filter((t) => t.id !== tabId);
      rev++;
      host.say({ push: "work.files", workspaceId: "w1", tabs: rev });
    },
    answer(method, params) {
      if (over.fail?.[method]) throw new Error(over.fail[method]);
      const list = (): { rev: number; tabs: FileTab[] } => ({ rev, tabs: [...tabs] });
      switch (method) {
        case "work.files.places":
          return { host: "env_box", places: over.places ?? PLACES, rev, sources: over.sources ?? [] } satisfies FilesPlaces;
        case "work.office.filesCopyGet":
          return { on: false };
        case "work.files.tabs":
          return list();
        case "work.files.tabOpen": {
          if (params.first && tabs.length) return { ...list(), tabId: tabs[0]!.id };
          const page = params.page as FilePage;
          const tab: FileTab = { id: `t${++ids}`, kind: "page", name: page.name, page, ...(params.after ? { opener: params.after as string } : {}) };
          const after = tabs.findIndex((t) => t.id === params.after);
          tabs.splice(after < 0 ? tabs.length : after + 1, 0, tab);
          rev++;
          return { ...list(), tabId: tab.id };
        }
        case "work.files.tabSet": {
          const page = params.page as FilePage;
          tabs = tabs.map((t) => (t.id === params.tabId ? { ...t, name: page.name, page } : t));
          rev++;
          return list();
        }
        case "work.files.tabClose": {
          tabs = tabs.filter((t) => t.id !== params.tabId);
          if (!tabs.length) tabs = [{ id: `t${++ids}`, kind: "page", name: "Dummy Esports", page: { at: { at: "place", id: "folder" }, name: "Dummy Esports" } }];
          rev++;
          return list();
        }
        case "work.files.tabMove": {
          const moved = tabs.find((t) => t.id === params.tabId)!;
          const rest = tabs.filter((t) => t !== moved);
          const before = rest.findIndex((t) => t.id === params.before);
          rest.splice(before < 0 ? rest.length : before, 0, moved);
          tabs = rest;
          rev++;
          return list();
        }
        case "work.files.list": {
          const ref = params.at as FolderRef;
          const path = ref.at === "place" ? (ref.id === "folder" ? "/w" : ref.id) : ref.at === "file" ? ref.path : "";
          const entries = FOLDERS[path] ?? [];
          const found = (over.places ?? PLACES).find((p) => p.root.at === "file" && path.startsWith(p.root.path));
          const trail = found && found.root.at === "file" ? [{ name: found.name, at: found.root }, ...path.slice(found.root.path.length).split("/").filter(Boolean).map((name, i, all) => ({ name, at: at(`${(found.root as { path: string }).path}/${all.slice(0, i + 1).join("/")}`) }))] : [];
          return { entries, trail, place: found?.id, ...(over.asOf ? { asOf: over.asOf } : {}) } satisfies FilesListing;
        }
        case "work.files.stat":
          return { entries: (params.refs as unknown[]).map(() => null) };
        case "work.files.open": {
          const ref = params.ref as { path: string };
          const name = params.name as string;
          const key = (params.key as string | undefined) ?? refKey(params.ref as never);
          const was = tabs.find((t) => t.key === key);
          const item = items.find((i) => i.id === was?.itemId) ?? { id: `i${++ids}`, sessionId: "filespane_w1", workspaceId: "w1", kind: /\.xlsx$/.test(name) ? "sheet" : "document", title: name, source: { at: "file", host: "env_box", path: ref.path }, state: "open" as const, position: items.length, rev: 0, createdAt: 1, updatedAt: 1 };
          if (!was) {
            items.push(item);
            const tab: FileTab = { id: `t${++ids}`, kind: "file", name, itemId: item.id, key, ...(params.opener ? { opener: params.opener as string } : {}) };
            const after = tabs.findIndex((t) => t.id === params.opener);
            tabs.splice(after < 0 ? tabs.length : after + 1, 0, tab);
            rev++;
          }
          // The canvas says the pane's items as the host does after the tab lands.
          applyCanvasPush({ sessionId: "filespane_w1", items: items as never, opened: item.id });
          return { ...list(), tabId: (was ?? tabs.find((t) => t.itemId === item.id))!.id, item };
        }
        case "work.canvas.list":
          return { items };
        case "work.office.filesOpen":
          return { opened: true };
        case "work.files.threads":
          return { threads: over.threads ?? [] };
        case "session.create":
          return { id: params.id, title: "Budget questions", status: "idle", provider: params.provider, model: params.model, cwd: params.cwd, workspaceId: params.workspaceId, projectId: null, archived: false, createdAt: 1, updatedAt: 1 };
        case "work.canvas.open":
          return { id: `i${++ids}`, sessionId: params.sessionId, workspaceId: "w1", kind: params.kind, title: params.title, source: params.source, state: "open", position: 0, rev: 0, createdAt: 1, updatedAt: 1 };
        case "session.send":
          return {};
      }
      if (method.startsWith("session.")) return {};
      throw new Error(`unknown method: ${method}`);
    },
  };
  return host;
}

/** A host a release behind: it knows no `work.files.*`, and answers the old wire. */
function oldHost(): Host {
  const libraries: TeamsLibrariesAnswer = {
    host: "env_box",
    libraries: [{ id: "old~1", host: "env_box", path: "/cloud/Staff", team: "Esports Staff", library: null, tenant: "Dummy U", kind: "channels", channels: ["Events", "General"], web: null, found: true }],
    roots: [],
    off: [],
    places: [{ kind: "folders", state: "ok", account: null }],
  };
  const host: Host = {
    name: "The box",
    platform: "linux",
    calls: [],
    pushes: new Set(),
    answer(method, params) {
      if (method === "work.office.filesLibraries") return libraries;
      if (method === "work.office.filesCopyGet") return { on: false };
      if (method === "work.office.filesList") {
        const path = (params.source as { path: string }).path;
        return { entries: path === "/cloud/Staff/General" ? [{ name: "Plan.docx", path: "/cloud/Staff/General/Plan.docx", library: "old~1", kind: "document", size: 9, modified: 5, local: true, by: "Sam Ortiz" }, { name: "Budgets", path: "/cloud/Staff/General/Budgets", library: "old~1", kind: "folder", size: 0, modified: 4, local: true, by: null }] : [] };
      }
      throw new Error(`unknown method: ${method}`);
    },
  };
  return host;
}

beforeEach(async () => {
  hosts.clear();
  settings.mayUseDesktop = [];
  settings.windowsVm = false;
  localStorage.clear();
  sessionStorage.clear();
  resetFilesStore();
  resetCanvasStore();
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
  HTMLElement.prototype.releasePointerCapture ??= () => undefined;
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

const tabNames = (): string[] => within(screen.getByRole("tablist", { name: "Open tabs" })).getAllByRole("tab").map((t) => t.textContent ?? "");
const rows = (): string[] => [...document.querySelectorAll("[data-files-row]")].map((r) => r.querySelector("span span")?.textContent ?? "");
const row = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>("[data-files-row]")].find((r) => r.textContent?.startsWith(name))!;
const trail = (): string => screen.getByRole("navigation", { name: "Folder" }).textContent ?? "";
const calls = (host: Host, method: string) => host.calls.filter((c) => c.method === method);

async function mount(host: Host = newHost()) {
  hosts.set("box", host);
  const view = render(<View {...props} />);
  await waitFor(() => expect(document.querySelector("[data-files-view]:not([data-loading])")).not.toBeNull());
  return { host: host as ReturnType<typeof newHost>, view };
}

describe("the window", () => {
  it("draws its frame in bones until a host answers, then the places, the first tab and the folder", async () => {
    const host = newHost();
    hosts.set("box", host);
    const { container } = render(<View {...props} />);
    expect(container.querySelector("[data-files-view][data-loading]")).not.toBeNull();
    await waitFor(() => expect(rows()).toEqual(["Events", "Budget.xlsx", "notes.txt", "bundle.zip"]));
    // The first tab was made once, on the workspace's folder.
    expect(calls(host, "work.files.tabOpen")).toMatchObject([{ params: { first: true, page: { at: { at: "place", id: "folder" }, name: "Dummy Esports" } } }]);
    expect(tabNames()).toEqual(["Dummy Esports"]);
    const places = within(screen.getByRole("navigation", { name: "Places" }));
    // Each place is a row; the workspace's folder ends in the quiet chevron that opens its folders under it.
    expect([...places.getAllByRole("button")].filter((b) => b.textContent).map((b) => b.textContent)).toEqual(["Recent", "Starred", "Dummy Esports", "Esports Staff"]);
    expect(places.getByRole("button", { name: "Show the folders of Dummy Esports" }).getAttribute("aria-expanded")).toBe("false");
    expect(places.getByRole("button", { name: "Dummy Esports" }).getAttribute("aria-current")).toBe("page");
    expect(trail()).toBe("Dummy Esports");
  });

  it("marks itself for the app's key resolver and gives the tab row its own toolbar order", async () => {
    await mount();
    expect(document.querySelector("[data-files-view]")).not.toBeNull();
    expect(filesPort.mounted()).toBe(true);
    cleanup();
    expect(filesPort.mounted()).toBe(false);
  });
});

describe("a page", () => {
  it("opens a folder in the same tab on a second press, with its trail, and Back returns", async () => {
    const { host } = await mount();
    await waitFor(() => expect(rows()).toContain("Events"));
    fireEvent.click(row("Events"));
    expect(row("Events").getAttribute("aria-selected")).toBe("true");
    expect(calls(host, "work.files.tabSet")).toEqual([]);
    fireEvent.doubleClick(row("Events"));
    await waitFor(() => expect(rows()).toEqual(["Poster.png"]));
    expect(tabNames()).toEqual(["Events"]);
    expect(trail()).toBe("Dummy EsportsEvents");
    expect(calls(host, "work.files.tabSet")).toMatchObject([{ params: { page: { at: { at: "file", path: "/w/Events" }, name: "Events" } } }]);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(rows()).toContain("Budget.xlsx"));
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(rows()).toEqual(["Poster.png"]));
    // A step of the trail goes there.
    fireEvent.click(within(screen.getByRole("navigation", { name: "Folder" })).getByRole("button", { name: "Dummy Esports" }));
    await waitFor(() => expect(rows()).toContain("notes.txt"));
  });

  it("walks the list with the arrows and opens with Return", async () => {
    await mount();
    await waitFor(() => expect(rows()).toContain("Events"));
    const list = screen.getByRole("listbox", { name: "Files" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(row("Events").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(row("Budget.xlsx").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => expect(rows()).toEqual(["Poster.png"]));
  });

  it("sorts by a column's head, the host asked in that order, and keeps the order for this page alone", async () => {
    const { host } = await mount();
    await waitFor(() => expect(rows()).toContain("Events"));
    fireEvent.click(document.querySelector<HTMLElement>('[data-files-sort="changed"]')!);
    await waitFor(() => expect(calls(host, "work.files.list").at(-1)!.params.sort).toEqual({ by: "changed", dir: "desc" }));
    fireEvent.click(document.querySelector<HTMLElement>('[data-files-sort="changed"]')!);
    await waitFor(() => expect(calls(host, "work.files.list").at(-1)!.params.sort).toEqual({ by: "changed", dir: "asc" }));
    expect(JSON.parse(localStorage.getItem("work.files.view.v1")!)[sessionStorage.getItem("work.files.window")!].pages["place:folder"]).toEqual({ sort: { by: "changed", dir: "asc" } });
  });

  it("opens a team's page from the places already read, its channels as folders", async () => {
    const { host } = await mount();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Esports Staff" }));
    await waitFor(() => expect(rows()).toEqual(["Events", "General"]));
    expect(trail()).toBe("Esports Staff");
    const before = calls(host, "work.files.list").length;
    fireEvent.doubleClick(row("General"));
    await waitFor(() => expect(rows()).toEqual(["Plan.docx"]));
    expect(calls(host, "work.files.list")).toHaveLength(before + 1);
    expect(trail()).toBe("Esports StaffGeneral");
    // The team's row stays the one lit while he is inside one of its channels.
    expect(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Esports Staff" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("a folder's shapes", () => {
  const shape = (name: string): HTMLElement => within(screen.getByRole("group", { name: "View" })).getByRole("button", { name });

  it("draws the folder as tiles on Grid, keeps the shape for this page in this window, and opens with Return", async () => {
    const { host } = await mount();
    await waitFor(() => expect(rows()).toContain("Budget.xlsx"));
    fireEvent.click(shape("Grid"));
    const grid = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-files-grid]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(document.querySelector("[data-files-list]")).toBeNull();
    expect([...grid.querySelectorAll("[data-files-row]")].map((t) => t.getAttribute("data-kind"))).toEqual(["folder", "sheet", "text", "archive"]);
    expect(Object.values(JSON.parse(localStorage.getItem("work.files.view.v1")!)[sessionStorage.getItem("work.files.window")!].pages)).toEqual([{ shape: "grid" }]);
    // The arrows walk the tiles; Return opens the one they stand on.
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(grid.querySelector('[aria-selected="true"]')!.textContent).toContain("Budget.xlsx");
    fireEvent.keyDown(grid, { key: "Enter" });
    await waitFor(() => expect(calls(host, "work.files.open")).toHaveLength(1));
    // With no column heads, the order is chosen in View options.
    fireEvent.click(screen.getByRole("tab", { name: /Dummy Esports/ }));
    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /When Changed/ }).catch(() => screen.findByText("When Changed")));
    await waitFor(() => expect(calls(host, "work.files.list").at(-1)!.params.sort).toEqual({ by: "changed", dir: "desc" }));
  });

  it("draws a column a folder on Columns: a folder walked into adds its column, a file shows its facts last", async () => {
    await mount();
    await waitFor(() => expect(rows()).toContain("Events"));
    fireEvent.click(shape("Columns"));
    await waitFor(() => expect(document.querySelectorAll("[data-files-column]")).toHaveLength(1));
    const first = document.querySelector<HTMLElement>('[data-files-column="Dummy Esports"]')!;
    await waitFor(() => expect(within(first).getAllByRole("option").map((o) => o.textContent)).toEqual(["Events", "Budget.xlsx", "notes.txt", "bundle.zip"]));
    fireEvent.click(within(first).getByText("Events"));
    await waitFor(() => expect([...document.querySelectorAll("[data-files-column]")].map((c) => c.getAttribute("data-files-column"))).toEqual(["Dummy Esports", "Events"]));
    // The folder on the way down stays held in its column.
    expect(within(document.querySelector<HTMLElement>('[data-files-column="Dummy Esports"]')!).getByRole("option", { selected: true }).textContent).toBe("Events");
    const second = document.querySelector<HTMLElement>('[data-files-column="Events"]')!;
    fireEvent.click(await within(second).findByText("Poster.png"));
    const facts = await waitFor(() => {
      const el = document.querySelector("[data-files-details]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(facts.textContent).toContain("Poster.png");
    expect(facts.textContent).toContain("KindPicture");
    expect(within(facts as HTMLElement).getByRole("button", { name: "Open" })).toBeTruthy();
  });
});

describe("tabs", () => {
  it("opens a file in a tab of its own beside the tab it came from, under its own header, and never twice", async () => {
    const { host } = await mount();
    await waitFor(() => expect(rows()).toContain("Budget.xlsx"));
    fireEvent.doubleClick(row("Budget.xlsx"));
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports", "Budget.xlsx"]));
    expect(calls(host, "work.files.open")).toMatchObject([{ params: { workspaceId: "w1", name: "Budget.xlsx", key: "file:env_box:/w/Budget.xlsx" } }]);
    await waitFor(() => expect(screen.getByTestId("pane").textContent).toBe("sheet: Budget.xlsx"));
    const header = document.querySelector("[data-files-header]")!;
    expect(header.querySelector("h2")!.textContent).toBe("Budget.xlsx");
    expect(header.textContent).toContain("In w");
    expect(within(header as HTMLElement).getByRole("button", { name: "Ask" })).toBeTruthy();
    // No thread was made for it.
    expect(calls(host, "session.create")).toEqual([]);
    // From its tab back to the folder, the same file again selects its tab.
    fireEvent.pointerDown(within(screen.getByRole("tablist", { name: "Open tabs" })).getAllByRole("tab")[0]!, { button: 0 });
    await waitFor(() => expect(rows()).toContain("Budget.xlsx"));
    fireEvent.doubleClick(row("Budget.xlsx"));
    await waitFor(() => expect(screen.getByTestId("pane")).toBeTruthy());
    expect(tabNames()).toEqual(["Dummy Esports", "Budget.xlsx"]);
  });

  it("opens a file in a tab, never a thread, when another computer answers before the workspace's own host", async () => {
    // His Mac's window on a box workspace: the Mac says its places at once, the box a moment later.
    const mac = newHost({ places: [] });
    mac.name = "MacBook";
    mac.platform = "darwin";
    hosts.set("mac", mac);
    settings.mayUseDesktop = ["mac"];
    const box = newHost();
    const answer = box.answer.bind(box);
    let land!: () => void;
    const slow = new Promise<void>((done) => (land = done));
    box.answer = async (method, params) => {
      if (method === "work.files.places") await slow;
      return answer(method, params);
    };
    hosts.set("box", box);
    render(<View {...props} />);
    await waitFor(() => expect(calls(mac, "work.files.places")).toHaveLength(1));
    await waitFor(() => expect(document.querySelector("[data-files-view]:not([data-loading])")).not.toBeNull());
    land();
    await waitFor(() => expect(rows()).toContain("Budget.xlsx"));
    fireEvent.doubleClick(row("Budget.xlsx"));
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports", "Budget.xlsx"]));
    expect(calls(box, "work.files.open")).toHaveLength(1);
    expect(calls(box, "session.create")).toEqual([]);
    // The tabs are the host's, not this window's own.
    expect(box.tabs().map((t) => t.name)).toEqual(["Dummy Esports", "Budget.xlsx"]);
  });

  it("opens a file in a tab once its host answers after first missing its deadline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const box = newHost();
      const answer = box.answer.bind(box);
      let land!: () => void;
      const slow = new Promise<void>((done) => (land = done));
      let first = true;
      box.answer = async (method, params) => {
        if (method === "work.files.places" && first) {
          first = false;
          await slow;
        }
        return answer(method, params);
      };
      hosts.set("box", box);
      render(<View {...props} />);
      await vi.advanceTimersByTimeAsync(60_000);
      await waitFor(() => expect(document.querySelector("[data-files-view]:not([data-loading])")).not.toBeNull());
      land();
      await waitFor(() => expect(rows()).toContain("Budget.xlsx"));
      fireEvent.doubleClick(row("Budget.xlsx"));
      await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports", "Budget.xlsx"]));
      expect(calls(box, "session.create")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts Excel for a library's workbook only where the host seated it on Excel: in our own sheet editor no app is started", async () => {
    const sheet = file("/cloud/Staff/General/Roster.xlsx", "sheet", { key: "lib:esportsstaffgeneral:Roster.xlsx", shared: true });
    const old = file("/cloud/Staff/General/Old.xls", "sheet", { key: "lib:esportsstaffgeneral:Old.xls", shared: true });
    const host = newHost();
    const answer = host.answer.bind(host);
    host.answer = (method, params) => {
      if (method === "work.files.list" && (params.at as { path?: string }).path === "/cloud/Staff/General") return { entries: [sheet, old], cursor: null };
      const got = answer(method, params) as { item?: { source: unknown } };
      // The host seats a form no editor of ours edits in place on its Office app.
      if (method === "work.files.open" && params.name === "Old.xls") got.item!.source = { at: "microsoft", host: "env_box", app: "excel", name: "Old.xls", ref: { kind: "path", path: "/cloud/Staff/General/Old.xls" } };
      return got;
    };
    await mount(host);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Esports Staff" }));
    fireEvent.doubleClick(await waitFor(() => row("General")));
    await waitFor(() => expect(rows()).toContain("Roster.xlsx"));
    fireEvent.doubleClick(row("Roster.xlsx"));
    await waitFor(() => expect(tabNames()).toContain("Roster.xlsx"));
    expect(calls(host, "work.office.filesOpen")).toEqual([]);
    fireEvent.pointerDown(within(screen.getByRole("tablist", { name: "Open tabs" })).getAllByRole("tab")[0]!, { button: 0 });
    await waitFor(() => expect(rows()).toContain("Old.xls"));
    fireEvent.doubleClick(row("Old.xls"));
    await waitFor(() => expect(tabNames()).toContain("Old.xls"));
    expect(calls(host, "work.office.filesOpen")).toMatchObject([{ params: { source: { at: "file", host: "env_box", path: "/cloud/Staff/General/Old.xls" } } }]);
  });

  it("closes a tab and returns to the tab it was opened from; the last one closed is the workspace's folder again", async () => {
    const { host } = await mount();
    await waitFor(() => expect(rows()).toContain("Budget.xlsx"));
    fireEvent.doubleClick(row("Budget.xlsx"));
    await waitFor(() => expect(tabNames()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Close Budget.xlsx" }));
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports"]));
    expect(rows()).toContain("Budget.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "Close Dummy Esports" }));
    await waitFor(() => expect(calls(host, "work.files.tabClose")).toHaveLength(2));
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports"]));
  });

  it("follows a close made in another window: the tab goes and the tab it came from shows", async () => {
    const { host } = await mount();
    await waitFor(() => expect(rows()).toContain("notes.txt"));
    fireEvent.doubleClick(row("notes.txt"));
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports", "notes.txt"]));
    await waitFor(() => expect(screen.getByTestId("pane")).toBeTruthy());
    const gone = host.tabs().find((t) => t.kind === "file")!.id;
    await act(async () => host.closeElsewhere(gone));
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports"]));
    expect(screen.queryByTestId("pane")).toBeNull();
    expect(rows()).toContain("notes.txt");
  });

  it("takes the app's tab chords while focus is in the place: a new tab, the next one, Back, and close", async () => {
    const { host } = await mount();
    await waitFor(() => expect(rows()).toContain("Events"));
    await act(async () => void filesPort.run("new-tab"));
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports", "Dummy Esports"]));
    const [first, second] = host.tabs().map((t) => t.id);
    expect(document.querySelector(`[data-files-tab="${second}"]`)!.getAttribute("aria-selected")).toBe("true");
    await act(async () => void filesPort.run("next-tab"));
    expect(document.querySelector(`[data-files-tab="${first}"]`)!.getAttribute("aria-selected")).toBe("true");
    await act(async () => void filesPort.run("prev-tab"));
    expect(document.querySelector(`[data-files-tab="${second}"]`)!.getAttribute("aria-selected")).toBe("true");
    fireEvent.doubleClick(row("Events"));
    await waitFor(() => expect(rows()).toEqual(["Poster.png"]));
    await act(async () => void filesPort.run("back"));
    await waitFor(() => expect(rows()).toContain("Budget.xlsx"));
    await act(async () => void filesPort.run("forward"));
    await waitFor(() => expect(rows()).toEqual(["Poster.png"]));
    await act(async () => void filesPort.run("close-tab"));
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports"]));
  });

  it("keeps the tab shown for this window, and a new + tab opens on the workspace's folder", async () => {
    const { host } = await mount();
    await waitFor(() => expect(rows()).toContain("Events"));
    fireEvent.click(screen.getByRole("button", { name: "New Tab" }));
    await waitFor(() => expect(tabNames()).toHaveLength(2));
    const second = host.tabs()[1]!.id;
    expect(JSON.parse(localStorage.getItem("work.files.view.v1")!)[sessionStorage.getItem("work.files.window")!].selected).toEqual({ w1: second });
  });

  it("opens a file no viewer shows in a tab too: every file opens, and nothing says there is no viewer", async () => {
    const { host } = await mount();
    await waitFor(() => expect(rows()).toContain("bundle.zip"));
    fireEvent.doubleClick(row("bundle.zip"));
    await waitFor(() => expect(calls(host, "work.files.open")).toHaveLength(1));
    expect(calls(host, "work.files.open")[0]).toMatchObject({ params: { name: "bundle.zip" } });
  });
});

describe("the sidebar", () => {
  it("folds with its toggle and remembers it for this window", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Hide Sidebar" }));
    expect(screen.queryByRole("navigation", { name: "Places" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("work.files.view.v1")!)[sessionStorage.getItem("work.files.window")!].folded).toEqual({ w1: true });
    fireEvent.click(screen.getByRole("button", { name: "Show Sidebar" }));
    expect(screen.getByRole("navigation", { name: "Places" })).toBeTruthy();
  });

  it("opens a place in a new tab on a middle click", async () => {
    await mount();
    fireEvent(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Starred" }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports", "Starred"]));
  });
});

describe("the states", () => {
  it("says an empty folder in one line", async () => {
    await mount();
    fireEvent.doubleClick(await waitFor(() => row("Events")));
    await waitFor(() => expect(rows()).toEqual(["Poster.png"]));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Starred" }));
    await waitFor(() => expect(screen.getByText("This folder is empty")).toBeTruthy());
  });

  it("says a folder that did not load, with Retry", async () => {
    await mount(newHost({ fail: { "work.files.list": "That folder is not there any more." } }));
    await waitFor(() => expect(screen.getByText("This folder did not load")).toBeTruthy());
    expect(screen.getByText("That folder is not there any more.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says a sleeping machine over the list it kept, with Wake it", async () => {
    const places = PLACES.map((p) => (p.kind === "teams" ? { ...p, vm: true as const, host: "Windows VM", state: { state: "asleep" as const, at: 1_700_000_000_000 } } : p));
    settings.windowsVm = true;
    await mount(newHost({ places, asOf: 1_700_000_000_000 }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Esports Staff" }));
    fireEvent.doubleClick(await waitFor(() => row("General")));
    await waitFor(() => expect(rows()).toEqual(["Plan.docx"]));
    const note = document.querySelector("[data-files-note]")!;
    expect(note.textContent).toMatch(/^The Windows VM is asleepThis is the list from .+\.Wake it$/);
  });

  it("with no Teams place listed, draws one greyed row that says why when opened, with its press", async () => {
    settings.windowsVm = true;
    await mount(newHost({ places: PLACES.filter((p) => p.kind !== "teams"), sources: [{ kind: "vm", state: "signed-out", account: null }] }));
    const teams = within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Teams files" });
    expect(teams.getAttribute("data-down")).toBe("true");
    fireEvent.click(teams);
    await waitFor(() => expect(screen.getByText("OneDrive on the Windows VM is signed out")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Sign in to OneDrive" })).toBeTruthy();
  });

  it("offers Allow where the workspace may use no computer that has his files yet, and no row where nothing is wrong", async () => {
    await mount(newHost({ places: PLACES.filter((p) => p.kind !== "teams"), sources: [{ kind: "vm", state: "ok", account: "a@dummy.edu" }] }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Teams files" }));
    await waitFor(() => expect(screen.getByText("This workspace can't use your computers yet")).toBeTruthy());
    expect(screen.getByText("Allow the Windows VM to list your Teams files.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    cleanup();
    resetFilesStore();
    await mount(newHost({ places: PLACES.filter((p) => p.kind !== "teams") }));
    expect(within(screen.getByRole("navigation", { name: "Places" })).queryByRole("button", { name: "Teams files" })).toBeNull();
  });
});

describe("a host a release behind", () => {
  it("lists its libraries through the old wire, keeps its tabs in the window alone, and says so in one line", async () => {
    const host = oldHost();
    hosts.set("box", host);
    render(<View {...props} />);
    await waitFor(() => expect(document.querySelector("[data-files-behind]")?.textContent).toBe("Update The box to keep tabs here"));
    expect(calls(host, "work.office.filesLibraries")).toHaveLength(1);
    expect(tabNames()).toEqual(["Dummy Esports"]);
    // It keeps no marks and has no folder place of its own on this wire.
    const places = within(screen.getByRole("navigation", { name: "Places" }));
    expect([...places.getAllByRole("button")].map((b) => b.textContent)).toEqual(["Esports Staff"]);
    fireEvent.click(places.getByRole("button", { name: "Esports Staff" }));
    await waitFor(() => expect(rows()).toEqual(["Events", "General"]));
    fireEvent.doubleClick(row("General"));
    // The old wire lists a folder whole and unsorted: the window puts folders first.
    await waitFor(() => expect(rows()).toEqual(["Budgets", "Plan.docx"]));
    expect(calls(host, "work.office.filesList")).toMatchObject([{ params: { source: { at: "file", host: "env_box", path: "/cloud/Staff/General" } } }]);
    expect(trail()).toBe("Esports StaffGeneral");
    // Nothing of the new wire was asked again once it was found missing, and no tab went to the host.
    expect(calls(host, "work.files.tabOpen")).toEqual([]);
    expect(calls(host, "work.files.list")).toEqual([]);
  });
  it("still keeps its tabs in the window when another computer answered first", async () => {
    const mac = newHost({ places: [] });
    mac.name = "MacBook";
    mac.platform = "darwin";
    hosts.set("mac", mac);
    settings.mayUseDesktop = ["mac"];
    const host = oldHost();
    const answer = host.answer.bind(host);
    let land!: () => void;
    const slow = new Promise<void>((done) => (land = done));
    host.answer = async (method, params) => {
      if (method === "work.files.places") await slow;
      return answer(method, params);
    };
    hosts.set("box", host);
    render(<View {...props} />);
    await waitFor(() => expect(document.querySelector("[data-files-view]:not([data-loading])")).not.toBeNull());
    land();
    await waitFor(() => expect(document.querySelector("[data-files-behind]")?.textContent).toBe("Update The box to keep tabs here"));
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports"]));
    expect(calls(host, "work.files.tabOpen")).toEqual([]);
  });
});

describe("the chat docked beside a file", () => {
  const widths = { view: 1400, body: 1200 };
  let sent: Promise<unknown>[] = [];
  beforeEach(() => {
    sessionStore.reset();
    resetContextChips();
    resetDocks();
    sent = [];
    widths.view = 1400;
    widths.body = 1200;
    // The draft as App seeds one: the workspace's, placed nowhere.
    workDockPort.set({
      draft: (ws, id) => ({ ...newSession("box", "claude", ws.path, undefined, undefined, undefined, { projectId: null, workspaceId: ws.id }), ...(id ? { id } : {}) }),
      openFile: () => undefined,
      openDiff: () => undefined,
    });
    // App's send, as the composer calls it: the chips go into the message, then the composer's normal path.
    dock.submit = (id, text) => {
      // As App's onSubmit: a session not in the open set is not sent.
      const session = sessionStore.getSnapshot().find((s) => s.id === id);
      if (!session) return;
      const message = chipPort.get()?.send(id, !sessionStore.metaOf(id), text) ?? text;
      sent.push(send(session, message).catch((err: unknown) => err));
    };
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-files-view") ? widths.view : this.hasAttribute("data-files-body") ? widths.body : 0;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    workDockPort.set(null);
    workOpenPort.set(null);
  });

  async function openBudget(host = newHost()) {
    const mounted = await mount(host);
    await waitFor(() => expect(rows()).toContain("Budget.xlsx"));
    fireEvent.doubleClick(row("Budget.xlsx"));
    await waitFor(() => expect(screen.getByTestId("pane").textContent).toBe("sheet: Budget.xlsx"));
    return mounted;
  }
  const askButton = (): HTMLElement => within(document.querySelector("[data-files-header]") as HTMLElement).getByRole("button", { name: "Ask" });
  const docked = (): HTMLElement | null => document.querySelector("[data-files-dock]");
  const chips = (): string[] => [...document.querySelectorAll("[aria-label='Chips'] li")].map((li) => li.textContent ?? "");

  it("opens a chat beside the file on Ask: a draft, the file's chip in its composer, and nothing on the host", async () => {
    const { host } = await openBudget();
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByTestId("chat")).toBeTruthy());
    expect(askButton().getAttribute("aria-pressed")).toBe("true");
    const dockEl = docked()!;
    expect(within(dockEl).getByRole("heading").textContent).toBe("New chat");
    expect(dockEl.hasAttribute("data-draft")).toBe(true);
    expect(screen.getByTestId("chat").dataset.seat).toBe("false");
    expect(chips()).toEqual(["Budget.xlsx"]);
    expect(document.querySelector("[data-files-dock-seat]")!.getAttribute("data-files-dock-seat")).toBe("beside");
    expect((document.querySelector("[data-files-dock-seat]") as HTMLElement).style.width).toBe("360px");
    expect(document.querySelector("[data-files-sash]")).not.toBeNull();
    // Nothing was made: no create, no item, no row a rail could list.
    expect(calls(host, "session.create")).toEqual([]);
    expect(calls(host, "work.canvas.open")).toEqual([]);
    expect(sessionStore.metas()).toEqual([]);
    expect(within(dockEl).queryByRole("button", { name: "Open in its own tab" })).toBeNull();
  });

  it("leaves nothing behind when closed with nothing sent, by its close control or by Ask again", async () => {
    const { host } = await openBudget();
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByTestId("chat")).toBeTruthy());
    const id = screen.getByTestId("chat").dataset.session!;
    expect(sessionStore.isOpen(id)).toBe(true);
    fireEvent.click(within(docked()!).getByRole("button", { name: "Close chat" }));
    expect(docked()).toBeNull();
    expect(askButton().getAttribute("aria-pressed")).toBe("false");
    expect(sessionStore.isOpen(id)).toBe(false);
    // Opened again, it is the same draft (what he typed is kept with it); Ask closes it as well.
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByTestId("chat").dataset.session).toBe(id));
    fireEvent.click(askButton());
    expect(docked()).toBeNull();
    expect(sessionStore.isOpen(id)).toBe(false);
    expect(calls(host, "session.create")).toEqual([]);
    expect(calls(host, "work.canvas.open")).toEqual([]);
    expect(sessionStore.metas()).toEqual([]);
  });

  it("shows the thread that already holds the file instead of a draft, with Open in its own tab", async () => {
    const host = newHost({ threads: [{ sessionId: "s9", itemId: "i9", source: { at: "file", host: "env_box", path: "/w/Budget.xlsx" } }] });
    sessionStore.adopt({ id: "s9", environmentId: "box", title: "Q3 budget", status: "idle", archived: false, workspaceId: "w1", projectId: null, scope: "work" } as never, { created: true });
    const opened: string[] = [];
    workOpenPort.set((id) => opened.push(id));
    await openBudget(host);
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByTestId("chat").dataset.session).toBe("s9"));
    expect(calls(host, "work.files.threads")).toMatchObject([{ params: { workspaceId: "w1", ref: { at: "file", host: "env_box", path: "/w/Budget.xlsx" } } }]);
    expect(within(docked()!).getByRole("heading").textContent).toBe("Q3 budget");
    expect(chips()).toEqual([]);
    fireEvent.click(within(docked()!).getByRole("button", { name: "Open in its own tab" }));
    expect(opened).toEqual(["s9"]);
    // Closing it leaves the thread as it was.
    fireEvent.click(within(docked()!).getByRole("button", { name: "Close chat" }));
    expect(sessionStore.metaOf("s9")).toBeTruthy();
    expect(calls(host, "session.create")).toEqual([]);
  });

  it("makes the thread on the first send, and the thread opens the file before the message goes", async () => {
    const { host } = await openBudget();
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByTestId("chat")).toBeTruthy());
    const id = screen.getByTestId("chat").dataset.session!;
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "What does row 4 add up to?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls(host, "session.send")).toHaveLength(1));
    const order = host.calls.map((c) => c.method).filter((m) => m === "session.create" || m === "work.canvas.open" || m === "session.send");
    expect(order).toEqual(["session.create", "work.canvas.open", "session.send"]);
    expect(calls(host, "session.create")).toMatchObject([{ params: { id, workspaceId: "w1", about: { kind: "file", label: "Budget.xlsx" } } }]);
    expect(calls(host, "work.canvas.open")).toMatchObject([{ params: { sessionId: id, kind: "sheet", title: "Budget.xlsx", source: { at: "file", host: "env_box", path: "/w/Budget.xlsx" } } }]);
    const message = calls(host, "session.send")[0]!.params.text as string;
    expect(message).toContain('About this file: Budget.xlsx ({"at":"file","host":"env_box","path":"/w/Budget.xlsx"})');
    expect(message).toContain("What does row 4 add up to?");
    // Now a thread like any other: the dock keeps showing it, by its title, with Open in its own tab.
    await waitFor(() => expect(within(docked()!).getByRole("heading").textContent).toBe("Budget questions"));
    expect(screen.getByTestId("chat").dataset.session).toBe(id);
    expect(within(docked()!).getByRole("button", { name: "Open in its own tab" })).toBeTruthy();
    expect(sessionStore.metaOf(id)).toBeTruthy();
    // Closed, it stays a thread.
    fireEvent.click(within(docked()!).getByRole("button", { name: "Close chat" }));
    expect(sessionStore.metaOf(id)).toBeTruthy();
  });

  it("under StrictMode, keeps the draft open and its first send still opens the file first", async () => {
    const host = newHost();
    hosts.set("box", host);
    render(
      <StrictMode>
        <View {...props} />
      </StrictMode>,
    );
    await waitFor(() => expect(rows()).toContain("Budget.xlsx"));
    fireEvent.doubleClick(row("Budget.xlsx"));
    await waitFor(() => expect(screen.getByTestId("pane").textContent).toBe("sheet: Budget.xlsx"));
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByTestId("chat")).toBeTruthy());
    const id = screen.getByTestId("chat").dataset.session!;
    expect(sessionStore.isOpen(id)).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Totals?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls(host, "session.send")).toHaveLength(1));
    expect(host.calls.map((c) => c.method).filter((m) => m === "session.create" || m === "work.canvas.open" || m === "session.send")).toEqual(["session.create", "work.canvas.open", "session.send"]);
  });

  it("puts a selection's Ask in the docked composer as a chip, opening the dock", async () => {
    const { host } = await openBudget();
    fireEvent.click(screen.getByRole("button", { name: "Ask about the selection" }));
    await waitFor(() => expect(chips()).toEqual(["Budget.xlsx", "B2:C4"]));
    expect(askButton().getAttribute("aria-pressed")).toBe("true");
    expect(calls(host, "session.create")).toEqual([]);
  });

  it("folds the sidebar under 900px of view while the dock is open, and brings it back when it closes", async () => {
    widths.view = 800;
    await openBudget();
    expect(screen.queryByRole("navigation", { name: "Places" })).not.toBeNull();
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByTestId("chat")).toBeTruthy());
    expect(screen.queryByRole("navigation", { name: "Places" })).toBeNull();
    fireEvent.click(within(docked()!).getByRole("button", { name: "Close chat" }));
    expect(screen.queryByRole("navigation", { name: "Places" })).not.toBeNull();
  });

  it("lies over the whole body, without a sash, where the file would get under 560px", async () => {
    widths.body = 700;
    await openBudget();
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByTestId("chat")).toBeTruthy());
    expect(document.querySelector("[data-files-dock-seat]")!.getAttribute("data-files-dock-seat")).toBe("over");
    expect(document.querySelector("[data-files-sash]")).toBeNull();
    expect(within(docked()!).getByRole("button", { name: "Close chat" })).toBeTruthy();
  });

  it("keeps which tab has it open and its width for this window, and drops it with the tab", async () => {
    const { host, view } = await openBudget();
    fireEvent.click(askButton());
    await waitFor(() => expect(screen.getByTestId("chat")).toBeTruthy());
    // The arrows step 2% of the body: Left widens the dock at the right.
    fireEvent.keyDown(document.querySelector("[data-files-sash]")!, { key: "ArrowLeft" });
    expect((document.querySelector("[data-files-dock-seat]") as HTMLElement).style.width).toBe("384px");
    const tabId = host.tabs().find((t) => t.kind === "file")!.id;
    const kept = JSON.parse(localStorage.getItem("work.files.view.v1")!) as Record<string, { docks?: Record<string, true>; dock?: number }>;
    expect(Object.values(kept)[0]).toMatchObject({ docks: { [`w1/${tabId}`]: true }, dock: 384 });
    // The window again (its store read afresh): the file's tab shows, its dock open at the kept width.
    view.unmount();
    resetFilesStore();
    resetCanvasStore();
    await mount(host);
    await waitFor(() => expect(screen.getByTestId("chat")).toBeTruthy());
    expect((document.querySelector("[data-files-dock-seat]") as HTMLElement).style.width).toBe("384px");
    // Closing the file's tab closes its dock, and forgets it.
    fireEvent.click(within(document.querySelector("[data-files-header]") as HTMLElement).getByRole("button", { name: "More for Budget.xlsx" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Close Tab/ }));
    await waitFor(() => expect(docked()).toBeNull());
    const after = JSON.parse(localStorage.getItem("work.files.view.v1")!) as Record<string, { docks?: Record<string, true> }>;
    expect(Object.values(after)[0]!.docks).toEqual({});
  });
});
