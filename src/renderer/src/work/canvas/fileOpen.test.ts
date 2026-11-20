import { beforeEach, describe, expect, it, vi } from "vitest";

/** The box runs the thread; the Mac ("mac") is where a dropped file's path lives. */
const { host } = vi.hoisted(() => {
  const host = {
    calls: [] as { env: string; method: string; params: Record<string, unknown> }[],
    files: new Map<string, Uint8Array>(),
    landed: new Map<string, Uint8Array>(),
    parts: new Map<string, { name: string; into?: string; parts: Uint8Array[] }>(),
    /** Called before each chunk is answered: a test cancels from here. */
    onChunk: (_index: number) => {},
  };
  return { host };
});

const sha = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function answer(env: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  host.calls.push({ env, method, params });
  if (env === "mac") {
    const bytes = host.files.get(params.path as string)!;
    if (method === "attachment.digest") return { size: bytes.length, sha256: await sha(bytes) };
    const offset = params.offset as number;
    return { dataBase64: btoa(String.fromCharCode(...bytes.subarray(offset, offset + (params.length as number)))), size: bytes.length };
  }
  switch (method) {
    case "attachment.settings":
      return { maxBytes: 1024, chunkBytes: 4 };
    case "attachment.begin": {
      const id = `u${host.parts.size + 1}`;
      host.parts.set(id, { name: params.name as string, into: params.into as string | undefined, parts: [] });
      return { uploadId: id, chunkBytes: 4 };
    }
    case "attachment.chunk": {
      host.onChunk(params.index as number);
      host.parts.get(params.uploadId as string)!.parts.push(Uint8Array.from(atob(params.dataBase64 as string), (c) => c.charCodeAt(0)));
      return { received: 0 };
    }
    case "attachment.commit": {
      const up = host.parts.get(params.uploadId as string)!;
      const path = `/srv/work/Purdue/${up.name}`;
      host.landed.set(path, new Uint8Array(up.parts.flatMap((p) => [...p])));
      return { path, name: up.name, kind: "file", size: 0 };
    }
    case "attachment.abort":
      host.parts.delete(params.uploadId as string);
      return null;
  }
  throw new Error(`unexpected ${method}`);
}

vi.mock("../../lib/connection", () => ({
  registry: {
    linkOf: (env: string) => ({ environmentId: env, request: (method: string, params: Record<string, unknown>) => answer(env, method, params) }),
    primary: () => ({ environmentId: "mac" }),
  },
}));

const opened: { env: string; sessionId: string; what: Record<string, unknown> }[] = [];
const selected: string[] = [];
vi.mock("./store", () => ({
  openItem: async (env: string, sessionId: string, what: Record<string, unknown>) => {
    opened.push({ env, sessionId, what });
    return { id: `item${opened.length}`, sessionId, ...what };
  },
  selectItem: (_sessionId: string, itemId: string) => selected.push(itemId),
}));

import { forgetAttachmentSettings } from "../../lib/attachmentUpload";
import { inPlace, inside, openFiles, sortFiles, type OutsideFile } from "./fileOpen";

const onMac = (path: string, text: string): OutsideFile => {
  host.files.set(path, new TextEncoder().encode(text));
  return { name: path.slice(path.lastIndexOf("/") + 1), path, origin: "mac" };
};

beforeEach(() => {
  host.calls = [];
  host.files.clear();
  host.landed.clear();
  host.parts.clear();
  host.onChunk = () => {};
  opened.length = 0;
  selected.length = 0;
  forgetAttachmentSettings();
});

describe("sortFiles", () => {
  it("asks the registry which kind shows each file, and keeps the rest apart", () => {
    const { shows, unknown } = sortFiles([{ name: "Budget.xlsx" }, { name: "site.zip", type: "application/zip" }, { name: "Brief.pdf" }]);
    expect(shows.map((s) => [s.file.name, s.kind])).toEqual([
      ["Budget.xlsx", "sheet"],
      ["Brief.pdf", "pdf"],
    ]);
    expect(unknown.map((f) => f.name)).toEqual(["site.zip"]);
  });
});

