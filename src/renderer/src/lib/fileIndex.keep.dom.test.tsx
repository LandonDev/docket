// @vitest-environment jsdom
/**
 * The project's file list kept by host and cwd (fileIndex.ts): a picker's
 * open within FRESH_MS of the last answer asks nothing; one after it asks
 * again behind the paint, so a file made outside any thread shows; the
 * window's git-changed event, a changed link key and the LRU's bound drop
 * or mark what was kept. Counts of `fs.projectFiles`, never a clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectFile } from "./fs";

const h = vi.hoisted(() => ({
  list: vi.fn<(host: string, cwd: string) => Promise<ProjectFile[]>>(),
  env: { keyId: "k1", credentialRef: null as string | null } as { keyId?: string; credentialRef: string | null } | undefined,
  subs: new Set<() => void>(),
}));

vi.mock("./fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fs")>()),
  listProjectFiles: (host: string, cwd: string) => h.list(host, cwd),
}));
vi.mock("./tcserver/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tcserver/projects")>()),
  hostOfCwd: (cwd: string) => (cwd.startsWith("/box") ? "env_box" : "local"),
}));
vi.mock("./connection", async (importOriginal) => {
  const real = await importOriginal<typeof import("./connection")>();
  return {
    ...real,
    registry: { ...real.registry, environment: () => h.env, subscribe: (fn: () => void) => (h.subs.add(fn), () => void h.subs.delete(fn)) },
  };
});

import { FRESH_MS, KEPT_CHECKOUTS, invalidateProjectFiles, loadProjectFiles, peekProjectFiles, resetProjectFiles, subscribeProjectFilesDropped } from "./fileIndex";
import { notifyGitChanged } from "./gitChanged";

const cwd = "/Users/me/app";
const file = (relative: string): ProjectFile => ({ name: relative.split("/").pop()!, path: `${cwd}/${relative}`, relative });
const A = [file("src/a.ts")];
const B = [...A, file("made-in-his-editor.ts")];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  resetProjectFiles();
  h.list.mockReset();
  h.list.mockResolvedValue(A);
  h.env = { keyId: "k1", credentialRef: null };
});
afterEach(() => vi.useRealTimers());

describe("the kept file list", () => {
  it("answers two opens of @ inside 30 s with one fs.projectFiles", async () => {
    expect(await loadProjectFiles(cwd, true)).toBe(A);
    vi.setSystemTime(1_000_000 + FRESH_MS - 1);
    expect(await loadProjectFiles(cwd, true)).toBe(A);
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("joins opens while an ask is out: one ask an open burst", async () => {
    const both = await Promise.all([loadProjectFiles(cwd, true), loadProjectFiles(cwd, true), loadProjectFiles(cwd, true)]);
    expect(both).toEqual([A, A, A]);
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("has a file made outside any thread on the first open after 30 s, painting the kept list first", async () => {
    await loadProjectFiles(cwd, true);
    h.list.mockResolvedValue(B);
    vi.setSystemTime(1_000_000 + FRESH_MS);
    // The paint: what was kept, at once.
    expect(peekProjectFiles(cwd)).toBe(A);
    expect(await loadProjectFiles(cwd, true)).toBe(B);
    expect(peekProjectFiles(cwd)).toBe(B);
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("asks again inside 30 s once the window's git-changed event names the checkout, and not for another's", async () => {
    await loadProjectFiles(cwd, true);
    notifyGitChanged("/Users/me/other");
    await loadProjectFiles(cwd, true);
    expect(h.list).toHaveBeenCalledTimes(1);
    notifyGitChanged(cwd);
    await loadProjectFiles(cwd, true);
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("a read without revalidate never asks while a list is kept, whatever its age", async () => {
    await loadProjectFiles(cwd);
    vi.setSystemTime(1_000_000 + FRESH_MS * 10);
    await loadProjectFiles(cwd);
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("keeps a list per host and cwd, at most four checkouts, the oldest dropped", async () => {
    const cwds = ["/Users/me/a", "/Users/me/b", "/box/a", "/box/b", "/Users/me/c"];
    for (const c of cwds) await loadProjectFiles(c, true);
    expect(KEPT_CHECKOUTS).toBe(4);
    expect(peekProjectFiles(cwds[0])).toBeNull();
    for (const c of cwds.slice(1)) expect(peekProjectFiles(c)).toBe(A);
    expect(h.list.mock.calls.map(([host]) => host)).toEqual(["local", "local", "env_box", "env_box", "local"]);
  });

  it("drops a kept list when the link's key changes", async () => {
    await loadProjectFiles(cwd, true);
    h.env = { keyId: "k2", credentialRef: null };
    expect(peekProjectFiles(cwd)).toBeNull();
    await loadProjectFiles(cwd, true);
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("does not keep an answer asked under a key that changed while it was out", async () => {
    let answer!: (files: ProjectFile[]) => void;
    h.list.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const asked = loadProjectFiles(cwd, true);
    h.env = { keyId: "k2", credentialRef: null };
    answer(A);
    await asked;
    expect(peekProjectFiles(cwd)).toBeNull();
  });

  it("an ask out when the key changes hands its names to no caller, is not joined, and an open list hears it is dropped", async () => {
    let answer!: (files: ProjectFile[]) => void;
    h.list.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const old = loadProjectFiles(cwd, true);
    const dropped = vi.fn();
    const off = subscribeProjectFilesDropped(cwd, dropped);
    h.env = { keyId: "k2", credentialRef: null };
    for (const fn of h.subs) fn();
    expect(dropped).toHaveBeenCalledTimes(1);
    // the open picker asks again under the new key: a new ask, not the old one joined
    h.list.mockResolvedValueOnce(B);
    const fresh = loadProjectFiles(cwd, true);
    expect(h.list).toHaveBeenCalledTimes(2);
    answer(A);
    expect(await old).toEqual([]);
    expect(await fresh).toBe(B);
    for (const fn of h.subs) fn();
    expect(dropped).toHaveBeenCalledTimes(1);
    off();
  });

  it("invalidate drops the list, so the next open asks", async () => {
    await loadProjectFiles(cwd, true);
    invalidateProjectFiles(cwd);
    expect(peekProjectFiles(cwd)).toBeNull();
    await loadProjectFiles(cwd, true);
    expect(h.list).toHaveBeenCalledTimes(2);
  });
});
