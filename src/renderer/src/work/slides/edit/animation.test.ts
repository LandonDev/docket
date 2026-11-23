import { describe, expect, it } from "vitest";
import { slide } from "../testkit";
import { addable, buildsHold, buildsOp, comesOf, kindName, moved, parseSeconds, transitionOp } from "./animation";

describe("the Animate tab's rules", () => {
  it("reads a transition as the tab holds it: a cut is None, a push keeps its side, the wait in seconds", () => {
    expect(comesOf(undefined)).toEqual({ kind: "none", dir: "u", click: true, after: null });
    expect(comesOf({ kind: "cut", ms: 0, click: false })).toEqual({ kind: "none", dir: "u", click: false, after: null });
    expect(comesOf({ kind: "push", dir: "l", ms: 750, after: 2500 })).toEqual({ kind: "push", dir: "l", click: true, after: 2.5 });
    expect([kindName("fade"), kindName("wipe"), kindName("randomBar")]).toEqual(["Fade", "Wipe", "Random bar"]);
  });

  it("sends a side only with a push", () => {
    expect(transitionOp(3, { kind: "fade", dir: "l", click: true, after: null })).toEqual({ op: "transition", slide: 3, kind: "fade", click: true, after: null });
    expect(transitionOp(3, { kind: "push", dir: "d", click: false, after: 1 })).toEqual({ op: "transition", slide: 3, kind: "push", dir: "d", click: false, after: 1 });
  });

  it("reads seconds as he types them", () => {
    expect(["5", "2.5 s", "2,5", "10 sec", " 0 ", "-1", "five", "90000"].map(parseSeconds)).toEqual([5, 2.5, 2.5, 10, 0, null, null, null]);
  });

  it("moves a build within the list, and offers only shapes outside any group not yet in it", () => {
    expect(moved([1, 2, 3], 3, -1)).toEqual([1, 3, 2]);
    expect(moved([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
    const s = slide(3, { shapes: [{ id: 1, name: "a", bbox: null, text: "" }, { id: 2, name: "b", bbox: null, text: "", group: 9 }, { id: 4, name: "c", bbox: null, text: "" }] });
    expect(addable(s, [4]).map((x) => x.id)).toEqual([1]);
  });

  it("sends the whole order, each shape still in it keeping its Fade, in the order's own order", () => {
    expect(buildsOp(3, [4, 2, 5], [5, 4])).toEqual({ op: "builds", slide: 3, order: [4, 2, 5], fade: [4, 5] });
    expect(buildsOp(3, [2, 5], [5, 4])).toEqual({ op: "builds", slide: 3, order: [2, 5], fade: [5] });
    // None that fades: the op as it always was.
    expect(buildsOp(3, [2], [5])).toEqual({ op: "builds", slide: 3, order: [2] });
    expect(buildsOp(3, [], [5])).toEqual({ op: "builds", slide: 3, order: [] });
  });

  it("sets the builds only where the host reads back just the order; else says why in a few words", () => {
    expect(buildsHold(slide(3))).toEqual({ order: [], fade: [] });
    expect(buildsHold(slide(3, { builds: { steps: [], changed: 0, order: [5] } }))).toEqual({ order: [5], fade: [] });
    expect(buildsHold(slide(3, { builds: { steps: [], changed: 0, order: [5, 4], fade: [4] } }))).toEqual({ order: [5, 4], fade: [4] });
    expect(buildsHold(slide(3, { builds: { steps: [{ shapes: [5], paras: [] }, { shapes: [], paras: [] }], changed: 1 } }))).toEqual({ why: "Its effects are more than appear or fade on click", replace: true });
    expect(buildsHold(slide(3, { builds: { steps: [{ shapes: [], paras: [] }], changed: 1, whole: "a nesting the reader does not know" } }))).toEqual({ why: "Its timing is more than this app reads", replace: true });
    expect(buildsHold(slide(3, { builds: { steps: [{ shapes: [4, 5], paras: [] }, { shapes: [], paras: [] }], changed: 0 } }))).toEqual({ why: "More than one shape comes in on a press", replace: true });
    expect(buildsHold(slide(3, { shapes: [{ id: 9, name: "s", bbox: null, text: "", kind: "media", media: "audio" }] }))).toEqual({ why: "It holds a sound", replace: false });
  });
});
