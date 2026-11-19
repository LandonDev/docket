import { describe, expect, it } from "vitest";
import { commentLeft } from "./place";

describe("the comment field's place", () => {
  it("starts at the selection, moves left near the page's right edge, and never past its left", () => {
    expect(commentLeft(40, 320, 800)).toBe(40);
    expect(commentLeft(300, 320, 390)).toBe(70);
    expect(commentLeft(10, 390, 390)).toBe(0);
    expect(commentLeft(-6, 120, 390)).toBe(0);
  });
});
