// @vitest-environment jsdom
/**
 * A Work thread's first message carries no "Project rules N words" row: the rules live in its project's settings. A
 * code thread's keeps the row.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Block } from "../../lib/session";
import { sessionStore } from "../../lib/tcserver/store";
import { TranscriptSessionContext } from "../transcriptSession";
import { UserMessageBlock } from "./UserMessage";

const first: Block = { id: "u", role: "user", text: "Count the patch cables", ts: 1, preamble: { text: "Keep it short.", words: 3 } };

function mount(id: string, scope: "work" | undefined) {
  sessionStore.mutate((prev) => [...prev.filter((s) => s.id !== id), { id, environmentId: "local", scope, blocks: [first] } as never]);
  return render(
    <TranscriptSessionContext.Provider value={id}>
      <UserMessageBlock block={first} stickyIndex={1} environmentId="local" />
    </TranscriptSessionContext.Provider>,
  );
}

afterEach(cleanup);

describe("the project rules row", () => {
  it("is not drawn in a Work thread", () => {
    const { container } = mount("w1", "work");
    expect(container.querySelector("[data-preamble-row]")).toBeNull();
    expect(container.querySelector("[data-user-bubble]")?.textContent).toBe("Count the patch cables");
  });

  it("stays in a code thread", () => {
    const { container } = mount("c1", undefined);
    expect(container.querySelector("[data-preamble-row]")?.textContent).toContain("Project rules");
  });
});
