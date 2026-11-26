import { describe, expect, it } from "vitest";
import { closedWords } from "./TaskSheet";

/** A closed task's sheet ends in a fact, never a lone "Done" where the presses stood. */
describe("closedWords", () => {
  const now = new Date(2026, 10, 26, 15, 0).getTime();
  const day = 86_400_000;

  it("says when a done task was done, as a row's day label says it", () => {
    expect(closedWords("done", now - day, now)).toBe("Done yesterday");
    expect(closedWords("done", new Date(2026, 10, 20, 9, 0).getTime(), now)).toBe(`Done ${new Date(2026, 10, 20).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
    expect(closedWords("done", now - 60_000, now)).toMatch(/^Done \d{1,2}:\d{2}/);
  });

  it("says Marked done with no time kept, Dropped for a dropped task, and nothing for an open one", () => {
    expect(closedWords("done", undefined, now)).toBe("Marked done");
    expect(closedWords("dropped", now - day, now)).toBe("Dropped");
    expect(closedWords("todo", undefined, now)).toBeUndefined();
  });
});
