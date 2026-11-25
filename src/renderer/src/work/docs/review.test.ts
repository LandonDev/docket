import { describe, expect, it } from "vitest";
import { editMovesMarks, markedBlocks } from "./review";

describe("which edits move a suggestion's marks", () => {
  const marked = markedBlocks([
    { id: "b|blk1#0", group: "b", marks: [{ tone: "del", block: "blk1", from: 0, to: 4 }] },
    { id: "b|blk9", group: "b", marks: [{ tone: "add", after: "blk3", text: "New line" }] },
    { id: "b|first", group: "b", marks: [{ tone: "add", after: null, text: "Top" }] },
  ]);

  it("names the blocks marks stand in and the blocks an added block follows", () => {
    expect([...marked].sort()).toEqual(["blk1", "blk3"]);
  });

  it("an edit in a marked block moves them; one elsewhere does not; one that names no blocks is taken as moving them", () => {
    expect(editMovesMarks([{ block: { id: "blk1" } }], marked)).toBe(true);
    expect(editMovesMarks([{ block: { id: "blk3" } }], marked)).toBe(true);
    expect(editMovesMarks([{ block: { id: "blk2" } }, { block: { id: "blk4" } }], marked)).toBe(false);
    expect(editMovesMarks(null, marked)).toBe(true);
  });
});