describe("in place", () => {
  it("is a file already inside the workspace's folder on the thread's own host", () => {
    expect(inside("/srv/work/Purdue/Plans/a.pdf", "/srv/work/Purdue")).toBe(true);
    expect(inside("/srv/work/Purdue2/a.pdf", "/srv/work/Purdue")).toBe(false);
    expect(inside("C:\\Users\\me\\Work\\a.pdf", "c:/users/me/work/")).toBe(true);
    const file: OutsideFile = { name: "a.pdf", path: "/srv/work/Purdue/a.pdf", origin: "box" };
    expect(inPlace(file, "box", "/srv/work/Purdue")).toBe("/srv/work/Purdue/a.pdf");
    expect(inPlace(file, "mac", "/srv/work/Purdue")).toBeNull();
    expect(inPlace(file, "box", null)).toBeNull();
  });
});

describe("openFiles", () => {
  it("uploads a file into the workspace's folder under its name and opens it as a file item of its kind", async () => {
    const file = onMac("/Users/me/Desktop/Q3 Budget.xlsx", "cells and more");
    const progress: number[] = [];
    await openFiles({ env: "box", sessionId: "s1", files: [{ file, kind: "sheet" }], folder: "/srv/work/Purdue", onProgress: (_f, p) => progress.push(p.sent) });
    const begin = host.calls.find((c) => c.method === "attachment.begin")!;
    expect(begin.params).toMatchObject({ sessionId: "s1", name: "Q3 Budget.xlsx", into: "workspace" });
    expect(new TextDecoder().decode(host.landed.get("/srv/work/Purdue/Q3 Budget.xlsx"))).toBe("cells and more");
    expect(opened).toEqual([
      { env: "box", sessionId: "s1", what: { kind: "sheet", source: { at: "file", host: "box", path: "/srv/work/Purdue/Q3 Budget.xlsx" }, title: "Q3 Budget.xlsx" } },
    ]);
    expect(progress.at(-1)).toBe(14);
  });

  it("opens a file already in the folder with no copy", async () => {
    const file: OutsideFile = { name: "Plan.pdf", path: "/srv/work/Purdue/Plan.pdf", origin: "box" };
    await openFiles({ env: "box", sessionId: "s1", files: [{ file, kind: "pdf" }], folder: "/srv/work/Purdue" });
    expect(host.calls).toEqual([]);
    expect(opened[0]!.what.source).toEqual({ at: "file", host: "box", path: "/srv/work/Purdue/Plan.pdf" });
  });

  it("opens several in order and shows the first", async () => {
    const files = [onMac("/Users/me/a.pdf", "a"), onMac("/Users/me/b.pdf", "b"), onMac("/Users/me/c.png", "c")];
    await openFiles({ env: "box", sessionId: "s1", files: files.map((file) => ({ file, kind: "pdf" as const })), folder: "/srv/work/Purdue" });
    expect(opened.map((o) => o.what.title)).toEqual(["a.pdf", "b.pdf", "c.png"]);
    expect(selected).toEqual(["item1"]);
  });

  it("a cancel stops before the next chunk, tells the host to drop the partial and opens nothing", async () => {
    const file = onMac("/Users/me/cut.mov", "0123456789abcdef");
    const controller = new AbortController();
    host.onChunk = (index) => {
      if (index === 1) controller.abort();
    };
    await expect(openFiles({ env: "box", sessionId: "s1", files: [{ file, kind: "media" }], folder: "/srv/work/Purdue", signal: controller.signal })).rejects.toThrow();
    expect(host.calls.filter((c) => c.env === "box").map((c) => c.method)).toEqual(["attachment.settings", "attachment.begin", "attachment.chunk", "attachment.chunk", "attachment.abort"]);
    expect(host.landed.size).toBe(0);
    expect(opened).toEqual([]);
  });

  it("refuses a file over the host's limit before sending a byte", async () => {
    const file = onMac("/Users/me/huge.mp4", "x".repeat(2000));
    await expect(openFiles({ env: "box", sessionId: "s1", files: [{ file, kind: "media" }], folder: null })).rejects.toThrow("huge.mp4 is 2 KB, over this host's 1 KB limit");
    expect(host.calls.some((c) => c.method === "attachment.begin")).toBe(false);
  });
});
