import { describe, expect, it } from "vitest";
import { openingTag } from "@shared/work/files";
import { openingWords } from "./open";

/** A row opening another computer's file says how far its copy has got (open.ts `openingWords`), heard by its key's tag. */
describe("a row opening another computer's file", () => {
  it("says how far its copy has got", () => {
    expect(openingWords(512 * 1024, 5 * 1024 * 1024)).toBe("Opening… 0.5 of 5.0 MB");
    expect(openingWords(8 * 1024 * 1024, 20 * 1024 * 1024)).toBe("Opening… 8.0 of 20 MB");
  });

  it("hears its own push by a tag of its key, which names no path", () => {
    const key = "file:env_pc:J:\\Bench\\Deck.pptx";
    expect(openingTag(key)).toBe(openingTag(key));
    expect(openingTag(key)).not.toBe(openingTag("file:env_pc:J:\\Bench\\Big.docx"));
    expect(openingTag(key)).not.toContain("Bench");
  });
});
