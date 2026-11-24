// @vitest-environment jsdom
/**
 * Make and manage in the Files place (docs/DESIGN.md "The Files place"): New, a name typed in place, the selection
 * and its bar, a row's menu, Move to…, Delete with Undo, Trash, an upload and a drag, against a stand-in host that
 * keeps a folder on a disk of its own and answers the verbs of `work.files.*` as the real one does.
 */
import { act, cleanup, configure, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDone, FilePage, FilesListing, FilesPlaces, FileTab } from "@shared/contract-work-files";
import type { FileEntry, FilePlace, FolderRef, MakeKind } from "@shared/work/files";
import { kindOfEntry, refKey } from "@shared/work/files";
import { openMenus } from "../../chrome/menuRows";
import { filesPort } from "../../lib/filesKeys";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import type { WorkViewProps } from "../views/registry";

// The whole suite runs these beside a hundred other files: a wait for the screen is given room.
configure({ asyncUtilTimeout: 5000 });

type Push = Record<string, unknown>;
interface Host {
  calls: { method: string; params: Record<string, unknown> }[];
  pushes: Set<(push: Push) => void>;
  answer(method: string, params: Record<string, unknown>): unknown;
}
const world = vi.hoisted(() => ({
  host: null as unknown,
  toasts: [] as { kind: string; title: string; description?: string; undo?: () => void }[],
  asked: [] as { title: string; action: string }[],
  /** each question's line under its title, in order */
  bodies: [] as (string | undefined)[],
  yes: true,
  started: [] as { chips: { kind: string; label: string; where?: { place: string } }[]; at: unknown }[],
}));

vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => {
    const host = world.host as Host;
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
    registry: { linkOf, link: linkOf, has: () => true, environment: (id: string) => ({ id, name: "The box", platform: "linux" }), environments: () => [{ id: "box", name: "The box", platform: "linux" }], onLink: () => () => undefined },
  };
});
vi.mock("../shell/actions", () => ({ workspaceSettings: async () => ({ mayUseDesktop: [], windowsVm: false, voice: false }), localHostId: async () => null, windowDesktops: async () => [], linkIdOfHost: () => "box", allowComputers: vi.fn() }));
vi.mock("../winvm/signIn", () => ({ openVm: vi.fn(), signInOnVm: vi.fn(async () => undefined) }));
vi.mock("../canvas/CanvasPane", () => ({ CanvasPane: () => <div data-testid="pane" /> }));
// What a change says is one toast: here each is kept, with its Undo.
vi.mock("../../components/ui/toaster", () => {
  const put = (kind: string) => (title: string, o: { description?: string; action?: { onClick(): void } } = {}) => void world.toasts.push({ kind, title, ...(o.description ? { description: o.description } : {}), ...(o.action ? { undo: o.action.onClick } : {}) });
  return { loadToast: async () => ({ message: put("message"), error: put("error"), success: put("success") }) };
});
// A question before a change is the app's own confirm: here it is answered at once, and kept.
vi.mock("../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<typeof import("../../chrome/ConfirmDialog")>()),
  confirmAction: async (request: { title: string; body?: string; action: string }) => (world.asked.push({ title: request.title, action: request.action }), world.bodies.push(request.body), world.yes),
}));

const { View } = await import("./FilesView");
const { resetFilesStore } = await import("./store");
const { applyCanvasPush, resetCanvasStore } = await import("../canvas/store");

const workspace = { id: "w1", environmentId: "box", path: "/w", name: "Dummy Esports", kind: "work", sector: "purdue" } as unknown as WorkspaceMeta;
const props = { env: "box", workspace, sector: "purdue", lifeos: {}, startThread: (chips: unknown, at: unknown) => void world.started.push({ chips: (Array.isArray(chips) ? chips : [chips]) as never, at }) } as unknown as WorkViewProps;
const at = (path: string): FolderRef & { at: "file" } => ({ at: "file", host: "env_box", path });
const ALL = ["make", "upload", "rename", "move", "copy", "edit", "trash", "restore", "purge"] as const;
const lens = (id: string, kind: FilePlace["kind"], name: string, can: FilePlace["can"] = []): FilePlace => ({ id, kind, name, host: "", env: "env_box", shared: false, can, state: { state: "ok" }, root: { at: "place", id } });
const PLACES: FilePlace[] = [
  lens("recent", "recent", "Recent"),
  lens("starred", "starred", "Starred"),
  lens("trash", "trash", "Trash", ["restore", "purge"]),
  { ...lens("folder", "folder", "Dummy Esports", [...ALL]), root: at("/w"), makes: ["document", "sheet", "deck", "text", "folder"] },
  { ...lens("b1", "teams", "General", ["make", "rename", "move", "copy", "edit"]), shared: true, group: "General", key: "general", root: at("/cloud/General"), makes: ["text", "folder"] },
  { ...lens("b2", "teams", "Esports", ["make", "rename", "move", "copy", "edit", "trash"]), shared: true, group: "Esports", key: "esports", root: at("/cloud/Esports") },
];

