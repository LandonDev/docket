import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the flow told the person, and what it asked of the rest of the window. */
const seen = vi.hoisted(() => ({
  toasts: [] as { line: string; action?: { label: string; onClick: () => void } }[],
  errors: [] as string[],
  started: 0,
  opened: [] as unknown[],
  openingStates: [] as (string | null)[],
  failOpen: null as Error | null,
}));

vi.mock("../../components/ui/toaster", () => {
  const toast = Object.assign((line: string, opts?: { action?: { label: string; onClick: () => void } }) => void seen.toasts.push({ line, action: opts?.action }), {
    error: (line: string) => void seen.errors.push(line),
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
vi.mock("../../lib/tcserver/workspaces", () => ({ workspaceStore: { getSnapshot: () => ({ workspaces: [{ id: "w1", path: "/srv/work/Purdue" }] }) } }));
vi.mock("../../lib/workSwitch", () => ({
  openWorkView: () => undefined,
  workStartPort: { get: () => () => (seen.started += 1, `draft${seen.started}`) },
}));
vi.mock("./fileDrop", () => ({ setOpening: (_id: string, _token: object, next: { name: string } | null) => void seen.openingStates.push(next?.name ?? null) }));
vi.mock("./fileOpen", async (original) => ({
  ...(await original<typeof import("./fileOpen")>()),
  openFiles: async (opts: { files: unknown[] }) => {
    if (seen.failOpen) throw seen.failOpen;
    seen.opened.push(...opts.files);
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
});

describe("a file no kind shows", () => {
  it("is said in one line, with Add to the thread as a file putting it in the thread's composer", async () => {
    await openOutside({ at: "thread", sessionId: "s1" }, [file("site.zip"), file("Brief.pdf")]);
    expect(seen.toasts.map((t) => [t.line, t.action?.label])).toEqual([["No viewer for site.zip", "Add to the thread as a file"]]);
    expect(seen.opened).toHaveLength(1);
    seen.toasts[0]!.action!.onClick();
    await vi.waitFor(() => expect(takeComposerDraft("s1")?.attachments.map((a) => a.name)).toEqual(["site.zip"]));
  });

  it("from a view starts no thread until he asks for the files as attachments", async () => {
    await openOutside({ at: "new" }, [file("a.zip"), file("b.bin")]);
    expect(seen.toasts[0]!.line).toBe("No viewer for 2 of these files");
    expect(seen.started).toBe(0);
    seen.toasts[0]!.action!.onClick();
    expect(seen.started).toBe(1);
    await vi.waitFor(() => expect(takeComposerDraft("draft1")?.attachments.map((a) => a.name)).toEqual(["a.zip", "b.bin"]));
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
