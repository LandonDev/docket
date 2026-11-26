import { describe, expect, it, vi } from "vitest";
import { noHierarchyWords, sayAtCaret } from "./hierarchyMiss";

describe("a hierarchy with nothing at the caret", () => {
  it("says so at the caret through Monaco's message widget", () => {
    const showMessage = vi.fn();
    const editor = { getPosition: () => ({ lineNumber: 3, column: 7 }), getContribution: vi.fn(() => ({ showMessage })) };
    sayAtCaret(editor as never, noHierarchyWords("types"));
    expect(editor.getContribution).toHaveBeenCalledWith("editor.contrib.messageController");
    expect(showMessage).toHaveBeenCalledWith("No type hierarchy here", { lineNumber: 3, column: 7 });
    expect(noHierarchyWords("callers")).toBe("No call hierarchy here");
  });

  it("says nothing with no caret", () => {
    const editor = { getPosition: () => null, getContribution: vi.fn() };
    sayAtCaret(editor as never, "x");
    expect(editor.getContribution).not.toHaveBeenCalled();
  });
});
