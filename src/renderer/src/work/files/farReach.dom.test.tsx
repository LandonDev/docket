// @vitest-environment jsdom
/**
 * A far desktop's folder left open (journeys J24): reached through the workspace's host, which pushes nothing of its
 * folders, it is asked again when shown again and when that host says the desktop's link came or went; while it is
 * away its rows stay, said with when they were read, and the computer away is named.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerPush } from "@shared/contract";
import type { FilePlace, FolderRef } from "@shared/work/files";
import type { WorkspaceMeta } from "@shared/domain";

const box = vi.hoisted(() => ({
  pushes: new Set<(push: unknown) => void>(),
  away: false,
  asked: 0,
  place: null as unknown,
}));
vi.mock("../shell/actions", () => ({
  workspaceSettings: async () => ({ mayUseDesktop: ["env_pc"], windowsVm: false }),
  localHostId: async () => null,
  windowDesktops: async () => [],
  linkIdOfHost: () => null,
}));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "env_box",
    connected: true,
    request: async (method: string, params: { method?: string } = {}) => {
      if (method === "work.files.places") return { host: "env_box", places: [], sources: [], rev: 1 };
      if (method === "work.office.filesCopyGet") return { on: false };
      if (method !== "work.files.across") return {};
      if (box.away) {
        if (params.method === "work.files.list") box.asked++;
        throw new Error("Purdue laptop is not reachable now.");
      }
      if (params.method === "work.files.places") return { host: "env_pc", name: "Purdue laptop", places: [box.place], sources: [], rev: 1 };
      box.asked++;
      return { entries: [{ key: "pc:D:\\Docs\\Plan.txt", name: "Plan.txt", folder: false }], trail: [] };
    },
    onPush: (fn: (push: unknown) => void) => (box.pushes.add(fn), () => void box.pushes.delete(fn)),
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
  };
  const linkOf = (id: string) => {
    if (id === "env_box") return link;
    throw new Error(`unknown environment: ${id}`);
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: (id: string) => id === "env_box", environment: (id: string) => (id === "env_box" ? { id, name: "The box", platform: "linux" } : undefined), environments: () => [], onLink: () => () => undefined } };
});

const { keepFarName, reachThrough } = await import("./farLink");
const { resetFilesStore, useListing, useReach } = await import("./store");
const { copyHostOf } = await import("./FilesView");

const at = (path: string): FolderRef => ({ at: "file", host: "env_pc", path });
const PLACE = { id: "pc/Docs", kind: "folder", name: "Docs", host: "Purdue laptop", env: "env_pc", shared: false, can: [], state: { state: "ok" }, root: at("D:\\Docs") } as unknown as FilePlace;
const PC = { place: PLACE, link: "env_pc", host: "Purdue laptop", wire: "files" as const };
box.place = PLACE;
const say = (push: Partial<ServerPush> & Record<string, unknown>): void => act(() => box.pushes.forEach((fn) => fn(push)));

beforeEach(() => {
  box.away = false;
  box.asked = 0;
  reachThrough("env_pc", "env_box", "w1");
});
afterEach(() => {
  cleanup();
  resetFilesStore();
});

describe("a far desktop's folder left open", () => {
  it("asks again when the host in between says the desktop's link went, and keeps its rows said with when they were read", async () => {
    const shown = renderHook(() => useListing({ workspaceId: "w1", copy: PC }, at("D:\\Docs")));
    await waitFor(() => expect(shown.result.current.loaded).toBe(true));
    const readAt = Date.now();
    expect(box.asked).toBe(1);
    box.away = true;
    // Another workspace's word, and a push of no reach, ask nothing.
    say({ push: "work.files", workspaceId: "w2", places: true });
    say({ push: "work.files", workspaceId: "w1", marks: true });
    expect(box.asked).toBe(1);
    say({ push: "work.files", workspaceId: "w1", places: true });
    await waitFor(() => expect(shown.result.current.away).toBe(true));
    expect(box.asked).toBe(2);
    expect(shown.result.current.entries.map((e) => e.name)).toEqual(["Plan.txt"]);
    expect(shown.result.current.asOf).toBeGreaterThanOrEqual(readAt - 1000);
    expect(shown.result.current.asOf).toBeLessThanOrEqual(readAt);
    // Back: listed again without his press, and the age goes with the failure.
    box.away = false;
    say({ push: "work.files", workspaceId: "w1", places: true });
    await waitFor(() => expect(shown.result.current.away).toBe(false));
    expect(shown.result.current.asOf).toBeUndefined();
  });

  it("is asked again when shown again within moments: nothing of it is pushed", async () => {
    const first = renderHook(() => useListing({ workspaceId: "w1", copy: PC }, at("D:\\Docs")));
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    first.unmount();
    box.away = true;
    const again = renderHook(() => useListing({ workspaceId: "w1", copy: PC }, at("D:\\Docs")));
    await waitFor(() => expect(again.result.current.away).toBe(true));
    expect(box.asked).toBe(2);
    expect(again.result.current.entries).toHaveLength(1);
  });
});

describe("a far desktop's places, when it stops answering", () => {
  it("stay in the sidebar, each out of reach, so a folder of it left open is still its folder", async () => {
    const workspace = { id: "w1", environmentId: "env_box", path: "/w", name: "Dummy Esports", kind: "work", sector: "purdue" } as unknown as WorkspaceMeta;
    const shown = renderHook(() => useReach(workspace, 0));
    const deskPlace = () => shown.result.current?.reads.find((r) => r.link === "env_pc")?.answer?.places.find((p) => p.id === "pc/Docs");
    await waitFor(() => expect(deskPlace()?.state.state).toBe("ok"));
    box.away = true;
    say({ push: "work.files", workspaceId: "w1", places: true });
    await waitFor(() => expect(shown.result.current?.reads.find((r) => r.link === "env_pc")?.failed?.unreachable).toBe(true));
    expect(deskPlace()?.state.state).toBe("unreachable");
    expect(shown.result.current?.note).toMatchObject({ title: "Purdue laptop did not answer", away: true });
    // Back: its places as it says them now.
    box.away = false;
    say({ push: "work.files", workspaceId: "w1", places: true });
    await waitFor(() => expect(deskPlace()?.state.state).toBe("ok"));
  });
});

describe("a copy's computer, away", () => {
  const tab = { copyOf: { host: "env_pc", path: "D:\\Docs\\Plan.txt" } };
  it("is named by its last read though that read failed, else by the name the host in between gave it", () => {
    expect(copyHostOf(tab, { reads: [{ link: "env_pc", name: "Purdue laptop", desktop: true, wire: "files", failed: { words: "Purdue laptop is not reachable now.", unreachable: true } }] })).toBe("Purdue laptop");
    keepFarName("env_pc", "Purdue laptop");
    expect(copyHostOf(tab, { reads: [] })).toBe("Purdue laptop");
    expect(copyHostOf({ copyOf: { host: "env_gone", path: "x" } }, { reads: [] })).toBe("another computer");
  });
});
