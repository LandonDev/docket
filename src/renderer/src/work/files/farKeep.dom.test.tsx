// @vitest-environment jsdom
/**
 * A desktop reached through the workspace's host (Sol round 2, S16): however often its folders are visited, the keep
 * hears that host's reopen once; the listeners a visit adds go with it.
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FilePlace, FolderRef } from "@shared/work/files";

const opens = vi.hoisted(() => new Set<() => void>());
vi.mock("../../lib/connection", async (original) => {
  const box = {
    environmentId: "env_box",
    connected: true,
    request: async () => ({ thumbs: [], entries: [] }),
    onPush: () => () => undefined,
    onOpen: (fn: () => void) => (opens.add(fn), () => void opens.delete(fn)),
    onClose: () => () => undefined,
  };
  const linkOf = (id: string) => {
    if (id === "env_box") return box;
    throw new Error(`unknown environment: ${id}`);
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: (id: string) => id === "env_box", environment: (id: string) => ({ id, name: "The box", platform: "linux" }), environments: () => [], onLink: () => () => undefined } };
});

const { reachThrough } = await import("./farLink");
const { resetFilesStore, useListing } = await import("./store");

const at = (path: string): FolderRef => ({ at: "file", host: "env_pc", path });
const PLACE = { id: "pc/Docs", kind: "folder", name: "Docs", host: "Purdue laptop", env: "env_pc", shared: false, can: [], state: { state: "ok" }, root: at("D:\\Docs") } as unknown as FilePlace;
const PC = { place: PLACE, link: "env_pc", host: "Purdue laptop", wire: "files" as const };

afterEach(() => {
  cleanup();
  resetFilesStore();
});

describe("a far desktop's folders, visited again and again", () => {
  it("leave one lasting reopen listener on the host in between", async () => {
    for (let i = 0; i < 3; i++) {
      reachThrough("env_pc", "env_box", "w1");
      const visit = renderHook(() => useListing({ workspaceId: "w1", copy: PC }, at("D:\\Docs")));
      await waitFor(() => expect(visit.result.current.loaded).toBe(true));
      visit.unmount();
    }
    expect(opens.size).toBe(1);
  });
});
