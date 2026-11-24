// @vitest-environment jsdom
/**
 * Download from a file's tab. A tab that holds a copy of a file on another computer or in the VM downloads that
 * copy, asked of the workspace's host by its item: the original's bytes go to no window but its own computer's, so
 * More → Download once asked for them and was refused while Facts' Download worked. A press that can only be
 * refused is not offered.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const asked = vi.hoisted(() => [] as { env: string; method: string; params: Record<string, unknown> }[]);
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: (env: string) => ({
      environmentId: env,
      request: async (method: string, params: Record<string, unknown>) => {
        asked.push({ env, method, params });
        return { data: btoa("bytes"), version: "v1", end: true };
      },
    }),
  },
}));

const { download, downloadOf } = await import("./acts");

afterEach(() => void (asked.length = 0));

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
    await download({ workspaceId: "w1" } as never, { link: "env_box", place: {} } as never, { key: "k", ref: copy, folder: null, name: "Bylaws.pdf", kind: "pdf" } as never, "item-1");
    expect(asked).toEqual([{ env: "env_box", method: "work.files.read", params: { workspaceId: "w1", ref: copy, itemId: "item-1", offset: 0, length: 4 * 1024 * 1024 } }]);
  });
});
