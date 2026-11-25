// @vitest-environment jsdom
/**
 * A dock whose subject comes to name another file under the same key (Keep Both moved the file tab to its copy):
 * a lookup still out for the original file's chat is let go, so its answer never takes the draft's place, and the
 * new file's chat is asked for (Dock.tsx).
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockSubject } from "./subject";

vi.mock("../../lib/threads/agents", () => ({ useMetaById: () => null, useSessionById: () => undefined }));
vi.mock("../../surfaces/threadChat", () => ({
  useSessionActions: () => ({}),
  useThreadChat: () => ({ renderChat: () => null, renderSlots: () => null, composerOf: () => <div data-composer-input contentEditable />, newPassArmed: false, armNewPass: () => undefined }),
}));
vi.mock("../../surfaces/threads/ThreadView", () => ({ ThreadView: () => <div data-testid="thread-view" /> }));
vi.mock("../../chrome/ConnectionLine", () => ({ useEnvironmentBlock: () => ({ name: "the box", degraded: null }) }));
vi.mock("../../surfaces/SessionPane", () => ({ LoadLine: () => null }));
const shown = vi.hoisted(() => [] as string[]);
vi.mock("./dockThread", () => ({
  dockThreadNow: () => ({ id: "d1", draft: true }),
  findThread: (subject: DockSubject) => subject.find(),
  draftIsEmpty: () => true,
  showFound: (_key: string, id: string) => void shown.push(id),
  plannedDraft: () => undefined,
  enterDock: () => undefined,
  leaveDock: () => undefined,
  rebindDock: () => undefined,
}));

const { Dock } = await import("./Dock");

afterEach(() => {
  cleanup();
  shown.length = 0;
});

const about = (path: string, find: () => Promise<string | null>): DockSubject => ({
  key: "tab-1",
  title: path,
  chips: [{ kind: "file", path, name: path } as never],
  chipIn: "composer",
  find,
});
const draw = (subject: DockSubject) => (
  <Dock name="files" workspace={{ id: "w1", environmentId: "box" } as never} subject={subject} chip={null} focus={false} head={() => null} onChipTaken={() => undefined} onClose={() => undefined} />
);

describe("a dock whose file tab moved to its Keep Both copy", () => {
  it("lets the original file's lookup go and asks for the copy's chat", async () => {
    let answer!: (id: string | null) => void;
    const first = vi.fn(() => new Promise<string | null>((ok) => (answer = ok)));
    const second = vi.fn(async () => null);
    const view = render(draw(about("/w/Notes.md", first)));
    expect(first).toHaveBeenCalledTimes(1);
    view.rerender(draw(about("/w/Notes (mine).md", second)));
    await act(async () => answer("chat-of-notes"));
    expect(shown).toEqual([]);
    expect(document.querySelector("[data-files-dock]")?.getAttribute("data-files-dock")).toBe("d1");
    expect(second).toHaveBeenCalledTimes(1);
  });
});
