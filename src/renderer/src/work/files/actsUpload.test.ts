/**
 * An upload from his window whose commit answer was lost (acts.ts `uploadTo`): the host is asked before the upload is
 * called failed, so a file that landed counts once and is never sent again; an upload the host forgot before its
 * commit (it started again) is sent once more under a new op; a real refusal still fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  /** the files the stand-in host made, by upload id */
  made: [] as string[],
  /** ops whose file landed, as the op's row says it */
  landedOps: new Set<string>(),
  /** upload ids the host knows; a restart forgets them all */
  known: new Set<string>(),
  /** commits the host answered, kept as attachmentUploads keeps them */
  committed: new Set<string>(),
  dropCommitAnswer: 0,
  restartAfterCommit: false,
  restartAtChunk: false,
  shaWrong: false,
  errors: [] as string[],
}));

const forgotten = (): Error => Object.assign(new Error("unknown upload (expired, aborted or never begun)"), { code: "unknown-upload" });

vi.mock("../../lib/connection", () => ({
  registry: {
    has: () => true,
    linkOf: () => ({
      request: async (method: string, params: Record<string, unknown>) => {
        world.calls.push({ method, params });
        switch (method) {
          case "work.files.upload": {
            const op = params.op as string;
            if (world.landedOps.has(op)) return { uploadId: `u:${op}`, landed: true };
            world.known.add(`u:${op}`);
            return { uploadId: `u:${op}` };
          }
          case "attachment.chunk":
            if (world.restartAtChunk) {
              world.restartAtChunk = false;
              world.known.clear();
            }
            if (!world.known.has(params.uploadId as string)) throw forgotten();
            return { received: 5 };
          case "attachment.commit": {
            const id = params.uploadId as string;
            if (world.committed.has(id)) return { path: `/w/${id}` };
            if (!world.known.has(id)) throw forgotten();
            world.known.delete(id);
            if (world.shaWrong) throw new Error("sha256 does not match what begin declared");
            world.made.push(id);
            world.committed.add(id);
            world.landedOps.add(id.slice(2));
            if (world.restartAfterCommit) world.committed.clear();
            if (world.dropCommitAnswer > 0) {
              world.dropCommitAnswer -= 1;
              throw new Error("The request timed out.");
            }
            return { path: `/w/${id}` };
          }
          case "attachment.abort":
            return null;
        }
        throw new Error(`unknown method: ${method}`);
      },
    }),
  },
}));
vi.mock("../../lib/attachmentUpload", () => ({ blobSource: async () => ({ size: 5, sha256: "a".repeat(64), read: async () => "aGVsbG8=" }) }));
vi.mock("./store", () => ({ tabsNow: () => [], closeTab: vi.fn() }));
vi.mock("../../chrome/ConfirmDialog", () => ({ confirmAction: async () => true }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ message: vi.fn(), error: (title: string) => void world.errors.push(title) }) }));

const { uploadTo } = await import("./acts");

const of = { workspaceId: "w1", home: "box" };
const folder = { link: "box", place: { id: "folder", kind: "folder", name: "Events", host: "box", env: "box", shared: false, can: ["upload"], state: { state: "ok" }, root: { at: "file", host: "box", path: "/w" } } } as never;
const at = { at: "place", id: "folder" } as never;
const file = (): File => new File(["hello"], "TempCode proof upload.txt");
const calls = (method: string) => world.calls.filter((c) => c.method === method);

beforeEach(() => {
  world.calls = [];
  world.made = [];
  world.landedOps = new Set();
  world.known = new Set();
  world.committed = new Set();
  world.dropCommitAnswer = 0;
  world.restartAfterCommit = false;
  world.restartAtChunk = false;
  world.shaWrong = false;
  world.errors = [];
});

describe("an upload whose commit answer was lost", () => {
  it("asks the commit again and counts the file once: one file, no second upload, nothing aborted", async () => {
    world.dropCommitAnswer = 1;
    expect(await uploadTo(of, folder, at, [file()])).toBe(1);
    expect(world.made).toHaveLength(1);
    expect(calls("work.files.upload")).toHaveLength(1);
    expect(calls("attachment.abort")).toEqual([]);
    expect(world.errors).toEqual([]);
  });

  it("across a restart of the host after the file landed, asks the op, which says it landed", async () => {
    world.dropCommitAnswer = 1;
    world.restartAfterCommit = true;
    expect(await uploadTo(of, folder, at, [file()])).toBe(1);
    expect(world.made).toHaveLength(1);
    const begins = calls("work.files.upload");
    expect(begins).toHaveLength(2);
    expect(begins[1]!.params.op).toBe(begins[0]!.params.op);
    expect(world.errors).toEqual([]);
  });

  it("sends once more under a new op an upload the host forgot before its commit", async () => {
    world.restartAtChunk = true;
    expect(await uploadTo(of, folder, at, [file()])).toBe(1);
    expect(world.made).toHaveLength(1);
    const begins = calls("work.files.upload");
    expect(begins).toHaveLength(2);
    expect(begins[1]!.params.op).not.toBe(begins[0]!.params.op);
  });

  it("still fails a commit the host refused, once its op says nothing landed", async () => {
    world.shaWrong = true;
    expect(await uploadTo(of, folder, at, [file()])).toBe(0);
    expect(world.made).toEqual([]);
    expect(world.errors).toEqual(["Nothing was uploaded"]);
  });
});
