import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the flow told the person, and what it asked of the rest of the window. */
const seen = vi.hoisted(() => ({
  toasts: [] as { line: string; action?: { label: string; onClick: () => void } }[],
  errors: [] as string[],
  started: 0,
  opened: [] as unknown[],
  openingStates: [] as (string | null)[],
  failOpen: null as Error | null,
  landed: [] as { owner: string; folder: string | null; name: string }[],
  inFiles: [] as unknown[],
}));

vi.mock("../../components/ui/toaster", () => {
  const toast = Object.assign((line: string, opts?: { action?: { label: string; onClick: () => void } }) => void seen.toasts.push({ line, action: opts?.action }), {
    error: (line: string) => void seen.errors.push(line),
    loading: () => "t1",
    dismiss: () => undefined,
  });
  return { loadToast: async () => toast };
});
vi.mock("../../lib/attachments", () => ({
  attachmentsFromFiles: async (files: File[]) => files.map((f) => ({ id: f.name, name: f.name, kind: "file", size: f.size })),
  attachmentsFromPaths: async () => [],
}));
vi.mock("../../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "mac" }), onLink: () => () => undefined } }));
vi.mock("../../lib/fs", () => ({ pickFiles: async () => null }));
vi.mock("../../lib/tcserver/commands", () => ({ ensureCreated: async () => ({ id: "s1", environmentId: "box", workspaceId: "w1" }) }));
vi.mock("../../lib/tcserver/store", () => ({ sessionStore: { get: () => undefined, metaOf: () => ({ id: "s1", environmentId: "box", workspaceId: "w1" }) } }));
vi.mock("../../lib/tcserver/workspaces", () => ({ workspaceStore: { getSnapshot: () => ({ workspaces: [{ id: "w1", environmentId: "box", path: "/srv/work/Purdue" }] }) } }));
vi.mock("../../lib/workSwitch", () => ({
  openWorkView: () => undefined,
  workViewNow: () => ({ workspaceId: "w1", view: "files" }),
  workStartPort: { get: () => () => (seen.started += 1, `draft${seen.started}`) },
}));
vi.mock("../files/openFrom", () => ({ openInFiles: async (_workspace: unknown, what: unknown) => void seen.inFiles.push(what) }));
vi.mock("./fileDrop", () => ({ setOpening: (_id: string, _token: object, next: { name: string } | null) => void seen.openingStates.push(next?.name ?? null) }));
vi.mock("./fileOpen", async (original) => ({
  ...(await original<typeof import("./fileOpen")>()),
  openFiles: async (opts: { files: unknown[] }) => {
    if (seen.failOpen) throw seen.failOpen;
    seen.opened.push(...opts.files);
  },
  landFile: async (to: { sessionId: string; folder: string | null }, file: { name: string }) => {
    seen.landed.push({ owner: to.sessionId, folder: to.folder, name: file.name });
    return `${to.folder}/${file.name}`;
  },
}));

import { takeComposerDraft } from "../../lib/composerDrafts";
import { noViewerLine, openOutside } from "./openOutside";

const file = (name: string): { name: string; file: File } => ({ name, file: new File(["x"], name) });

beforeEach(() => {
  seen.toasts = [];
  seen.errors = [];
  seen.started = 0;
  seen.opened = [];
  seen.openingStates = [];
  seen.failOpen = null;
  seen.landed = [];
  seen.inFiles = [];
});

describe("a file no kind shows", () => {
  it("is said in one line, with Add to the thread as a file putting it in the thread's composer", async () => {
    await openOutside({ at: "thread", sessionId: "s1" }, [file("site.zip"), file("Brief.pdf")]);
    expect(seen.toasts.map((t) => [t.line, t.action?.label])).toEqual([["No viewer for site.zip", "Add to the thread as a file"]]);
    expect(seen.opened).toHaveLength(1);
    seen.toasts[0]!.action!.onClick();
    await vi.waitFor(() => expect(takeComposerDraft("s1")?.attachments.map((a) => a.name)).toEqual(["site.zip"]));
  });

  it("from a view opens in a Files tab too: every file opens there, and nothing says there is no viewer", async () => {
    await openOutside({ at: "files" }, [file("a.zip")]);
    expect(seen.toasts).toEqual([]);
    expect(seen.inFiles).toEqual([{ ref: { at: "file", host: "box", path: "/srv/work/Purdue/a.zip" }, name: "a.zip" }]);
  });

  it("names one file, or how many", () => {
    expect(noViewerLine([{ name: "x.zip" }])).toBe("No viewer for x.zip");
    expect(noViewerLine([{ name: "x.zip" }, { name: "y.zip" }])).toBe("No viewer for 2 of these files");
  });
});

describe("opening", () => {
  it("says what is opening in the thread's pane until it lands, and a failure once", async () => {
    await openOutside({ at: "draft", sessionId: "s1" }, [file("Brief.pdf")]);
    expect(seen.openingStates).toEqual(["Brief.pdf", null]);
    seen.failOpen = new Error("not connected");
    await openOutside({ at: "thread", sessionId: "s1" }, [file("Brief.pdf")]);
    expect(seen.errors).toEqual(["Couldn't open Brief.pdf"]);
    expect(seen.openingStates.at(-1)).toBeNull();
  });
});

describe("Open File… or a drop from a Work view", () => {
  it("keeps a PDF and a text file in the workspace's folder and opens each in a Files tab, starting no thread", async () => {
    await openOutside({ at: "files" }, [file("Picked practice plan.pdf"), file("Dropped practice notes.txt")]);
    expect(seen.landed).toEqual([
      { owner: "filespane_w1", folder: "/srv/work/Purdue", name: "Picked practice plan.pdf" },
      { owner: "filespane_w1", folder: "/srv/work/Purdue", name: "Dropped practice notes.txt" },
    ]);
    expect(seen.inFiles).toEqual([
      { ref: { at: "file", host: "box", path: "/srv/work/Purdue/Picked practice plan.pdf" }, name: "Picked practice plan.pdf" },
      { ref: { at: "file", host: "box", path: "/srv/work/Purdue/Dropped practice notes.txt" }, name: "Dropped practice notes.txt" },
    ]);
    expect(seen.started).toBe(0);
    expect(seen.opened).toEqual([]);
  });
});
