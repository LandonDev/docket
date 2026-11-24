import { describe, expect, it } from "vitest";
import type { SearchHit } from "@shared/work/search";
import { ageWords, eventWords, factOf, lineAt, marksOf, timeOf } from "./words";

/** A row's muted words: how long ago, when, and its one fact. */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const now = new Date(2026, 10, 23, 15, 0).getTime();
const hit = (over: Partial<SearchHit>): SearchHit => ({ key: "k", kind: "mail", title: "T", workspaceId: "w", open: { to: "view", view: "mail" }, ...over });

describe("a row's words", () => {
  it("says how long ago in one short word", () => {
    expect([0, 30 * MIN, 5 * 60 * MIN, 2 * DAY, 21 * DAY, 75 * DAY, 800 * DAY].map((gone) => ageWords(now - gone, now))).toEqual(["now", "30m", "5h", "2d", "3w", "2mo", "2y"]);
    expect(ageWords(now + DAY, now)).toBe("now");
  });
  it("says when an event is with no year, even across the new year: the day, or the time today", () => {
    const next = eventWords(new Date(2027, 0, 12, 9, 0).getTime(), now);
    expect(next).not.toMatch(/2027/);
    expect(next).toMatch(/12/);
    expect(eventWords(new Date(2026, 10, 23, 17, 30).getTime(), now)).toMatch(/5:30/);
    // short enough for the time's column: never two lines
    expect(next.length).toBeLessThanOrEqual(7);
  });
  it("gives an event its day and what has passed its age; a task has no time, its due day is its fact", () => {
    expect(timeOf(hit({ kind: "event", at: new Date(2027, 0, 12).getTime() }), now)).toBe(eventWords(new Date(2027, 0, 12).getTime(), now));
    expect(timeOf(hit({ at: now - 2 * DAY }), now)).toBe("2d");
    expect(timeOf(hit({ kind: "task", at: now + DAY }), now)).toBeUndefined();
    expect(timeOf(hit({}), now)).toBeUndefined();
    expect(factOf(hit({ kind: "task", at: new Date(2026, 10, 27).getTime(), detail: "PUR-41" }), now)).toMatch(/^Due .*27$/);
    expect(factOf(hit({ kind: "task", at: now, detail: "Done" }), now)).toBe("Done");
    expect(factOf(hit({ kind: "task", detail: "PUR-41" }), now)).toBe("PUR-41");
  });
  it("shows the line the words were found in before the row's own fact", () => {
    expect(factOf(hit({ detail: "Vendor", snippet: "fits the budget" }), now)).toBe("fits the budget");
    expect(factOf(hit({ detail: "Vendor" }), now)).toBe("Vendor");
    expect(factOf(hit({}), now)).toBeUndefined();
  });
  it("begins a found line a word before the word that found it, when that lies past the row's start: the cut end never hides why", () => {
    const line = "…the seating and the parking, and then the vendor said the invoice for the deposit";
    expect(lineAt(line, "invoice")).toBe("…the invoice for the deposit");
    expect(factOf(hit({ snippet: line }), now, "invoice")).toBe("…the invoice for the deposit");
    // a word near the start, a line that does not hold the word, and no words: the line as it came
    expect(lineAt("The invoice is late", "invoice")).toBe("The invoice is late");
    expect(lineAt(line, "zebra")).toBe(line);
    expect(factOf(hit({ snippet: line }), now)).toBe(line);
  });
  it("finds the word as the hosts do, case and accents aside, marks it, and gives a long word before it no room", () => {
    const line = "…the menu for the long evening at the Café on State Street";
    expect(lineAt(line, "cafe")).toBe("…the Café on State Street");
    const text = "the Café on State";
    expect(marksOf(text, "cafe state").map((i) => text[i]).join("")).toBe("CaféState");
    expect(marksOf(text, "zebra")).toEqual([]);
    // a path before the word would fill the row: the line begins at the word
    expect(lineAt("…see https://example.edu/a/very/long/path/to/the/page budget lines", "budget")).toBe("…budget lines");
  });
});