/** A host that keeps a folder: paths to what is there (true: a folder), and what Trash holds. */
function diskHost(start: Record<string, boolean>, o: { home?: boolean } = {}) {
  const disk = new Map(Object.entries(start));
  const trashed: { id: string; path: string; dir: boolean }[] = [];
  const stars = new Set<string>();
  let tabs: FileTab[] = [];
  const items: Record<string, unknown>[] = [];
  const saved: { id: string; name: string; query: string }[] = [];
  let rev = 0;
  let ids = 0;
  const name = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
  const parent = (path: string): string => path.slice(0, path.lastIndexOf("/"));
  const entry = (path: string): FileEntry => {
    const dir = disk.get(path) === true;
    const shared = path.startsWith("/cloud");
    return { key: refKey(at(path)), ref: dir ? null : at(path), folder: dir ? at(path) : null, name: name(path), kind: dir ? "folder" : kindOfEntry(name(path)).kind, changed: 1_700_000_000_000, ...(shared ? { shared } : {}), ...(stars.has(path) ? { starred: true } : {}) };
  };
  const pathOf = (ref: unknown): string => {
    const r = ref as FolderRef;
    return r.at === "place" ? (r.id === "folder" ? "/w" : r.id === "b1" ? "/cloud/General" : r.id === "b2" ? "/cloud/Esports" : r.id) : r.at === "file" ? r.path : "";
  };
  const host: Host & { disk: Map<string, boolean>; trashed: typeof trashed; say(dir: string): void; fail: Record<string, string> } = {
    calls: [],
    pushes: new Set(),
    disk,
    trashed,
    fail: {},
    say: (dir) => host.pushes.forEach((listener) => listener({ push: "work.files", workspaceId: "w1", at: refKey(at(dir)) })),
    answer(method, params) {
      if (host.fail[method]) throw new Error(host.fail[method]);
      const list = (): { rev: number; tabs: FileTab[] } => ({ rev, tabs: [...tabs] });
      const done = (paths: string[], more: Partial<FileDone> = {}): FileDone => ({ entries: paths.map(entry), refused: [], op: params.op as string, ...more });
      const carry = (from: string, to: string): void => {
        for (const [path, dir] of [...disk]) {
          if (path !== from && !path.startsWith(`${from}/`)) continue;
          disk.delete(path);
          disk.set(`${to}${path.slice(from.length)}`, dir);
        }
      };
      switch (method) {
        case "work.files.places":
          return { host: "env_box", places: o.home ? [lens("home", "home", "Home"), ...PLACES] : PLACES, rev, sources: [] } satisfies FilesPlaces;
        case "work.office.filesCopyGet":
          return { on: false };
        case "work.files.tabs":
          return list();
        case "work.canvas.list":
          return { items };
        case "work.files.open": {
          const path = pathOf(params.ref);
          const item = { id: `i${++ids}`, sessionId: "filespane_w1", workspaceId: "w1", kind: "sheet", title: name(path), source: at(path), state: "open", position: 0, rev: 0, createdAt: 1, updatedAt: 1 };
          items.push(item);
          const tab: FileTab = { id: `t${++ids}`, kind: "file", name: name(path), itemId: item.id, key: refKey(at(path)) };
          tabs.push(tab);
          rev++;
          applyCanvasPush({ sessionId: "filespane_w1", items: items as never, opened: item.id });
          return { ...list(), tabId: tab.id, item };
        }
        case "work.files.stat":
          return { entries: (params.refs as unknown[]).map(() => null) };
        case "work.files.tabOpen": {
          if (params.first && tabs.length) return { ...list(), tabId: tabs[0]!.id };
          const page = params.page as FilePage;
          const tab: FileTab = { id: `t${++ids}`, kind: "page", name: page.name, page };
          const after = tabs.findIndex((t) => t.id === params.after);
          tabs.splice(after < 0 ? tabs.length : after + 1, 0, tab);
          rev++;
          return { ...list(), tabId: tab.id };
        }
        case "work.files.tabClose": {
          const gone = tabs.find((t) => t.id === params.tabId);
          tabs = tabs.filter((t) => t.id !== params.tabId);
          if (gone?.itemId) items.splice(items.findIndex((i) => i.id === gone.itemId), 1);
          if (!tabs.length) tabs = [{ id: `t${++ids}`, kind: "page", name: "Dummy Esports", page: { at: { at: "place", id: "folder" }, name: "Dummy Esports" } }];
          rev++;
          return list();
        }
        case "work.files.tabSet": {
          const page = params.page as FilePage;
          tabs = tabs.map((t) => (t.id === params.tabId ? { ...t, name: page.name, page } : t));
          rev++;
          return list();
        }
        case "work.files.list": {
          const ref = params.at as FolderRef;
          if (ref.at === "place" && ref.id === "trash") {
            return { entries: trashed.map((t) => ({ key: `trash:${t.id}`, ref: null, folder: null, name: name(t.path), kind: t.dir ? "folder" : kindOfEntry(name(t.path)).kind, changed: 1_700_000_100_000, where: { place: "folder", name: "Dummy Esports", trail: parent(t.path).split("/").slice(2) } })), place: "trash", trail: [{ name: "Trash", at: ref }] } satisfies FilesListing;
          }
          if (ref.at === "place" && ref.id === "starred") return { entries: [...stars].map(entry), place: "starred", trail: [{ name: "Starred", at: ref }] } satisfies FilesListing;
          const dir = pathOf(ref);
          const top = dir.startsWith("/cloud") ? "/cloud/General" : "/w";
          const rest = dir.slice(top.length).split("/").filter(Boolean);
          const entries = [...disk.keys()].filter((p) => parent(p) === dir).sort((a, b) => Number(disk.get(b)) - Number(disk.get(a)) || a.localeCompare(b)).map(entry);
          const listed = params.foldersOnly ? entries.filter((e) => e.folder) : entries;
          return { entries: listed, place: top === "/w" ? "folder" : "b1", trail: [{ name: top === "/w" ? "Dummy Esports" : "General", at: at(top) }, ...rest.map((n, i) => ({ name: n, at: at(`${top}/${rest.slice(0, i + 1).join("/")}`) }))] } satisfies FilesListing;
        }
        case "work.files.make": {
          const dir = pathOf(params.at);
          const kind = params.kind as MakeKind;
          const base = { document: "Untitled document.tcdoc", sheet: "Untitled sheet.tcsheet", deck: "Untitled deck.pptx", text: "Untitled.md", folder: "Untitled folder" }[kind];
          disk.set(`${dir}/${base}`, kind === "folder");
          host.say(dir);
          return done([`${dir}/${base}`]);
        }
        case "work.files.rename": {
          const from = pathOf(params.ref);
          const to = `${parent(from)}/${params.name as string}`;
          if (disk.has(to)) throw new Error(`A file named "${params.name as string}" is already there.`);
          carry(from, to);
          host.say(parent(from));
          return done([to]);
        }
        case "work.files.move":
        case "work.files.copy": {
          const to = pathOf(params.to);
          const made: string[] = [];
          for (const ref of params.refs as unknown[]) {
            const from = pathOf(ref);
            const next = `${to}/${name(from)}`;
            if (method === "work.files.move") carry(from, next);
            else disk.set(next, disk.get(from)!);
            made.push(next);
            host.say(parent(from));
          }
          host.say(to);
          return done(made);
        }
        case "work.files.trash": {
          const gone: string[] = [];
          for (const ref of params.refs as unknown[]) {
            const path = pathOf(ref);
            const id = `r${++ids}`;
            trashed.push({ id, path, dir: disk.get(path) === true });
            for (const p of [...disk.keys()]) if (p === path || p.startsWith(`${path}/`)) disk.delete(p);
            gone.push(id);
            host.say(parent(path));
          }
          return done([], { trashed: gone });
        }
        case "work.files.restore": {
          const back: string[] = [];
          for (const id of params.ids as string[]) {
            const i = trashed.findIndex((t) => t.id === id);
            if (i < 0) continue;
            const [row] = trashed.splice(i, 1);
            disk.set(row!.path, row!.dir);
            back.push(row!.path);
            host.say(parent(row!.path));
          }
          return done(back);
        }
        case "work.files.purge": {
          const only = params.ids as string[] | undefined;
          const before = trashed.length;
          for (let i = trashed.length - 1; i >= 0; i--) if (!only || only.includes(trashed[i]!.id)) trashed.splice(i, 1);
          return { purged: before - trashed.length };
        }
        case "work.files.star": {
          const path = pathOf(params.ref);
          if (params.on) stars.add(path);
          else stars.delete(path);
          return { starred: params.on };
        }
        case "work.files.names": {
          const words = (params.text as string).toLowerCase().split(/\s+/).filter(Boolean);
          const all = [...disk.keys()].filter((p) => p.startsWith("/w/")).map(entry);
          return { entries: (words.length ? all.filter((e) => words.every((w) => e.name.toLowerCase().includes(w))) : all.slice(0, 2)).map((e) => ({ ...e, where: { place: "folder", name: "Dummy Esports", trail: parent(pathOf(e.ref ?? e.folder)).split("/").slice(2) } })) };
        }
        case "work.files.search": {
          const words = (params.query as string).toLowerCase().split(/\s+/).filter(Boolean);
          const kinds = (params.filter as { kinds?: string[] } | undefined)?.kinds;
          const hits = [...disk.keys()].map(entry).filter((e) => words.every((w) => e.name.toLowerCase().includes(w)) && (!kinds?.length || kinds.includes(e.kind)));
          return { entries: hits.map((e) => ({ ...e, where: { place: "folder", name: pathOf(e.ref ?? e.folder).startsWith("/cloud") ? "General" : "Dummy Esports", trail: [] } })), place: "search" } satisfies FilesListing;
        }
        case "work.files.home":
          return { waiting: [], starred: [...stars].map(entry), recent: [entry("/w/Budget.xlsx")] };
        case "work.files.searches":
          return { searches: saved };
        case "work.files.saveSearch": {
          const kept = { id: `s${++ids}`, name: params.name as string, query: params.query as string, ...(params.filter ? { filter: params.filter as never } : {}) };
          saved.push(kept);
          return kept;
        }
        case "work.files.dropSearch":
          saved.splice(saved.findIndex((x) => x.id === params.id), 1);
          return null;
        case "work.files.upload":
          return { uploadId: `u${++ids}:${pathOf(params.at)}/${params.name as string}` };
        case "attachment.chunk":
          return null;
        case "attachment.commit": {
          const path = (params.uploadId as string).split(":")[1]!;
          disk.set(path, false);
          host.say(parent(path));
          return { path };
        }
      }
      throw new Error(`unknown method: ${method}`);
    },
  };
  return host;
}

