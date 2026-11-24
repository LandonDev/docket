// @vitest-environment jsdom
/**
 * Files shows what it holds (docs/agents/work-files.md "What the window keeps"): a workspace's reach painted first
 * from what was kept and asked again behind, its own host's places asked beside its settings rather than after,
 * Home kept and read again only on a push that names his marks.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesHome, FilesPlaces } from "@shared/contract-work-files";
import type { FilePlace } from "@shared/work/files";
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

const { resetFilesStore, useHome, useReach } = await import("./store");

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
afterEach(() => cleanup());

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
