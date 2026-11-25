// @vitest-environment jsdom
/**
 * A reopened link (Sol round 1, S4): the folder on screen is read once, with wake off, so what changed while the link
 * was cut shows; a folder kept but not shown is read when shown again (Back), never answered from before the cut.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePlace, FolderRef } from "@shared/work/files";

const requests: { method: string; params: Record<string, unknown> }[] = [];
const opens = vi.hoisted(() => new Set<() => void>());
vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({
    environmentId: id,
    connected: true,
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      return { thumbs: [], entries: [] };
    },
    onPush: () => () => undefined,
    onOpen: (fn: () => void) => (opens.add(fn), () => void opens.delete(fn)),
    onClose: () => () => undefined,
  });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: () => true, environment: (id: string) => ({ id, name: "The box", platform: "linux" }), environments: () => [], onLink: () => () => undefined } };
});

const { resetFilesStore, useListing } = await import("./store");

const TOP = "C:\\Users\\tcuser\\Dummy U\\Team - Documents\\General";
const at = (path: string): FolderRef => ({ at: "file", host: "env_box", path });
const VM_PLACE = { id: "box~vm/General", kind: "teams", name: "General", host: "Windows VM", env: "env_box", shared: true, vm: true, can: [], state: { state: "awake", at: 1 }, root: at(TOP) } as unknown as FilePlace;
const VM = { place: VM_PLACE, link: "box", host: "Windows VM", wire: "files" as const };
const lists = () => requests.filter((r) => r.method === "work.files.list");
const reopen = () =>
  act(async () => {
    for (const fn of [...opens]) fn();
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  localStorage.clear();
  resetFilesStore();
  requests.length = 0;
});
afterEach(() => cleanup());

describe("a reopened link", () => {
  it("reads the folder on screen once, with wake off", async () => {
    const { result } = renderHook(() => useListing({ workspaceId: "w1", copy: VM }, at(TOP)));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    requests.length = 0;
    await reopen();
    expect(lists()).toHaveLength(1);
    expect(lists()[0]!.params).toMatchObject({ at: at(TOP), wake: false });
  });

  it("reads a folder kept but not shown when it is shown again", async () => {
    const shown = renderHook(() => useListing({ workspaceId: "w1", copy: VM }, at(TOP)));
    await waitFor(() => expect(shown.result.current.loaded).toBe(true));
    shown.unmount();
    await reopen();
    requests.length = 0;
    // Back, a moment later: inside the time a folder is drawn without asking, but the cut may have hidden a change.
    const back = renderHook(() => useListing({ workspaceId: "w1", copy: VM }, at(TOP)));
    await waitFor(() => expect(back.result.current.loaded).toBe(true));
    expect(lists()).toHaveLength(1);
    expect(lists()[0]!.params.wake).toBeFalsy();
  });
});
