import { describe, expect, it } from "vitest";
import { deckView, slide } from "../testkit";
import { centred, layoutAfter, layoutsFor, madeShape, madeSlide, pictureAt, shapeAt, tableAt } from "./add";
import { moveOp, sectionIndex, slidesOpen } from "./slides";

const SIZE = { width: 12_192_000, height: 6_858_000 };
const LAYOUTS = [
  { name: "Title Slide", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "subtitle", idx: 1 }] },
  { name: "Title and Content", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "body", idx: 1 }, { kind: "date", idx: 10 }] },
  { name: "Two Content", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "body", idx: 1 }, { kind: "body", idx: 2 }, { kind: "date", idx: 10 }] },
  { name: "Title Only", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "date", idx: 10 }] },
  { name: "Other Body", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "body", idx: 2 }, { kind: "date", idx: 10 }] },
];

describe("where a new shape lands", () => {
  it("in the slide's middle, a shape at its own proportions", () => {
    expect(centred(SIZE, 1000, 500)).toEqual([(SIZE.width - 1000) / 2, (SIZE.height - 500) / 2, 1000, 500]);
    const [, , w, h] = shapeAt(SIZE, "rightArrow");
    expect(w / h).toBeCloseTo(2);
    expect(h).toBe(Math.round(SIZE.height * 0.3));
  });

  it("a picture at its own size at 96 to the inch, smaller to fit three fifths of the slide, never larger", () => {
    expect(pictureAt(SIZE, 200, 100).slice(2)).toEqual([200 * 9525, 100 * 9525]);
    const [, , w, h] = pictureAt(SIZE, 4000, 3000);
    expect(w / h).toBeCloseTo(4 / 3, 3);
    expect(h).toBeLessThanOrEqual(SIZE.height * 0.6 + 1);
    // A size the window could not read: a 16:9 box three fifths across.
    expect(pictureAt(SIZE, 0, 0)[2]).toBe(Math.round(SIZE.width * 0.6));
  });

  it("a table by its columns and rows, never past four fifths of the slide", () => {
    expect(tableAt(SIZE, 3, 4).slice(2)).toEqual([4 * 914_400 * 1.5, 3 * 914_400 * 0.4]);
    expect(tableAt(SIZE, 50, 30)[2]).toBe(Math.round(SIZE.width * 0.8));
  });
});

describe("the layouts a slide can take", () => {
  const view = deckView({ layouts: LAYOUTS, slides: [slide(1, { layout: "Title and Content" }), slide(2, { layout: "Title Slide" })] });

  it("are its own and each that holds every place of its own by index and kind", () => {
    expect(layoutsFor(view, view.slides[0]).map((l) => l.name)).toEqual(["Title and Content", "Two Content"]);
    // A layout the deck does not list offers nothing.
    expect(layoutsFor(view, slide(3, { layout: "Gone" }))).toEqual([]);
  });

  it("are the host's own list where it gives one, whatever the placeholders seem to say", () => {
    expect(layoutsFor(view, slide(1, { layout: "Title and Content", layoutsFit: ["Title and Content", "Title Slide"] })).map((l) => l.name).sort()).toEqual(["Title Slide", "Title and Content"]);
    expect(layoutsFor(view, slide(1, { layout: "Title and Content", layoutsFit: [] }))).toEqual([]);
  });

  it("a new slide takes the one it follows, or after a title slide the next with a body", () => {
    expect(layoutAfter(view, view.slides[0])).toBe("Title and Content");
    expect(layoutAfter(view, view.slides[1])).toBe("Title and Content");
  });
});

describe("what an edit made", () => {
  it("is the shape or the slide whose id was not there", () => {
    const before = deckView({ slides: [slide(1, { shapes: [{ id: 2, name: "", bbox: null, text: "" }] })] });
    const after = deckView({ slides: [slide(1, { shapes: [{ id: 2, name: "", bbox: null, text: "" }, { id: 7, name: "", bbox: null, text: "" }] }), slide(4)] });
    expect(madeShape(before.slides[0], after, 1)?.id).toBe(7);
    expect(madeSlide(before, after)?.id).toBe(4);
    expect(madeShape(before.slides[0], null, 1)).toBeUndefined();
  });
});

describe("slides by hand", () => {
  const view = deckView({ slides: [slide(1, { section: "A" }), slide(2), slide(3, { section: "B" }), slide(4)], hand: { undo: false, redo: false } });

  it("a slide's new place is after the one before it, or first; none when it did not move", () => {
    expect(moveOp(["2", "1", "3", "4"], "1", view)).toEqual({ op: "move", slide: 1, after: 2 });
    expect(moveOp(["4", "1", "2", "3"], "4", view)).toEqual({ op: "move", slide: 4, after: 0 });
    expect(moveOp(["1", "2", "3", "4"], "3", view)).toBeNull();
  });

  it("a section is counted by the slides before it that start one", () => {
    expect(sectionIndex(view, view.slides[0])).toBe(0);
    expect(sectionIndex(view, view.slides[2])).toBe(1);
  });

  it("are his only by hand and with no suggestion waiting", () => {
    expect(slidesOpen(view)).toBe(true);
    expect(slidesOpen({ ...view, hand: undefined })).toBe(false);
    expect(slidesOpen({ ...view, changes: [{ id: "c", kind: "changed", slideId: 1, label: "", edits: [], by: "agent:local:t1" }] })).toBe(false);
  });
});
