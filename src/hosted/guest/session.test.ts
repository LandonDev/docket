import { describe, expect, it } from "vitest";
import { commentsOnPage } from "./session";

describe("the hosted page's own Comment action", () => {
  it("shows for a guest who may comment or edit, and never for a viewer", () => {
    expect(commentsOnPage("guest", "comment")).toBe(true);
    expect(commentsOnPage("guest", "edit")).toBe(true);
    expect(commentsOnPage("guest", "view")).toBe(false);
  });

  it("does not show for the owner: his comments are made in TempCode, and the page would send none of his words", () => {
    expect(commentsOnPage("owner", "edit")).toBe(false);
    expect(commentsOnPage("owner", "comment")).toBe(false);
  });
});
