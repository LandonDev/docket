// @vitest-environment jsdom
/** The head's place: over a Work thread's first message alone; a code thread draws and loads nothing there. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const scope = vi.hoisted(() => ({ work: new Set<string>(), asked: [] as (string | null | undefined)[] }));
vi.mock("../lib/workRow", () => ({
  useWorkSessionId: (id: string | null | undefined) => {
    scope.asked.push(id);
    return !!id && scope.work.has(id);
  },
}));
vi.mock("./chunks", () => ({
  workHeadChunk: { surface: () => ({ sessionId }: { sessionId: string }) => <span data-testid="head">{sessionId}</span> },
}));

import { ThreadHeadContext, ThreadHeadSlot, TranscriptSessionContext } from "./transcriptSession";

afterEach(cleanup);

const slot = (session: string, head: string | null, block: string) =>
  render(
    <TranscriptSessionContext.Provider value={session}>
      <ThreadHeadContext.Provider value={head}>
        <ThreadHeadSlot blockId={block} />
      </ThreadHeadContext.Provider>
    </TranscriptSessionContext.Provider>,
  );

describe("ThreadHeadSlot", () => {
  it("draws the head over a Work thread's first message", () => {
    scope.work = new Set(["w1"]);
    slot("w1", "b1", "b1");
    expect(screen.getByTestId("head").textContent).toBe("w1");
  });

  it("draws nothing over a later message, nor while older history is still to load", () => {
    scope.work = new Set(["w1"]);
    slot("w1", "b1", "b2");
    slot("w1", null, "b1");
    expect(screen.queryByTestId("head")).toBeNull();
  });

  it("draws nothing for a code thread", () => {
    scope.work = new Set();
    slot("c1", "b1", "b1");
    expect(screen.queryByTestId("head")).toBeNull();
  });
});
