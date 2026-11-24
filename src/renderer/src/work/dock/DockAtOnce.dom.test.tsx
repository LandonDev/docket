// @vitest-environment jsdom
/**
 * Ask gives him a box he can type in at once (Dock.tsx, dockThread.ts `dockThreadNow`): the draft's composer is in the
 * dock's first commit whether or not the subject's `find` ever answers; `find` is asked once a subject a run, however
 * often its tab comes back; and the thread it finds takes the draft's place only while the draft is empty.
 */
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../../lib/tcserver/types";
import type { DockSubject } from "./subject";

vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({ environmentId: id, connected: true, request: async () => ({}), onPush: () => () => undefined });
  return {
    ...(await original<typeof import("../../lib/connection")>()),
    registry: { linkOf, link: linkOf, has: () => true, environments: () => [], onLink: () => () => undefined, statusOf: () => ({ lastHello: null }) },
  };
});
vi.mock("../../surfaces/threadChat", () => ({
  useSessionActions: () => ({}),
  useThreadChat: () => ({ renderChat: () => null, renderSlots: () => null, composerOf: () => <div data-composer-input contentEditable />, newPassArmed: false, armNewPass: () => undefined }),
}));
vi.mock("../../surfaces/threads/ThreadView", () => ({ ThreadView: () => <div data-composer-input contentEditable /> }));
vi.mock("../../chrome/ConnectionLine", () => ({ useEnvironmentBlock: () => ({ name: "the box", degraded: null }) }));
vi.mock("../../surfaces/SessionPane", () => ({ LoadLine: () => null }));

const { Dock } = await import("./Dock");
const { resetDocks } = await import("./dockThread");
const { sessionStore } = await import("../../lib/tcserver/store");
const { newSession } = await import("../../lib/session");
const { workDockPort } = await import("../../lib/workSwitch");
const { projectDrafts } = await import("../../lib/projectDrafts");
const { resetContextChips } = await import("../canvas/chips");

const workspace = { id: "w1", environmentId: "box", path: "/w" };
const subject = (find: () => Promise<string | null>): DockSubject => ({ key: "w1/tab1", title: "Budget.xlsx", chips: [], chipIn: "composer", find });
const never = (): Promise<string | null> => new Promise(() => undefined);
/** The thread from before, as this window knows it (one object: a store hook reads it by identity). */
const OLD = { id: "t-old", environmentId: "box" } as SessionMeta;

/** What the dock held when its first commit landed: a child's first layout effect runs in that commit. */
let firstCommit: { composer: boolean } | null = null;
function Probe() {
  useLayoutEffect(() => {
    firstCommit ??= { composer: !!document.querySelector("[data-composer-input]") };
  }, []);
  return null;
}

const draw = (s: DockSubject) =>
  render(
    <Dock name="files" workspace={workspace} subject={s} chip={null} focus={false} head={() => null} onChipTaken={() => undefined} onClose={() => undefined}>
      <Probe />
    </Dock>,
  );
const shownId = (): string | null => document.querySelector("[data-files-dock]")?.getAttribute("data-files-dock") ?? null;

beforeEach(() => {
  localStorage.clear();
  projectDrafts.reload();
  sessionStore.reset();
  resetContextChips();
  resetDocks();
  firstCommit = null;
  workDockPort.set({
    draft: (_ws, id) => ({ ...newSession("box", "claude", "/w", undefined, undefined, { projectId: null, workspaceId: "w1" }), ...(id ? { id } : {}) }),
    openFile: () => undefined,
    openDiff: () => undefined,
  });
});
afterEach(() => {
  cleanup();
  workDockPort.set(null);
  vi.restoreAllMocks();
});

describe("a box he can type in at once", () => {
  it("draws the draft's composer in the first commit while find never answers", () => {
    draw(subject(never));
    expect(firstCommit).toEqual({ composer: true });
    expect(document.querySelector("[data-files-dock]")?.hasAttribute("data-draft")).toBe(true);
    expect(document.querySelector('[data-surface-skeleton="transcript"]')).toBeNull();
  });

  it("asks find at most once a subject over three opens of its tab", async () => {
    const find = vi.fn(async () => null);
    for (let i = 0; i < 3; i++) {
      const { unmount } = draw(subject(find));
      await act(async () => undefined);
      unmount();
    }
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("asks again after a find that failed", async () => {
    const find = vi.fn(async (): Promise<string | null> => {
      throw new Error("host down");
    });
    for (let i = 0; i < 2; i++) {
      const { unmount } = draw(subject(find));
      await act(async () => undefined);
      unmount();
    }
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("shows the thread find names in the empty draft's place", async () => {
    vi.spyOn(sessionStore, "metaOf").mockImplementation(((id: string) => (id === "t-old" ? OLD : null)) as never);
    draw(subject(async () => "t-old"));
    const draft = shownId();
    expect(draft).not.toBe("t-old");
    await act(async () => undefined);
    expect(shownId()).toBe("t-old");
  });

  it("keeps the draft he has typed in when find answers late", async () => {
    vi.spyOn(sessionStore, "metaOf").mockImplementation(((id: string) => (id === "t-old" ? OLD : null)) as never);
    let answer: (id: string | null) => void = () => undefined;
    draw(subject(() => new Promise((r) => (answer = r))));
    const draft = shownId();
    document.querySelector("[data-composer-input]")!.textContent = "What changed in March?";
    await act(async () => answer("t-old"));
    expect(shownId()).toBe(draft);
  });
});
