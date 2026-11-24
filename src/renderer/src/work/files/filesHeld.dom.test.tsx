// @vitest-environment jsdom
/**
 * Files shows what it holds (docs/agents/work-files.md "What the window keeps"): a workspace's reach painted first
 * from what was kept and asked again behind, its own host's places asked beside its settings rather than after,
 * Home kept and read again only on a push that names his marks.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesHome, FilesPlaces } from "@shared/contract-work-files";
import type { FileEntry, FilePlace, FolderRef } from "@shared/work/files";
import { refKey } from "@shared/work/files";
import type { WorkspaceMeta } from "../../lib/tcserver/types";

type Push = Record<string, unknown>;
const net = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  pushes: new Set<(push: Push) => void>(),
  /** an answer by method; a function may hold it */
  answer: (_method: string, _params: Record<string, unknown>): Promise<unknown> => Promise.resolve(null),
}));
const settings = vi.hoisted(() => ({ next: null as null | Promise<{ mayUseDesktop: string[]; windowsVm: boolean }> }));

vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({
    environmentId: id,
    connected: true,
    request: (method: string, params: Record<string, unknown> = {}) => {
      net.calls.push({ method, params });
      return net.answer(method, params);
    },
    onPush: (listener: (push: Push) => void) => (net.pushes.add(listener), () => net.pushes.delete(listener)),
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
  });
  return {
    ...(await original<typeof import("../../lib/connection")>()),
    registry: { linkOf, link: linkOf, has: (id: string) => id === "box", environment: (id: string) => ({ id, name: "The box", platform: "linux" }), environments: () => [], onLink: () => () => undefined },
  };
});
vi.mock("../shell/actions", () => ({
  workspaceSettings: () => {
    net.calls.push({ method: "work.workspace.get", params: {} });
    return settings.next ?? Promise.resolve({ mayUseDesktop: [], windowsVm: false });
  },
  localHostId: async () => null,
  windowDesktops: async () => [],
  linkIdOfHost: () => null,
}));

const { goTo, listingsKept, resetFilesStore, useHome, useListing, useReach, useTabs } = await import("./store");
const { LISTING_FRESH_MS, LISTING_KEEP_MOST, LISTING_KEEP_MS } = await import("./keep");

const workspace = { id: "w1", environmentId: "box", path: "/w", name: "Dummy Esports", kind: "work", sector: "purdue" } as unknown as WorkspaceMeta;
const at = (path: string) => ({ at: "file" as const, host: "box", path });
const FOLDER = { id: "folder", kind: "folder", name: "Dummy Esports", host: "The box", env: "box", shared: false, can: [], state: { state: "ok" }, root: at("/w") } as unknown as FilePlace;
const PLACES: FilesPlaces = { host: "box", places: [FOLDER], sources: [], rev: 1 } as unknown as FilesPlaces;
const HOME: FilesHome = { waiting: [], starred: [], recent: [] };
const asked = (method: string) => net.calls.filter((c) => c.method === method).length;
const push = (p: Push) => act(() => net.pushes.forEach((listener) => listener(p)));