let host: ReturnType<typeof diskHost>;
beforeEach(async () => {
  host = diskHost({ "/w/Events": true, "/w/Events/Poster.png": false, "/w/Archive": true, "/w/Budget.xlsx": false, "/w/notes.txt": false, "/w/Plan.docx": false, "/cloud/General/Agenda.docx": false });
  world.host = host;
  world.toasts.length = 0;
  world.asked.length = 0;
  world.bodies.length = 0;
  world.started.length = 0;
  world.yes = true;
  localStorage.clear();
  sessionStorage.clear();
  resetFilesStore();
  resetCanvasStore();
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

const rows = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-files-list] [data-files-row]")].map((r) => r.querySelector("span span")?.textContent ?? r.querySelector("input")?.value ?? "");
const row = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>("[data-files-row]")].find((r) => r.textContent?.startsWith(name))!;
const picked = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-files-row][aria-selected="true"]')].map((r) => r.querySelector("span span")?.textContent ?? "");
const calls = (method: string): Record<string, unknown>[] => host.calls.filter((c) => c.method === method).map((c) => c.params);
const list = (): HTMLElement => document.querySelector<HTMLElement>("[data-files-list]")!;
async function mount() {
  render(<View {...props} />);
  await waitFor(() => expect(rows()).toContain("Budget.xlsx"));
}
const menuItem = (name: string | RegExp): Promise<HTMLElement> => screen.findByRole("menuitem", { name });

describe("New", () => {
  it("offers what the place makes, says where it is kept, makes the thing at once and lets him name it in place", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Document", "Sheet", "Deck", "Text file", "Folder", "Upload Files…"]);
    expect(menu.textContent).toContain("Kept in Dummy Esports");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Folder" }));
    await waitFor(() => expect(calls("work.files.make")).toHaveLength(1));
    expect(calls("work.files.make")[0]).toMatchObject({ workspaceId: "w1", kind: "folder", at: { at: "place", id: "folder" } });
    // The new thing is selected, its name a field with the part before its extension selected.
    const field = (await screen.findByRole("textbox", { name: "Rename Untitled folder" })) as HTMLInputElement;
    expect(field.value).toBe("Untitled folder");
    fireEvent.change(field, { target: { value: "Spring LAN" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(calls("work.files.rename")).toHaveLength(1));
    expect(calls("work.files.rename")[0]).toMatchObject({ name: "Spring LAN", ref: at("/w/Untitled folder") });
    await waitFor(() => expect(rows()).toContain("Spring LAN"));
    expect(picked()).toEqual(["Spring LAN"]);
  });

  it("offers only what a library takes, and no New in Trash", async () => {
    await mount();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "General" }));
    await waitFor(() => expect(rows()).toEqual(["Agenda.docx"]));
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(within(await screen.findByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Text file", "Folder"]);
  });
});

describe("the selection", () => {
  it("takes one on a press, more with the modifier and Shift, all with ⌘A, and shows one bar for two or more", async () => {
    await mount();
    fireEvent.click(row("Budget.xlsx"));
    expect(picked()).toEqual(["Budget.xlsx"]);
    expect(document.querySelector("[data-files-bulk]")).toBeNull();
    fireEvent.click(row("Plan.docx"), { shiftKey: true });
    expect(picked()).toEqual(["Budget.xlsx", "notes.txt", "Plan.docx"]);
    const bar = document.querySelector<HTMLElement>("[data-files-bulk]")!;
    expect(bar.textContent).toContain("3 selected");
    // The bar names its verbs as DESIGN.md does, and the list keeps its last row clear of the bar.
    expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual(["Ask", "Move", "Copy", "Delete", "Clear"]);
    expect(list().className).toContain("pb-14");
    // Ask starts a chat of the workspace about the files selected: a chip each, with its place and path in words.
    fireEvent.click(within(bar).getByRole("button", { name: "Ask" }));
    expect(world.started).toHaveLength(1);
    expect(world.started[0]!.at).toEqual({ cwd: "/w", projectId: null });
    expect(world.started[0]!.chips.every((chip) => chip.kind === "file" && chip.where?.place === "folder")).toBe(true);

    fireEvent.click(row("notes.txt"), { ctrlKey: true });
    expect(picked()).toEqual(["Budget.xlsx", "Plan.docx"]);
    fireEvent.keyDown(list(), { key: "a", ctrlKey: true });
    expect(picked()).toHaveLength(5);
    fireEvent.click(within(document.querySelector<HTMLElement>("[data-files-bulk]")!).getByRole("button", { name: "Clear" }));
    expect(picked()).toEqual([]);
    expect(list().className).not.toContain("pb-14");
    // Shift with the arrows takes the run too.
    fireEvent.click(row("Budget.xlsx"));
    fireEvent.keyDown(list(), { key: "ArrowDown", shiftKey: true });
    expect(picked()).toEqual(["Budget.xlsx", "notes.txt"]);
  });
});

