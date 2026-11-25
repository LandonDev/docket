// @vitest-environment jsdom
/**
 * A text file's editor (docs/agents/work-files.md "The file kind"): its frame is a Work editor's that answers find, so
 * Edit → Find… and ⌘F open its own find bar, never the Files place's search; a text replaced from the host opens where
 * he was. CodeMirror is the dom project's stub here; what it computes is textPlace.test.ts's.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editorAnswers, editorKeys, workCommands } from "../../lib/appCommands";

const opened = vi.hoisted(() => [] as unknown[]);
vi.mock("@codemirror/search", async (original) => ({ ...(await original<object>()), openSearchPanel: (view: unknown) => (opened.push(view), true) }));
const { FileTextEditor } = await import("./FileTextEditor");

afterEach(cleanup);

describe("a text file's editor", () => {
  it("is a Work editor that answers find: Edit → Find… and ⌘F open its find bar", () => {
    const { container } = render(<FileTextEditor name="Notes.txt" path="/w/Notes.txt" text={"one\ntwo\n"} readOnly={false} onChange={() => {}} />);
    const frame = container.querySelector("[data-file-text]")!;
    expect(editorKeys(frame.firstElementChild)).toBe("text");
    expect(editorAnswers(frame.firstElementChild, "find")).toBe(true);
    expect(opened).toHaveLength(0);
    act(() => void workCommands.run("find"));
    expect(opened).toHaveLength(1);
  });

  it("keeps where he was when it goes, and the next editor scrolls there", () => {
    const place = { current: null as { top: number; head: number } | null };
    const first = render(<FileTextEditor name="Notes.txt" path="/w/Notes.txt" text="0123456789" readOnly={false} onChange={() => {}} place={place} />);
    first.unmount();
    expect(place.current).toEqual({ top: 0, head: 0 });
    place.current = { top: 240, head: 8 };
    const scrolled = vi.spyOn(Element.prototype, "scrollTop", "set");
    try {
      render(<FileTextEditor name="Notes.txt" path="/w/Notes.txt" text="01234" readOnly={false} onChange={() => {}} place={place} />);
      expect(scrolled).toHaveBeenCalledWith(240);
    } finally {
      scrolled.mockRestore();
    }
  });
});
