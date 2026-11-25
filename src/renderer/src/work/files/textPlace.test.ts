import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { handOver, openingCaret } from "./textPlace";

describe("a text file's editor, as CodeMirror computes it", () => {
  it("hands an edit over unread: its length at once, its characters only when read", () => {
    const doc = Text.of(["one", "two"]);
    const given = handOver(doc);
    expect(given.length).toBe(7);
    expect(given.read()).toBe("one\ntwo");
  });

  it("opens a replaced text with the caret where he was, held to the new text's end, and none before he was anywhere", () => {
    expect(openingCaret({ top: 0, head: 3 }, "0123456789")?.main.head).toBe(3);
    expect(openingCaret({ top: 0, head: 8 }, "01234")?.main.head).toBe(5);
    expect(openingCaret(null, "01234")).toBeUndefined();
  });
});