describe("a row's menu", () => {
  it("is one menu of verbs for the row under the pointer, selected alone first; Delete goes to Trash with Undo", async () => {
    await mount();
    fireEvent.click(row("Budget.xlsx"));
    fireEvent.contextMenu(row("notes.txt"));
    const menu = await screen.findByRole("menu");
    expect(picked()).toEqual(["notes.txt"]);
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.replace("F2", ""))).toEqual(["Open", "Rename", "Move to…", "Copy to…", "Star", "Delete"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(calls("work.files.trash")).toHaveLength(1));
    expect(calls("work.files.trash")[0]).toMatchObject({ refs: [at("/w/notes.txt")] });
    await waitFor(() => expect(rows()).not.toContain("notes.txt"));
    const toast = world.toasts.at(-1)!;
    expect(toast).toMatchObject({ kind: "message", title: "Deleted notes.txt" });
    // Undo puts it back where it was.
    act(() => toast.undo!());
    await waitFor(() => expect(calls("work.files.restore")).toHaveLength(1));
    await waitFor(() => expect(rows()).toContain("notes.txt"));
  });

  it("draws a verb off with the place's own sentence where the place refuses it", async () => {
    await mount();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "General" }));
    await waitFor(() => expect(rows()).toEqual(["Agenda.docx"]));
    fireEvent.contextMenu(row("Agenda.docx"));
    const off = await menuItem("Delete");
    expect(off.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(off);
    expect(calls("work.files.trash")).toEqual([]);
  });

  it("asks once before a delete in a library others can open, naming the file and the team, then says it went with Undo", async () => {
    host.disk.set("/cloud/Esports/Testing.pptx", false);
    await mount();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Esports" }));
    await waitFor(() => expect(rows()).toEqual(["Testing.pptx"]));
    fireEvent.contextMenu(row("Testing.pptx"));
    fireEvent.click(await menuItem("Delete"));
    await waitFor(() => expect(calls("work.files.trash")).toHaveLength(1));
    expect(world.asked).toEqual([{ title: "Delete Testing.pptx for everyone?", action: "Delete" }]);
    expect(world.bodies).toEqual(["Everyone in Esports can open it."]);
    expect(calls("work.files.trash")[0]).toMatchObject({ refs: [at("/cloud/Esports/Testing.pptx")], asked: true });
    await waitFor(() => expect(world.toasts.at(-1)).toMatchObject({ kind: "message", title: "Deleted Testing.pptx", undo: expect.any(Function) }));
    world.toasts.at(-1)!.undo!();
    await waitFor(() => expect(calls("work.files.restore")).toHaveLength(1));
  });

  it("deletes nothing when he cancels the question", async () => {
    host.disk.set("/cloud/Esports/Testing.pptx", false);
    world.yes = false;
    await mount();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Esports" }));
    await waitFor(() => expect(rows()).toEqual(["Testing.pptx"]));
    fireEvent.contextMenu(row("Testing.pptx"));
    fireEvent.click(await menuItem("Delete"));
    await waitFor(() => expect(world.asked).toHaveLength(1));
    expect(calls("work.files.trash")).toEqual([]);
  });

  it("stars and unstars, and the Starred lens lists it", async () => {
    await mount();
    fireEvent.contextMenu(row("Budget.xlsx"));
    fireEvent.click(await menuItem("Star"));
    await waitFor(() => expect(calls("work.files.star")).toEqual([{ workspaceId: "w1", ref: at("/w/Budget.xlsx"), name: "Budget.xlsx", on: true }]));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Starred" }));
    await waitFor(() => expect(rows()).toEqual(["Budget.xlsx"]));
    fireEvent.contextMenu(row("Budget.xlsx"));
    expect(await menuItem("Remove Star")).toBeTruthy();
  });
});

