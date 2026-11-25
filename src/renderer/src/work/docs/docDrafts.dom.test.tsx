// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Draft } from "@shared/work/drafts";
import type { SavedLine } from "../canvas/kind";

/** The document's offer of a kept draft in the save line (DocumentCanvas.tsx `useDocDrafts`). */

vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ error: vi.fn(), message: vi.fn() }) }));
const { useDocDrafts } = await import("./DocumentCanvas");

const AT = new Date(new Date().setHours(14, 30, 0, 0)).getTime();
const draft: Draft = { workspaceId: "w1", holder: "box", file: "f", base: "open-a", name: "Plan.tcdoc", at: AT, body: { kind: "document", frames: ["AmQxAAIq"] } };

function setUp(replays: boolean) {
  const lines: (SavedLine | null)[] = [];
  const journal = { keep: vi.fn(), clear: vi.fn(), release: vi.fn(), drop: vi.fn(), offered: vi.fn(async () => [draft]) };
  const host = { keepDrafts: vi.fn(), replay: vi.fn(() => replays) };
  const shell = { saved: (line: SavedLine | null) => void lines.push(line) };
  const hook = renderHook(() => useDocDrafts(host as never, journal as never, shell as never));
  return { lines, journal, host, hook };
}

describe("a document's kept draft", () => {
  it("is offered as the document opens, and Restore sends its updates again, then lets its record go", async () => {
    const { lines, journal, host, hook } = setUp(true);
    await waitFor(() => expect(lines.at(-1)).toMatchObject({ state: "conflict", detail: "Edits from 2:30 PM were not saved" }));
    expect(lines.at(-1)!.actions!.map((a) => a.label)).toEqual(["Restore", "Discard"]);
    expect(host.keepDrafts).toHaveBeenCalledTimes(1);
    await lines.at(-1)!.actions![0]!.run();
    expect(host.replay).toHaveBeenCalledWith(["AmQxAAIq"]);
    expect(journal.drop).toHaveBeenCalledWith(draft);
    await waitFor(() => expect(lines.at(-1)).toBeNull());
    hook.unmount();
    expect(journal.release).toHaveBeenCalled();
  });

  it("keeps the draft when no socket can take it yet", async () => {
    const { lines, journal } = setUp(false);
    await waitFor(() => expect(lines.at(-1)?.actions?.length).toBe(2));
    await lines.at(-1)!.actions![0]!.run();
    expect(journal.drop).not.toHaveBeenCalled();
  });
});
