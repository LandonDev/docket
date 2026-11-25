// @vitest-environment jsdom
/**
 * Download from a file's tab. A tab that holds a copy of a file on another computer or in the VM downloads that
 * copy, asked of the workspace's host by its item: the original's bytes go to no window but its own computer's, so
 * More → Download once asked for them and was refused while Facts' Download worked. A press that can only be
 * refused is not offered.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const asked = vi.hoisted(() => [] as { env: string; method: string; params: Record<string, unknown> }[]);
/** What the host answers each read, in turn (the last again), and what main's disk saw. */
const world = vi.hoisted(() => ({
  reads: [] as ({ data: string; version: string; end: boolean } | Error)[],
  disk: [] as string[],
  ended: null as null | ((path: string | null) => void),
  toasts: [] as { title: string; press?: string; run?: () => void }[],
  revealed: [] as string[],
}));
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: (env: string) => ({
      environmentId: env,
      request: async (method: string, params: Record<string, unknown>) => {
        asked.push({ env, method, params });
        const next = world.reads.length > 1 ? world.reads.shift()! : (world.reads[0] ?? { data: btoa("bytes"), version: "v1", end: true });
        if (next instanceof Error) throw next;
        return next;
      },
    }),
  },
}));
vi.mock("../../lib/native", async (original) => ({
  ...(await original<object>()),
  isWebMode: () => false,
  downloadParts: () => ({
    begin: async (name: string) => (world.disk.push(`begin ${name}`), "d1"),
    part: async (_id: string, bytes: Uint8Array) => void world.disk.push(`part ${new TextDecoder().decode(bytes)}`),
    // Kept, main answers once the file is on the disk: here when the test says so.
    end: (_id: string, keep: boolean) => (world.disk.push(keep ? "kept" : "taken away"), keep ? new Promise<string | null>((done) => (world.ended = done)) : Promise.resolve(null)),
  }),
}));
vi.mock("../../lib/fs", () => ({ revealPath: async (path: string) => void world.revealed.push(path) }));
vi.mock("../../components/ui/toaster", () => {
  const put = (title: string, o: { action?: { label: string; onClick(): void } } = {}) => void world.toasts.push({ title, ...(o.action ? { press: o.action.label, run: o.action.onClick } : {}) });
  return { loadToast: async () => ({ message: put, error: put, success: put }) };
});

const { download, downloadAll, downloadOf } = await import("./acts");

afterEach(() => {
  asked.length = 0;
  Object.assign(world, { reads: [], disk: [], ended: null, toasts: [], revealed: [] });
});

describe("which Download a file's tab offers", () => {
  const ways = { copy: "copy", lies: "lies" } as const;
  it("a copy downloads the copy the tab holds, wherever the original lies", () => {
    expect(downloadOf({ copy: true, shared: true, there: true }, ways)).toEqual({ download: "copy" });
    expect(downloadOf({ copy: true, shared: false, there: false }, ways)).toEqual({ download: "copy" });
  });
  it("a file of the workspace's own host is read where it lies", () => {
    expect(downloadOf({ copy: false, shared: false, there: false }, ways)).toEqual({ download: "lies" });
    expect(downloadOf({ copy: false, shared: true, there: false }, ways)).toEqual({ download: "lies" });
  });
  it("a shared library's file with no copy here is not offered from another computer's window", () => {
    expect(downloadOf({ copy: false, shared: true, there: true }, ways)).toEqual({});
  });
});

describe("download", () => {
  it("asks the host for the tab's copy by its item, with the copy's own source", async () => {
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    const copy = { at: "file", host: "env_box", path: "/w/.files/Bylaws.pdf" } as const;
    const done = download({ workspaceId: "w1" } as never, { link: "env_box", place: {} } as never, { key: "k", ref: copy, folder: null, name: "Bylaws.pdf", kind: "pdf" } as never, "item-1");
    await vi.waitFor(() => expect(world.ended).not.toBeNull());
    world.ended!("/Downloads/Bylaws.pdf");
    await done;
    expect(asked).toEqual([{ env: "env_box", method: "work.files.read", params: { workspaceId: "w1", ref: copy, itemId: "item-1", offset: 0, length: 4 * 1024 * 1024 } }]);
  });
});

describe("a download's truth", () => {
  const entry = (name: string) => ({ key: name, ref: { at: "file", host: "env_box", path: `/w/${name}` }, folder: null, name, kind: "sheet", size: 9 }) as never;
  const of = { workspaceId: "w1" } as never;
  const copy = { link: "env_box", place: {} } as never;

  it("writes each part as it comes and says Downloaded, with Show, only once main has the file on the disk", async () => {
    world.reads = [{ data: btoa("one "), version: "v1", end: false }, { data: btoa("two"), version: "v1", end: true }];
    const done = download(of, copy, entry("Budget.xlsx"));
    await vi.waitFor(() => expect(world.ended).not.toBeNull());
    expect(world.disk).toEqual(["begin Budget.xlsx", "part one ", "part two", "kept"]);
    await new Promise((settle) => setTimeout(settle, 10));
    expect(world.toasts).toEqual([]);
    world.ended!("/Downloads/Budget (1).xlsx");
    expect(await done).toBe(true);
    await vi.waitFor(() => expect(world.toasts).toMatchObject([{ title: "Downloaded Budget.xlsx", press: "Show" }]));
    world.toasts[0]!.run!();
    expect(world.revealed).toEqual(["/Downloads/Budget (1).xlsx"]);
  });

  it("takes away a file whose next part did not come, and says it did not download", async () => {
    world.reads = [{ data: btoa("one "), version: "v1", end: false }, new Error("The box did not answer.")];
    expect(await download(of, copy, entry("Budget.xlsx"))).toBe(false);
    expect(world.disk).toEqual(["begin Budget.xlsx", "part one ", "taken away"]);
    await vi.waitFor(() => expect(world.toasts.map((t) => t.title)).toEqual(["Budget.xlsx did not download"]));
  });

  it("begins nothing in Downloads when the first read is refused, and counts only what main kept", async () => {
    world.reads = [new Error("gone"), { data: btoa("x"), version: "v1", end: true }];
    const done = downloadAll(of, copy, [entry("A.xlsx"), entry("B.xlsx")]);
    await vi.waitFor(() => expect(world.ended).not.toBeNull());
    world.ended!("/Downloads/B.xlsx");
    expect(await done).toBe(1);
    expect(world.disk).toEqual(["begin B.xlsx", "part x", "kept"]);
    await vi.waitFor(() => expect(world.toasts).toMatchObject([{ title: "Downloaded 1 file", press: "Show" }]));
  });
});
