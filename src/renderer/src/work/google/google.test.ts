import { describe, expect, it } from "vitest";
import { writtenLine } from "./docMore";

describe("what Write to Google says", () => {
  it("counts what went, and names what stayed", () => {
    expect(writtenLine({ changed: 1, added: 1, removed: 0, refused: [] })).toBe("Wrote 2 changes to Google");
    expect(writtenLine({ changed: 0, added: 0, removed: 0, refused: [] })).toBe("Nothing new to write");
    expect(writtenLine({ changed: 1, added: 0, removed: 0, refused: ["“Budget”: its words changed in Google since it was read"] })).toBe(
      "Wrote 1 change to Google. Not written: “Budget”: its words changed in Google since it was read",
    );
  });
});