describe("the keys for what is selected", () => {
  it("renames with F2 and says the host's own sentence when the name is taken; deletes with the Delete key", async () => {
    await mount();
    fireEvent.click(row("notes.txt"));
    fireEvent.keyDown(list(), { key: "F2" });
    const field = await screen.findByRole("textbox", { name: "Rename notes.txt" });
    fireEvent.change(field, { target: { value: "Plan.docx" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(world.toasts.at(-1)).toMatchObject({ kind: "error", title: "notes.txt was not renamed", description: 'A file named "Plan.docx" is already there.' }));
    expect(rows()).toContain("notes.txt");
    // Escape leaves the name as it was and asks nothing.
    fireEvent.keyDown(list(), { key: "F2" });
    fireEvent.keyDown(await screen.findByRole("textbox", { name: "Rename notes.txt" }), { key: "Escape" });
    expect(calls("work.files.rename")).toHaveLength(1);
    fireEvent.click(row("Budget.xlsx"));
    fireEvent.click(row("Plan.docx"), { ctrlKey: true });
    fireEvent.keyDown(list(), { key: "Backspace" });
    await waitFor(() => expect(calls("work.files.trash")).toHaveLength(1));
    expect((calls("work.files.trash")[0]!.refs as unknown[]).length).toBe(2);
    await waitFor(() => expect(world.toasts.at(-1)).toMatchObject({ title: "Deleted 2 things" }));
  });
});

describe("a name pressed again", () => {
  it("starts its rename on a slow second press on the selected name; a quick second press is a double click, which opens", async () => {
    await mount();
    const nameOf = (file: string): HTMLElement => row(file).querySelector<HTMLElement>("[data-files-name]")!;
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    fireEvent.click(nameOf("notes.txt"));
    clock.mockReturnValue(now + 120);
    fireEvent.click(nameOf("notes.txt"));
    expect(screen.queryByRole("textbox", { name: "Rename notes.txt" })).toBeNull();
    clock.mockReturnValue(now + 1200);
    fireEvent.click(nameOf("notes.txt"));
    expect(await screen.findByRole("textbox", { name: "Rename notes.txt" })).toBeTruthy();
    clock.mockRestore();
  });
});

describe("a file open in its tab", () => {
  it("has its row's verbs in its own menu, and its name is a press that renames it where it lies", async () => {
    await mount();
    fireEvent.doubleClick(row("Budget.xlsx"));
    await waitFor(() => expect(document.querySelector("[data-files-header]")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "More for Budget.xlsx" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.replace(/⌘W|Ctrl\+W/, ""))).toEqual(["Rename", "Move to…", "Copy to…", "Star", "Delete", "Download", "Full Window", "Close Tab"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    const field = await screen.findByRole("textbox", { name: "Rename Budget.xlsx" });
    fireEvent.change(field, { target: { value: "Budget 2027.xlsx" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(calls("work.files.rename")).toEqual([expect.objectContaining({ ref: at("/w/Budget.xlsx"), name: "Budget 2027.xlsx" })]));
    // The name itself is the same press.
    fireEvent.click(document.querySelector<HTMLElement>("[data-files-rename-name]")!);
    expect(await screen.findByRole("textbox", { name: /Rename / })).toBeTruthy();
  });

  it("fills the app's window on Full Window, and Escape returns", async () => {
    await mount();
    fireEvent.doubleClick(row("Budget.xlsx"));
    await waitFor(() => expect(document.querySelector("[data-files-header]")).not.toBeNull());
    const panel = document.querySelector<HTMLElement>("[data-files-file]")!;
    expect(panel.getAttribute("data-files-full")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More for Budget.xlsx" }));
    fireEvent.click(await menuItem("Full Window"));
    await waitFor(() => expect(panel.getAttribute("data-files-full")).toBe("true"));
    expect(panel.className).toContain("fixed inset-0");
    // The way back is on screen as well as on the key.
    expect(screen.getByRole("button", { name: "Leave Full Window" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(panel.getAttribute("data-files-full")).toBeNull());
  });

  it("deletes the file from its own menu, to Trash with Undo", async () => {
    await mount();
    fireEvent.doubleClick(row("notes.txt"));
    await waitFor(() => expect(document.querySelector("[data-files-header]")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "More for notes.txt" }));
    fireEvent.click(await menuItem("Delete"));
    await waitFor(() => expect(calls("work.files.trash")).toEqual([expect.objectContaining({ refs: [at("/w/notes.txt")] })]));
    await waitFor(() => expect(world.toasts.at(-1)).toMatchObject({ title: "Deleted notes.txt" }));
  });
});

describe("Move to…", () => {
  it("opens one dialog in the folder the thing is in, walks to a folder, and moves it there", async () => {
    await mount();
    fireEvent.contextMenu(row("Budget.xlsx"));
    fireEvent.click(await menuItem("Move to…"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Move Budget.xlsx");
    // In its own folder there is nowhere to move it to yet: the verb is off, and says why.
    await waitFor(() => expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["Archive", "Events"]));
    expect((within(dialog).getByRole("button", { name: "Move Here" }) as HTMLButtonElement).disabled).toBe(true);
    expect(dialog.textContent).toContain("It is in this folder already.");
    fireEvent.click(within(dialog).getByRole("option", { name: "Events" }));
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Move Here" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move Here" }));
    await waitFor(() => expect(calls("work.files.move")).toHaveLength(1));
    expect(calls("work.files.move")[0]).toMatchObject({ refs: [at("/w/Budget.xlsx")], to: at("/w/Events") });
    await waitFor(() => expect(rows()).not.toContain("Budget.xlsx"));
    expect(world.toasts.at(-1)).toMatchObject({ title: "Moved Budget.xlsx to Events" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // A move inside one place says so with Undo, which moves it back to the folder it came from.
    await act(async () => world.toasts.at(-1)!.undo!());
    await waitFor(() => expect(calls("work.files.move")).toHaveLength(2));
    expect(calls("work.files.move")[1]).toMatchObject({ refs: [at("/w/Events/Budget.xlsx")], to: { at: "place", id: "folder" } });
    await waitFor(() => expect(rows()).toContain("Budget.xlsx"));
    expect(world.toasts.at(-1)).toMatchObject({ title: "Moved Budget.xlsx to Dummy Esports" });
    // The move back is no move to undo again.
    expect(world.toasts.at(-1)!.undo).toBeUndefined();
  });

  it("asks before a copy into a place others can open, and says the grammar's refusal for a move out of one", async () => {
    await mount();
    fireEvent.contextMenu(row("notes.txt"));
    fireEvent.click(await menuItem("Copy to…"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Places" }));
    fireEvent.click(await within(dialog).findByRole("option", { name: "General" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Copy Here" }));
    await waitFor(() => expect(calls("work.files.copy")).toHaveLength(1));
    expect(world.asked).toEqual([{ title: "Copy to General?", action: "Copy" }]);
    expect(calls("work.files.copy")[0]).toMatchObject({ asked: true, to: { at: "file", path: "/cloud/General" } });
  });
});

describe("Trash", () => {
  it("lists what was deleted with where it was, puts a row back, and empties after one question", async () => {
    await mount();
    for (const name of ["notes.txt", "Plan.docx"]) {
      fireEvent.click(row(name));
      fireEvent.keyDown(list(), { key: "Delete" });
      await waitFor(() => expect(rows()).not.toContain(name));
    }
    fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Trash" }));
    await waitFor(() => expect(rows()).toEqual(["notes.txt", "Plan.docx"]));
    expect(screen.getByRole("columnheader", { name: "Was in" })).toBeTruthy();
    expect(row("notes.txt").textContent).toContain("Dummy Esports");
    // Trash makes nothing: no New here.
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
    fireEvent.contextMenu(row("notes.txt"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Put Back", "Delete for Good"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Put Back" }));
    await waitFor(() => expect(calls("work.files.restore")).toHaveLength(1));
    expect(calls("work.files.restore")[0]!.ids).toHaveLength(1);
    expect(host.disk.has("/w/notes.txt")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
    await waitFor(() => expect(calls("work.files.purge")).toHaveLength(1));
    expect(world.asked.at(-1)).toEqual({ title: "Empty Trash?", action: "Empty Trash" });
    expect(host.trashed).toEqual([]);
  });

  it("empties nothing when he says no", async () => {
    await mount();
    fireEvent.click(row("notes.txt"));
    fireEvent.keyDown(list(), { key: "Delete" });
    await waitFor(() => expect(rows()).not.toContain("notes.txt"));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Trash" }));
    await waitFor(() => expect(rows()).toEqual(["notes.txt"]));
    world.yes = false;
    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
    await waitFor(() => expect(world.asked).toHaveLength(1));
    expect(calls("work.files.purge")).toEqual([]);
  });
});

describe("upload and drag", () => {
  it("uploads files picked behind New into the folder shown, in chunks, and says an upload under way", async () => {
    await mount();
    const picker = document.querySelector<HTMLInputElement>("[data-files-picker]")!;
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(await menuItem("Upload Files…"));
    const file = new File(["hello"], "Poster v2.png", { type: "image/png" });
    Object.defineProperty(picker, "files", { value: [file], configurable: true });
    fireEvent.change(picker);
    await waitFor(() => expect(calls("work.files.upload")).toHaveLength(1));
    expect(calls("work.files.upload")[0]).toMatchObject({ name: "Poster v2.png", size: 5, at: { at: "place", id: "folder" } });
    await waitFor(() => expect(calls("attachment.commit")).toHaveLength(1));
    expect(calls("attachment.chunk")).toHaveLength(1);
    await waitFor(() => expect(rows()).toContain("Poster v2.png"));
  });

  it("moves rows dragged onto a folder row, the folder held in the fill and the pointer carrying the verb", async () => {
    await mount();
    const data = new Map<string, string>();
    const dataTransfer = { types: [] as string[], setData: (type: string, value: string) => (data.set(type, value), dataTransfer.types.push(type)), getData: (type: string) => data.get(type) ?? "", effectAllowed: "", dropEffect: "", files: [] };
    fireEvent.click(row("notes.txt"));
    fireEvent.click(row("Plan.docx"), { ctrlKey: true });
    fireEvent.dragStart(row("notes.txt"), { dataTransfer });
    fireEvent.dragOver(row("Events"), { dataTransfer, clientX: 40, clientY: 60 });
    expect(row("Events").getAttribute("data-drop-over")).toBe("true");
    expect(document.querySelector("[data-files-drag-label]")!.textContent).toBe("Move to Events");
    // Nothing has moved yet.
    expect(calls("work.files.move")).toEqual([]);
    fireEvent.drop(row("Events"), { dataTransfer });
    await waitFor(() => expect(calls("work.files.move")).toHaveLength(1));
    expect(calls("work.files.move")[0]).toMatchObject({ refs: [at("/w/notes.txt"), at("/w/Plan.docx")], to: at("/w/Events") });
    expect(document.querySelector("[data-files-drag-label]")).toBeNull();
    // A drop that moved says so with Undo, back to the folder the rows were dragged from.
    await waitFor(() => expect(world.toasts.at(-1)?.title).toBe("Moved 2 things to Events"));
    await act(async () => world.toasts.at(-1)!.undo!());
    await waitFor(() => expect(calls("work.files.move")).toHaveLength(2));
    expect(calls("work.files.move")[1]).toMatchObject({ refs: [at("/w/Events/notes.txt"), at("/w/Events/Plan.docx")], to: { at: "place", id: "folder" } });
    await waitFor(() => expect(rows()).toContain("notes.txt"));
    // With ⌥ held it is a copy.
    fireEvent.dragStart(row("Budget.xlsx"), { dataTransfer });
    const held = (event: Event): Event => (Object.defineProperty(event, "altKey", { value: true }), event);
    fireEvent(row("Archive"), held(createEvent.dragOver(row("Archive"), { dataTransfer })));
    expect(document.querySelector("[data-files-drag-label]")!.textContent).toBe("Copy to Archive");
    fireEvent(row("Archive"), held(createEvent.drop(row("Archive"), { dataTransfer })));
    await waitFor(() => expect(calls("work.files.copy")).toHaveLength(1));
    // A copy takes nothing away: there is nothing to undo.
    await waitFor(() => expect(world.toasts.at(-1)?.title).toBe("Copied Budget.xlsx to Archive"));
    expect(world.toasts.at(-1)!.undo).toBeUndefined();
  });

  it("takes files dropped from the desktop on the page into its folder", async () => {
    await mount();
    const file = new File(["x"], "Bracket.pdf", { type: "application/pdf" });
    const dataTransfer = { types: ["Files"], files: [file], dropEffect: "" };
    const body = document.querySelector<HTMLElement>("[data-files-body]")!;
    fireEvent.dragOver(body, { dataTransfer });
    expect(body.getAttribute("data-files-over")).toBe("true");
    fireEvent.drop(body, { dataTransfer });
    await waitFor(() => expect(calls("work.files.upload")).toHaveLength(1));
    expect(calls("work.files.upload")[0]).toMatchObject({ name: "Bracket.pdf" });
  });
});

describe("Go to", () => {
  const goTo = async (): Promise<HTMLInputElement> => {
    fireEvent.click(screen.getByRole("button", { name: "Go to" }));
    return (await screen.findByRole("combobox", { name: "Go to" })) as HTMLInputElement;
  };

  it("turns the trail into a field that lists names as he types, and Return takes the first", async () => {
    await mount();
    const field = await goTo();
    expect(screen.queryByRole("navigation", { name: "Folder" })).toBeNull();
    fireEvent.change(field, { target: { value: "post" } });
    const panel = await screen.findByRole("listbox", { name: "Go to" });
    await waitFor(() => expect(within(panel).getAllByRole("option").map((o) => o.textContent)).toEqual(["Poster.pngDummy Esports › Events"]));
    expect(calls("work.files.names").at(-1)).toEqual({ workspaceId: "w1", text: "post" });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(calls("work.files.open")).toEqual([expect.objectContaining({ ref: at("/w/Events/Poster.png") })]));
  });

  it("takes on Return a row of the words in the field, never one an older answer left: it waits for the names of his words", async () => {
    await mount();
    const field = await goTo();
    expect(field.placeholder).toBe("Go to");
    fireEvent.change(field, { target: { value: "post" } });
    await waitFor(() => expect(within(screen.getByRole("listbox", { name: "Go to" })).getAllByRole("option").map((o) => o.textContent)).toEqual(["Poster.pngDummy Esports › Events"]));
    // The names for "plan" are slow to come; Poster.png is still drawn when he presses Return.
    const answer = host.answer;
    let release: () => void = () => undefined;
    host.answer = (method, params) => (method === "work.files.names" && params.text === "plan" ? new Promise((done) => (release = () => done(answer(method, params)))) : answer(method, params));
    fireEvent.change(field, { target: { value: "plan" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => undefined);
    expect(calls("work.files.open")).toEqual([]);
    await act(async () => release());
    await waitFor(() => expect(calls("work.files.open")).toEqual([expect.objectContaining({ ref: at("/w/Plan.docx") })]));
  });

  it("walks to a folder, lists an open tab first, and puts the trail back on Escape", async () => {
    await mount();
    let field = await goTo();
    fireEvent.change(field, { target: { value: "dummy" } });
    const panel = await screen.findByRole("listbox", { name: "Go to" });
    await waitFor(() => expect(within(panel).getAllByRole("option")[0]!.textContent).toBe("Dummy EsportsOpen tab"));
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.getByRole("navigation", { name: "Folder" })).toBeTruthy();
    field = await goTo();
    fireEvent.change(field, { target: { value: "events" } });
    await waitFor(() => expect(within(screen.getByRole("listbox", { name: "Go to" })).getAllByRole("option").map((o) => o.textContent)).toEqual(["EventsDummy Esports"]));
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(rows()).toEqual(["Poster.png"]));
  });

  it("makes a new thing by its words: \"new folder called Receipts\"", async () => {
    await mount();
    const field = await goTo();
    fireEvent.change(field, { target: { value: "new folder called Receipts" } });
    await waitFor(() => expect(within(screen.getByRole("listbox", { name: "Go to" })).getAllByRole("option").map((o) => o.textContent)).toEqual(["New folder called Receipts"]));
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(calls("work.files.make")).toEqual([expect.objectContaining({ kind: "folder", name: "Receipts" })]));
    // No names are asked of the host for words that make a thing.
    expect(calls("work.files.names").some((c) => (c.text as string).startsWith("new folder"))).toBe(false);
  });

  it("opens from the Files place's own chord while focus is in it", async () => {
    await mount();
    act(() => void filesPort.run("go-to"));
    expect(await screen.findByRole("combobox", { name: "Go to" })).toBeTruthy();
  });
});

describe("Search", () => {
  it("filters the folder as he types, and Return searches every place as a page of results with where each lives", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const field = await screen.findByRole("searchbox", { name: "Search" });
    fireEvent.change(field, { target: { value: "plan" } });
    expect(rows()).toEqual(["Plan.docx"]);
    expect(calls("work.files.search")).toEqual([]);
    fireEvent.change(field, { target: { value: "a" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(calls("work.files.search")).toHaveLength(1));
    expect(calls("work.files.search")[0]).toMatchObject({ workspaceId: "w1", query: "a" });
    await waitFor(() => expect(rows()).toContain("Agenda.docx"));
    expect(screen.getByRole("columnheader", { name: "Where" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Search: a/ })).toBeTruthy();
    // A result opens in its own place: a folder in this tab, a file in a tab of its own.
    fireEvent.doubleClick(row("Plan.docx"));
    await waitFor(() => expect(calls("work.files.open")).toEqual([expect.objectContaining({ ref: at("/w/Plan.docx") })]));
  });

  it("narrows by kind in its own bar, saves under a name as a row under Starred, and removes it again", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const field = await screen.findByRole("searchbox", { name: "Search" });
    fireEvent.change(field, { target: { value: "a" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(document.querySelector("[data-files-filters]")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Kind" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Document" }));
    await waitFor(() => expect(calls("work.files.search").at(-1)).toMatchObject({ filter: { kinds: ["document"] } }));
    await waitFor(() => expect(rows().sort()).toEqual(["Agenda.docx", "Plan.docx"]));
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Save Search…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Documents with an a" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("work.files.saveSearch")).toEqual([expect.objectContaining({ name: "Documents with an a", query: "a", filter: { kinds: ["document"] } })]));
    const places = screen.getByRole("navigation", { name: "Places" });
    await waitFor(() => expect(within(places).getByRole("button", { name: "Documents with an a" })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove Saved Search" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove Saved Search" }));
    await waitFor(() => expect(within(places).queryByRole("button", { name: "Documents with an a" })).toBeNull());
  });

  it("starts a saved search opened in a tab with its own saved filter, not the filter the tab's last search had", async () => {
    await mount();
    const search = async (words: string): Promise<void> => {
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
      const field = await screen.findByRole("searchbox", { name: "Search" });
      expect((field as HTMLInputElement).placeholder).toBe("Search");
      fireEvent.change(field, { target: { value: words } });
      fireEvent.keyDown(field, { key: "Enter" });
      await waitFor(() => expect(document.querySelector("[data-files-filters]")).not.toBeNull());
    };
    const kind = async (name: string): Promise<void> => {
      fireEvent.click(screen.getByRole("button", { name: /^(Kind|Document|Sheet)$/ }));
      fireEvent.click(await screen.findByRole("menuitemcheckbox", { name }));
      fireEvent.keyDown(document.body, { key: "Escape" });
    };
    const places = screen.getByRole("navigation", { name: "Places" });
    await search("a");
    await kind("Document");
    await waitFor(() => expect(calls("work.files.search").at(-1)).toMatchObject({ filter: { kinds: ["document"] } }));
    fireEvent.click(screen.getByRole("button", { name: "Save Search…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Docs" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(within(places).getByRole("button", { name: "Docs" })).toBeTruthy());
    // Another search in the same tab starts with no filter of its own, and he narrows it to sheets.
    await search("budget");
    await waitFor(() => expect(calls("work.files.search").at(-1)).toMatchObject({ query: "budget" }));
    expect(calls("work.files.search").at(-1)!.filter ?? {}).toEqual({});
    await kind("Sheet");
    await waitFor(() => expect(calls("work.files.search").at(-1)).toMatchObject({ query: "budget", filter: { kinds: ["sheet"] } }));
    // The saved search, opened in that tab again, is read under its own filter.
    fireEvent.click(within(places).getByRole("button", { name: "Docs" }));
    await waitFor(() => expect(calls("work.files.search").at(-1)).toMatchObject({ query: "a", filter: { kinds: ["document"] } }));
  });

  it("opens with / in the page, and Escape gives the whole folder back", async () => {
    await mount();
    fireEvent.keyDown(list(), { key: "/" });
    const field = await screen.findByRole("searchbox", { name: "Search" });
    fireEvent.change(field, { target: { value: "budget" } });
    expect(rows()).toEqual(["Budget.xlsx"]);
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(rows()).toContain("notes.txt"));
    expect(screen.getByRole("navigation", { name: "Folder" })).toBeTruthy();
  });
});

describe("Home", () => {
  it("is the first page where the workspace's host has one: his stars and what he opened last, each a press that opens it", async () => {
    host = diskHost({ "/w/Events": true, "/w/Budget.xlsx": false, "/w/notes.txt": false }, { home: true });
    world.host = host;
    render(<View {...props} />);
    const home = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-files-home]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(screen.getByRole("tab", { name: /Home/ })).toBeTruthy();
    await waitFor(() => expect(within(home).getByRole("region", { name: "Recent" }).textContent).toContain("Budget.xlsx"));
    // A list with nothing in it is left out.
    expect(within(home).queryByRole("region", { name: "Waiting on you" })).toBeNull();
    expect(within(home).queryByRole("region", { name: "Starred" })).toBeNull();
    fireEvent.click(within(home).getByRole("button", { name: /Budget.xlsx/ }));
    await waitFor(() => expect(calls("work.files.open")).toEqual([expect.objectContaining({ ref: at("/w/Budget.xlsx") })]));
    // Home is a row of the sidebar, and a new tab opens on it.
    expect(within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", { name: "Home" })).toBeTruthy();
  });
});

describe("a tab's menu", () => {
  const tabNames = (): string[] => within(screen.getByRole("tablist", { name: "Open tabs" })).getAllByRole("tab").map((t) => t.textContent ?? "");
  const tabMenu = async (name: string | RegExp): Promise<HTMLElement> => {
    fireEvent.contextMenu(screen.getByRole("tab", { name }));
    return screen.findByRole("menu");
  };

  it("closes the others or the ones to the right, and opens the tab last closed again, a file in its tab too", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "New Tab" }));
    await waitFor(() => expect(tabNames()).toHaveLength(2));
    fireEvent.doubleClick(row("Budget.xlsx"));
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports", "Dummy Esports", "Budget.xlsx"]));
    let menu = await tabMenu(/Budget.xlsx/);
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.replace(/[⌘⇧]\w|Ctrl\+(Shift\+)?\w/g, ""))).toEqual(["Close Tab", "Close Other Tabs", "Close Tabs to the Right", "Reopen Closed Tab"]);
    // Nothing was closed yet, and nothing stands to its right.
    expect(within(menu).getByRole("menuitem", { name: /Reopen Closed Tab/ }).getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByRole("menuitem", { name: "Close Tabs to the Right" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(menu).getAllByRole("menuitem")[0]!);
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports", "Dummy Esports"]));
    // The file comes back in a tab of its own, from the Files place's own chord.
    act(() => void filesPort.run("reopen-tab"));
    await waitFor(() => expect(tabNames()).toEqual(["Dummy Esports", "Dummy Esports", "Budget.xlsx"]));
    expect(calls("work.files.open").at(-1)).toMatchObject({ ref: at("/w/Budget.xlsx"), name: "Budget.xlsx" });
    menu = await tabMenu(/Budget.xlsx/);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Close Other Tabs" }));
    await waitFor(() => expect(tabNames()).toEqual(["Budget.xlsx"]));
  });
});

describe("the sidebar's places and their folders", () => {
  const places = (): HTMLElement => screen.getByRole("navigation", { name: "Places" });
  const transfer = () => {
    const data = new Map<string, string>();
    const dataTransfer = { types: [] as string[], setData: (type: string, value: string) => (data.set(type, value), dataTransfer.types.push(type)), getData: (type: string) => data.get(type) ?? "", effectAllowed: "", dropEffect: "", files: [] };
    return dataTransfer;
  };

  it("opens a place to its folders under its row, a level in, and keeps what stands open for this window", async () => {
    await mount();
    expect(within(places()).queryByRole("button", { name: "Events" })).toBeNull();
    fireEvent.click(within(places()).getByRole("button", { name: "Show the folders of Dummy Esports" }));
    await waitFor(() => expect(within(places()).getByRole("button", { name: "Events" })).toBeTruthy());
    expect(within(places()).getByRole("button", { name: "Archive" })).toBeTruthy();
    // Only folders are rows here, each with its own chevron.
    expect(within(places()).queryByRole("button", { name: "Budget.xlsx" })).toBeNull();
    expect(within(places()).getByRole("button", { name: "Show the folders of Events" })).toBeTruthy();
    const kept = JSON.parse(localStorage.getItem("work.files.view.v1")!)[sessionStorage.getItem("work.files.window")!].open;
    expect(kept).toEqual({ w1: ["place:folder"] });
    fireEvent.click(within(places()).getByRole("button", { name: "Events" }));
    await waitFor(() => expect(rows()).toEqual(["Poster.png"]));
    fireEvent.click(within(places()).getByRole("button", { name: "Hide the folders of Dummy Esports" }));
    expect(within(places()).queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("takes rows dropped on a folder of the sidebar as a move, and on another place as a copy asked first", async () => {
    await mount();
    fireEvent.click(within(places()).getByRole("button", { name: "Show the folders of Dummy Esports" }));
    const archive = (await within(places()).findByRole("button", { name: "Archive" })).parentElement!;
    const dataTransfer = transfer();
    fireEvent.dragStart(row("notes.txt"), { dataTransfer });
    fireEvent.dragOver(archive, { dataTransfer });
    expect(document.querySelector("[data-files-drag-label]")!.textContent).toBe("Move to Archive");
    expect(within(archive).getByRole("button", { name: "Archive" }).getAttribute("data-drop-over")).toBe("true");
    fireEvent.drop(archive, { dataTransfer });
    await waitFor(() => expect(calls("work.files.move")).toEqual([expect.objectContaining({ refs: [at("/w/notes.txt")], to: at("/w/Archive") })]));
    // Into a place others can open it is a copy, and he is asked first.
    const general = within(places()).getByRole("button", { name: "General" }).parentElement!;
    fireEvent.dragStart(row("Budget.xlsx"), { dataTransfer });
    fireEvent.dragOver(general, { dataTransfer });
    expect(document.querySelector("[data-files-drag-label]")!.textContent).toBe("Copy to General");
    fireEvent.drop(general, { dataTransfer });
    await waitFor(() => expect(calls("work.files.copy")).toHaveLength(1));
    expect(world.asked.at(-1)).toEqual({ title: "Copy to General?", action: "Copy" });
    expect(document.querySelector("[data-files-drag-label]")).toBeNull();
  });

  it("takes rows dropped on a folder's tab, and refuses a drop of a folder into itself", async () => {
    await mount();
    fireEvent.click(within(places()).getByRole("button", { name: "Show the folders of Dummy Esports" }));
    fireEvent(await within(places()).findByRole("button", { name: "Events" }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    const tab = await screen.findByRole("tab", { name: /Events/ });
    fireEvent.click(screen.getAllByRole("tab")[0]!);
    await waitFor(() => expect(rows()).toContain("notes.txt"));
    const dataTransfer = transfer();
    fireEvent.dragStart(row("notes.txt"), { dataTransfer });
    fireEvent.dragOver(tab.parentElement!, { dataTransfer });
    expect(document.querySelector("[data-files-drag-label]")!.textContent).toBe("Move to Events");
    fireEvent.drop(tab.parentElement!, { dataTransfer });
    await waitFor(() => expect(calls("work.files.move")).toEqual([expect.objectContaining({ refs: [at("/w/notes.txt")], to: at("/w/Events") })]));
    // The folder itself is no place to put the folder.
    fireEvent.dragStart(row("Events"), { dataTransfer });
    fireEvent.dragOver(tab.parentElement!, { dataTransfer });
    expect(document.querySelector("[data-files-drag-label]")).toBeNull();
  });
});

describe("a delete's open copies", () => {
  it("finds the tabs on what goes, a copy by where its file lies, and whether one holds changes not sent", async () => {
    const { tabsOn, unsentIn } = await import("./acts");
    const deck: FileEntry = { key: "lib:esports:Testing.pptx", ref: { at: "file", host: "env_box", path: "C:\\Users\\tcuser\\Esports\\Testing.pptx" }, folder: null, name: "Testing.pptx", kind: "deck" };
    const folder: FileEntry = { key: "lib:esports:Old", ref: null, folder: { at: "file", host: "env_mac", path: "/cloud/Esports/Old" }, name: "Old", kind: "folder" };
    const tabs: FileTab[] = [
      { id: "t1", kind: "file", name: "Testing.pptx", key: "file:env_box:C:\\Users\\tcuser\\Esports\\Testing.pptx", copyOf: { host: "env_box", path: "C:\\Users\\tcuser\\Esports\\Testing.pptx", vm: true }, back: { is: "ok" } },
      { id: "t2", kind: "file", name: "Roster.xlsx", key: "file:env_mac:/cloud/Esports/Old/Roster.xlsx", copyOf: { host: "env_mac", path: "/cloud/Esports/Old/Roster.xlsx" }, back: { is: "away" } },
      { id: "t3", kind: "file", name: "Other.xlsx", key: "file:env_mac:/cloud/Esports/Other.xlsx", copyOf: { host: "env_mac", path: "/cloud/Esports/Other.xlsx" }, back: { is: "changed" } },
      { id: "t4", kind: "page", name: "Home", page: { name: "Home", at: { at: "place", id: "home" } } },
    ];
    expect(tabsOn(tabs, [deck]).map((t) => t.id)).toEqual(["t1"]);
    expect(unsentIn(tabsOn(tabs, [deck]))).toBe(false);
    expect(tabsOn(tabs, [folder]).map((t) => t.id)).toEqual(["t2"]);
    expect(unsentIn(tabsOn(tabs, [folder]))).toBe(true);
  });
});