beforeEach(() => {
  resetFilesStore();
  net.calls = [];
  net.pushes.clear();
  settings.next = null;
  net.answer = (method) => Promise.resolve(method === "work.files.places" ? PLACES : method === "work.office.filesCopyGet" ? { on: false } : method === "work.files.home" ? HOME : null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a workspace's reach", () => {
  it("asks its own host's places beside its settings, and paints once the settings say what is the workspace's", async () => {
    let answer!: (s: { mayUseDesktop: string[]; windowsVm: boolean }) => void;
    settings.next = new Promise((resolve) => (answer = resolve));
    const { result } = renderHook(() => useReach(workspace, 0));
    await waitFor(() => expect(asked("work.files.places")).toBe(1));
    // Asked while the settings are still out, and held: nothing is painted before they say whether the VM is the workspace's.
    expect(net.calls.map((c) => c.method).slice(0, 2).sort()).toEqual(["work.files.places", "work.workspace.get"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBeNull();
    await act(async () => answer({ mayUseDesktop: [], windowsVm: false }));
    await waitFor(() => expect(result.current?.sidebar.folder?.place.id).toBe("folder"));
    // The own host is not asked twice.
    expect(asked("work.files.places")).toBe(1);
  });

  it("paints a workspace seen before in its first render, with no answer yet, and asks again behind it", async () => {
    const first = renderHook(() => useReach(workspace, 0));
    await waitFor(() => expect(first.result.current?.sidebar.folder).toBeTruthy());
    first.unmount();
    net.calls = [];
    // Nothing answers now: what is drawn is what was kept.
    net.answer = () => new Promise(() => undefined);
    const renders: (unknown | null)[] = [];
    const again = renderHook(() => {
      const reach = useReach(workspace, 0);
      renders.push(reach);
      return reach;
    });
    expect(renders[0]).not.toBeNull();
    expect(again.result.current?.sidebar.folder?.place.id).toBe("folder");
    // Behind it, the host is asked again.
    await waitFor(() => expect(asked("work.files.places")).toBe(1));
  });
});

describe("Home", () => {
  it("is read once on open, never on tabs pushes, and once more for any number of marks pushes while a read is out", async () => {
    renderHook(() => useHome("box", "w1"));
    await waitFor(() => expect(asked("work.files.home")).toBe(1));
    push({ push: "work.files", workspaceId: "w1", tabs: 2 });
    push({ push: "work.files", workspaceId: "w1", tabs: 3 });
    push({ push: "work.files", workspaceId: "w1", tabs: 4 });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked("work.files.home")).toBe(1);
    // Marks: the first read starts, the next two make one more after it.
    let release!: () => void;
    net.answer = (method) => (method === "work.files.home" ? new Promise((resolve) => (release = () => resolve(HOME))) : Promise.resolve(null));
    push({ push: "work.files", workspaceId: "w1", marks: true });
    push({ push: "work.files", workspaceId: "w1", marks: true });
    push({ push: "work.files", workspaceId: "w1", marks: true });
    expect(asked("work.files.home")).toBe(2);
    await act(async () => release());
    await waitFor(() => expect(asked("work.files.home")).toBe(3));
    await act(async () => release());
    expect(asked("work.files.home")).toBe(3);
  });

  it("paints what was kept on a return, and reads once behind it", async () => {
    const first = renderHook(() => useHome("box", "w1"));
    await waitFor(() => expect(first.result.current.home).toEqual(HOME));
    first.unmount();
    net.answer = () => new Promise(() => undefined);
    const again = renderHook(() => useHome("box", "w1"));
    expect(again.result.current.home).toEqual(HOME);
    expect(asked("work.files.home")).toBe(2);
  });
});

describe("the folders the window keeps", () => {
  const COPY = { place: FOLDER, link: "box", host: "The box", wire: "files" as const };
  const from = { workspaceId: "w1", copy: COPY };
  const row = (name: string, changed = 1): FileEntry => ({ key: `file:box:/w/A/${name}`, ref: at(`/w/A/${name}`), folder: null, name, kind: "document", changed });
  let rows: FileEntry[];
  beforeEach(() => {
    rows = [row("Plan.docx"), row("Notes.docx")];
    const base = net.answer;
    net.answer = (method, params) => (method === "work.files.list" ? Promise.resolve({ entries: rows, trail: [] }) : base(method, params));
  });
  const lists = (path?: string) => net.calls.filter((c) => c.method === "work.files.list" && (!path || (c.params.at as FolderRef & { path: string }).path === path)).length;
  const show = async (path: string) => {
    const view = renderHook(() => useListing(from, at(path)));
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    return view;
  };

  it(`keeps ${LISTING_KEEP_MOST} listings at most for 100 folders visited, and no empty listener set`, async () => {
    for (let i = 0; i < 100; i++) (await show(`/w/F${i}`)).unmount();
    expect(listingsKept()).toEqual({ listings: LISTING_KEEP_MOST, sets: 0, empty: 0 });
  });

  it(`drops a listing no one has shown for ${LISTING_KEEP_MS / 60_000} minutes`, async () => {
    (await show("/w/A")).unmount();
    const left = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(left + LISTING_KEEP_MS + 1);
    (await show("/w/B")).unmount();
    expect(listingsKept().listings).toBe(1);
  });

  it("draws a folder shown again within its life with no call, and one a push named meanwhile with one", async () => {
    (await show("/w/A")).unmount();
    expect(lists("/w/A")).toBe(1);
    // Back: drawn from what was kept, at once.
    const back = renderHook(() => useListing(from, at("/w/A")));
    expect(back.result.current.entries.map((e) => e.name)).toEqual(["Plan.docx", "Notes.docx"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(lists("/w/A")).toBe(1);
    back.unmount();
    // A change notice while no one shows it: shown again, it is asked once.
    push({ push: "work.files", workspaceId: "w1", at: refKey(at("/w/A")) });
    (await show("/w/A")).unmount();
    expect(lists("/w/A")).toBe(2);
    // Past the fresh time the host is asked again.
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real + LISTING_FRESH_MS + 1);
    (await show("/w/A")).unmount();
    expect(lists("/w/A")).toBe(3);
  });

  it("redraws once for a push that lists the folder again, never putting it back to loading", async () => {
    let renders = 0;
    const loadings: boolean[] = [];
    const view = renderHook(() => {
      renders++;
      const listing = useListing(from, at("/w/A"));
      loadings.push(listing.loading);
      return listing;
    });
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    const before = renders;
    const kept = view.result.current.entries;
    rows = [row("Plan.docx", 2), row("Notes.docx")];
    push({ push: "work.files", workspaceId: "w1", at: refKey(at("/w/A")) });
    await waitFor(() => expect(view.result.current.entries[0]!.changed).toBe(2));
    expect(renders - before).toBe(1);
    expect(loadings.slice(before)).toEqual([false]);
    // The row that did not change is the same object, so its row does not draw again.
    expect(view.result.current.entries[1]).toBe(kept[1]);
    expect(view.result.current.entries[0]).not.toBe(kept[0]);
  });

  it("drops what it kept of a place its host no longer lists", async () => {
    const LIB = { ...FOLDER, id: "lib", kind: "teams", name: "General", root: at("/cloud/General") } as unknown as FilePlace;
    const libFrom = { workspaceId: "w1", copy: { place: LIB, link: "box", host: "The box", wire: "files" as const } };
    const base = net.answer;
    let places: FilePlace[] = [FOLDER, LIB];
    net.answer = (method, params) => (method === "work.files.places" ? Promise.resolve({ ...PLACES, places }) : base(method, params));
    const reach = renderHook(({ n }) => useReach(workspace, n), { initialProps: { n: 0 } });
    await waitFor(() => expect(reach.result.current?.sidebar).toBeTruthy());
    const lib = renderHook(() => useListing(libFrom, at("/cloud/General")));
    await waitFor(() => expect(lib.result.current.loaded).toBe(true));
    lib.unmount();
    expect(listingsKept().listings).toBe(1);
    // The library is no longer synced there: its places answer without it, and its rows go with it.
    places = [FOLDER];
    reach.rerender({ n: 1 });
    await waitFor(() => expect(listingsKept().listings).toBe(0));
    const again = renderHook(() => useListing(libFrom, at("/cloud/General")));
    expect(again.result.current.entries).toEqual([]);
  });
});

describe("Back's own tab change", () => {
  const first = { at: { at: "place" as const, id: "folder" }, name: "Dummy Esports" };
  const tab = (rev: number, path: string) => ({ tabs: [{ id: "t1", kind: "page", name: "A", page: { at: at(path), name: "A" } }], rev });
  it("asks for the tabs no more for its own push, and once for a newer one that came while it was out", async () => {
    let answer!: (v: unknown) => void;
    net.answer = (method) =>
      method === "work.files.tabs" ? Promise.resolve(tab(1, "/w/A")) : method === "work.files.tabSet" ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(null);
    const view = renderHook(() => useTabs("box", "w1", true, first));
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    expect(asked("work.files.tabs")).toBe(1);
    // Back: the tab's page is set on the host; the host's push for it lands before its answer.
    const went = goTo("box", "w1", "t1", { at: at("/w/B"), name: "B" });
    push({ push: "work.files", workspaceId: "w1", tabs: 2 });
    await act(async () => {
      answer(tab(2, "/w/B"));
      await went;
    });
    expect(asked("work.files.tabs")).toBe(1);
    // A push past the answer, while another is out: asked once, after it.
    const again = goTo("box", "w1", "t1", { at: at("/w/C"), name: "C" });
    push({ push: "work.files", workspaceId: "w1", tabs: 4 });
    push({ push: "work.files", workspaceId: "w1", tabs: 5 });
    await act(async () => {
      answer(tab(3, "/w/C"));
      await again;
    });
    await waitFor(() => expect(asked("work.files.tabs")).toBe(2));
  });
});
