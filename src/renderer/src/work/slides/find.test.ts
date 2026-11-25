import { describe, expect, it } from "vitest";
import { deckMatches, FIND_CAP, findCount, firstFrom, placesIn } from "./find";
import { deckView, slide } from "./testkit";

const plain = { matchCase: false, wholeWord: false };

describe("find on a deck's words", () => {
  it("finds each place in a shape's words, by case and by whole word as he asks", () => {
    expect(placesIn("Players and players", "players", plain)).toEqual([0, 12]);
    expect(placesIn("Players and players", "players", { matchCase: true, wholeWord: false })).toEqual([12]);
    expect(placesIn("play, player, replay", "play", { matchCase: false, wholeWord: true })).toEqual([0]);
    expect(placesIn("café, cafés", "café", { matchCase: false, wholeWord: true })).toEqual([0]);
    expect(placesIn("anything", "", plain)).toEqual([]);
    // A match never overlaps the one before it.
    expect(placesIn("aaaa", "aa", plain)).toEqual([0, 2]);
  });

  it("walks slide by slide, each slide's shapes back to front and then its notes; a table cell by cell; a slide a change takes out left out", () => {
    const view = deckView({
      slides: [
        slide(1, { shapes: [{ id: 2, name: "Title 1", bbox: null, text: "Spring LAN" }], notes: "" }),
        slide(2, { shapes: [{ id: 3, name: "Body", bbox: null, text: "480 players" }], notes: "Players arrive at 9" }),
        slide(4, { key: "ghost:4", tint: "del", shapes: [{ id: 7, name: "Gone", bbox: null, text: "players" }] }),
        slide(3, { shapes: [{ id: 5, name: "Table 4", bbox: null, text: "", kind: "table", cells: [["Team", "Players"], ["A", "5"]] }] }),
      ],
    });
    const { matches, capped } = deckMatches(view, "players", plain);
    expect(capped).toBe(false);
    expect(matches).toEqual([
      { slideKey: "2", shape: 3, at: 4, length: 7 },
      { slideKey: "2", shape: null, at: 0, length: 7 },
      { slideKey: "3", shape: 5, at: 5, length: 7 },
    ]);
    // It starts on the slide on the stage or after it; past the last, on the deck's first.
    expect(firstFrom(view, matches, "3")).toBe(2);
    expect(firstFrom(view, matches, "1")).toBe(0);
    expect(firstFrom(view, deckMatches(view, "spring", plain).matches, "3")).toBe(0);
  });

  it("stops at the cap and says so", () => {
    const view = deckView({ slides: [slide(1, { shapes: [{ id: 2, name: "Words", bbox: null, text: "a ".repeat(FIND_CAP + 5) }] })] });
    const { matches, capped } = deckMatches(view, "a", plain);
    expect(matches).toHaveLength(FIND_CAP);
    expect(capped).toBe(true);
    expect(findCount("a", matches.length, 0, capped)).toBe("1 of 1,000+");
  });

  it("counts in the document's words", () => {
    expect(findCount("", 0, -1, false)).toBe("");
    expect(findCount("x", 0, -1, false)).toBe("No results");
    expect(findCount("x", 17, 2, false)).toBe("3 of 17");
  });
});
