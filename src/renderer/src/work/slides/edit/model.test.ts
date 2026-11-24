import { describe, expect, it } from "vitest";
import type { DeckShape } from "@shared/contract-work-slides";
import { allOf, applyLook, applyPara, deleteRange, endOf, insertText, modelOf, modelText, normalize, pasteText, rebase, renumber, runsOp, sameWords, showing, showingAll, splitParagraph, typable, unchanged, wordAt, type Sel, wireLook, formatOp } from "./model";

const FALLBACK = { font: "Calibri", size: 18, color: "000000" };

/** A title in two runs ("Who " plain, "comes" bold) over a line break, and a bulleted second paragraph. */
function shape(over: Partial<DeckShape> = {}): DeckShape {
  return {
    id: 2,
    name: "Title 1",
    bbox: [0.1, 0.1, 0.9, 0.3],
    text: "Who comes\nStudents",
    kind: "text",
    paragraphs: [
      { level: 0, align: "left", list: "none", runs: [{ text: "Who ", font: "Calibri", size: 40 }, { text: "comes", font: "Calibri", size: 40, bold: true }, { text: "\n", size: 40 }, { text: "", size: 40 }] },
      { level: 1, align: "center", list: "bullet", runs: [{ text: "Students", font: "Arial", size: 20, color: "FF0000" }] },
    ],
    ...over,
  };
}

const at = (p: number, c: number, q = p, d = c): Sel => ({ from: [p, c], to: [q, d] });

describe("the typing box's model", () => {
  it("takes a shape's paragraphs and runs from the outline, each run with the run it came from and its look", () => {
    const model = modelOf(shape(), FALLBACK);
    expect(model).toHaveLength(2);
    expect(model[0].runs.map((r) => [r.text, r.from, r.look.bold ?? false])).toEqual([
      ["Who ", [0, 0], false],
      ["comes", [0, 1], true],
      // A line break is a run of its own in the outline, counted as one; an empty run is dropped.
      ["\n", [0, 2], false],
    ]);
    expect(model[1]).toMatchObject({ from: 1, level: 1, align: "center", list: "bullet", set: {} });
    expect(model[1].runs[0].look).toEqual({ font: "Arial", size: 20, color: "FF0000" });
    expect(modelText(model)).toBe("Who comes\n\nStudents");
  });

  it("gives an empty placeholder one paragraph in the look of the nearest words, else the deck's", () => {
    expect(modelOf(shape({ paragraphs: [] }), FALLBACK)).toEqual([{ level: 0, align: "left", list: "none", set: {}, look: FALLBACK, pending: {}, runs: [] }]);
    const two = modelOf(shape({ paragraphs: [{ level: 0, align: "left", list: "none", runs: [] }, { level: 0, align: "left", list: "none", runs: [{ text: "Hi", size: 30 }] }] }), FALLBACK);
    expect(two[0].look.size).toBe(30);
    expect(typable(shape())).toBe(true);
    expect(typable(shape({ kind: "picture" }))).toBe(false);
    expect(typable(shape({ paragraphs: undefined }))).toBe(false);
    // A drawn shape with no words takes his, once the host lists its (empty) paragraphs.
    expect(typable(shape({ kind: "other", paragraphs: [] }))).toBe(true);
    expect(typable(shape({ kind: "other", paragraphs: undefined }))).toBe(false);
  });

  it("lays a look on a range across runs and paragraphs, splitting the runs at its ends and keeping where each came from", () => {
    const model = modelOf(shape(), FALLBACK);
    // "o comes" + "\n" + "Stu"
    const { model: next } = applyLook(model, at(0, 2, 1, 3), { italic: true, size: 28 });
    expect(next[0].runs.map((r) => [r.text, r.from, r.set])).toEqual([
      ["Wh", [0, 0], {}],
      ["o ", [0, 0], { italic: true, size: 28 }],
      ["comes", [0, 1], { italic: true, size: 28 }],
      ["\n", [0, 2], { italic: true, size: 28 }],
    ]);
    expect(next[1].runs.map((r) => [r.text, r.set])).toEqual([
      ["Stu", { italic: true, size: 28 }],
      ["dents", {}],
    ]);
    expect(next[1].runs[0].look).toEqual({ font: "Arial", size: 28, color: "FF0000", italic: true });
    // Taken off again, the halves of one run are one run.
    const back = applyLook(next, at(0, 0, 1, 8), { italic: false, size: 40 }).model;
    expect(back[1].runs).toHaveLength(1);
  });

  it("a caret in a word takes the whole word; a caret in a space keeps the look for the next words", () => {
    const model = modelOf(shape(), FALLBACK);
    expect(wordAt(model, [0, 6])).toEqual(at(0, 4, 0, 9));
    expect(wordAt(model, [0, 4])).toBeNull();
    const word = applyLook(model, at(0, 6), { underline: true });
    expect(word.model[0].runs.find((r) => r.text === "comes")?.set).toEqual({ underline: true });
    const space = applyLook(model, at(0, 3), { italic: true });
    expect(space.model).toBe(model);
    expect(space.pending).toEqual({ italic: true });
    // The next words take it, as a run of their own from the run before the caret.
    const typed = insertText(model, at(0, 3), "x", space.pending);
    expect(typed.model[0].runs.slice(0, 3).map((r) => [r.text, r.from, r.set])).toEqual([
      ["Who", [0, 0], {}],
      ["x", [0, 0], { italic: true }],
      [" ", [0, 0], {}],
    ]);
    expect(typed.at).toEqual([0, 4]);
    expect(showing(model, at(0, 3), space.pending).italic).toBe(true);
  });

  it("an empty paragraph keeps a look set on it for the words typed into it", () => {
    const model = modelOf(shape({ paragraphs: [] }), FALLBACK);
    const bold = applyLook(model, at(0, 0), { bold: true });
    expect(bold.model[0].pending).toEqual({ bold: true });
    const typed = insertText(bold.model, at(0, 0), "Hello");
    expect(typed.model[0].runs).toEqual([{ text: "Hello", look: { ...FALLBACK, bold: true }, set: { bold: true } }]);
  });

  it("sets a paragraph's alignment, list and level on every paragraph a selection touches", () => {
    const model = applyPara(modelOf(shape(), FALLBACK), at(0, 1, 1, 1), { align: "right", list: "number" });
    expect(model.map((p) => [p.align, p.list, p.set])).toEqual([
      ["right", "number", { align: "right", list: "number" }],
      ["right", "number", { align: "right", list: "number" }],
    ]);
  });

  it("Return cuts a paragraph in two that both keep the paragraph they came from; Backspace over the cut joins them", () => {
    const model = modelOf(shape(), FALLBACK);
    const split = splitParagraph(model, at(1, 3));
    expect(split.at).toEqual([2, 0]);
    expect(split.model.map((p) => [p.from, p.list, paraWords(p)])).toEqual([
      [0, "none", "Who comes\n"],
      [1, "bullet", "Stu"],
      [1, "bullet", "dents"],
    ]);
    const joined = deleteRange(split.model, at(1, 3, 2, 0));
    expect(modelText(joined.model)).toBe(modelText(model));
    expect(joined.model[1].runs).toHaveLength(1);
  });

  it("a paste is plain text, each line a paragraph", () => {
    const model = modelOf(shape(), FALLBACK);
    const pasted = pasteText(model, at(0, 4, 0, 9), "goes\r\nfirst\nlast");
    expect(modelText(pasted.model)).toBe("Who goes\nfirst\nlast\n\nStudents");
    expect(pasted.at).toEqual([2, 4]);
    expect(pasted.model[0].runs.map((r) => r.text)).toEqual(["Who goes"]);
  });

  it("shows a value where the whole selection agrees, and mixed where it does not", () => {
    const model = modelOf(shape(), FALLBACK);
    expect(showing(model, at(0, 0, 0, 4))).toMatchObject({ font: "Calibri", size: 40, bold: false });
    expect(showing(model, at(0, 2, 0, 7))).toMatchObject({ font: "Calibri", size: 40, bold: false, color: "000000" });
    expect(showing(model, at(0, 4, 0, 9)).bold).toBe(true);
    const all = showingAll(model);
    expect(all).toMatchObject({ font: null, size: null, bold: false, color: null, align: null, list: null, level: null });
    // A caret shows the words before it.
    expect(showing(model, at(0, 6)).bold).toBe(true);
    expect(showing(model, at(1, 0))).toMatchObject({ font: "Arial", align: "center", list: "bullet" });
  });

  it("goes back as one runs edit naming where each run and paragraph came from and only what he set", () => {
    const model = modelOf(shape(), FALLBACK);
    let next = insertText(model, at(0, 9), " today").model;
    next = applyLook(next, at(0, 10, 0, 15), { color: "00AA00" }).model;
    next = splitParagraph(next, endOf(next)).model;
    next = insertText(next, endOf(next), "Staff").model;
    next = applyPara(next, at(2, 0), { level: 0 });
    expect(runsOp(next, 256, 2)).toEqual({
      op: "runs",
      slide: 256,
      shape: 2,
      paragraphs: [
        { from: 0, runs: [{ text: "Who ", from: [0, 0] }, { text: "comes ", from: [0, 1] }, { text: "today", from: [0, 1], color: "00AA00" }, { text: "\n", from: [0, 2] }] },
        { from: 1, runs: [{ text: "Students", from: [1, 0] }] },
        { from: 1, level: 0, runs: [{ text: "Staff", from: [1, 0] }] },
      ],
    });
  });

  it("knows when nothing changed, so nothing is sent", () => {
    const model = modelOf(shape(), FALLBACK);
    expect(unchanged(model, model)).toBe(true);
    const typed = insertText(model, at(0, 9), "!").model;
    expect(unchanged(typed, model)).toBe(false);
    expect(unchanged(deleteRange(typed, at(0, 9, 0, 10)).model, model)).toBe(true);
    const looked = applyLook(model, at(0, 0, 0, 3), { bold: true }).model;
    expect(unchanged(applyLook(looked, at(0, 0, 0, 3), { bold: false }).model, model)).toBe(false);
  });

  it("keeps his words over a shape that changed under him, dropping each place the new words no longer have", () => {
    const model = splitParagraph(modelOf(shape(), FALLBACK), allOf(modelOf(shape(), FALLBACK))).model;
    const shorter = shape({ paragraphs: [{ level: 0, align: "left", list: "none", runs: [{ text: "Who", size: 40 }] }] });
    const kept = rebase(insertText(modelOf(shape(), FALLBACK), at(1, 8), "!").model, shorter);
    expect(kept[0].from).toBe(0);
    expect(kept[0].runs.map((r) => r.from)).toEqual([[0, 0], undefined, undefined]);
    expect(kept[1].from).toBeUndefined();
    expect(kept[1].runs[0]).not.toHaveProperty("from");
    expect(model).toHaveLength(2);
    expect(sameWords(shape(), shape())).toBe(true);
    expect(sameWords(shape(), shorter)).toBe(false);
    expect(sameWords(undefined, shape())).toBe(false);
  });

  it("sends a theme colour as the theme's own slot and tint, and a plain colour as its hex", () => {
    const model = modelOf(shape(), FALLBACK);
    const all = allOf(model);
    // A theme swatch: drawn as the hex it comes to, sent as the slot, so it stays the theme's when the theme changes.
    const themed = applyLook(model, all, { color: "8FAADC", theme: { slot: "accent1", tint: 0.4 } }).model;
    expect(runsOp(themed, 5, 7).paragraphs[0].runs.every((r) => JSON.stringify(r.color) === JSON.stringify({ slot: "accent1", tint: 0.4 }))).toBe(true);
    expect(formatOp(5, 7, { color: "8FAADC", theme: { slot: "accent1", tint: 0.4 }, bold: true, align: "center" }).set).toEqual({ color: { slot: "accent1", tint: 0.4 }, bold: true, align: "center" });
    // A plain colour picked over it clears the slot.
    const plain = applyLook(themed, all, { color: "FF0000", theme: null }).model;
    expect(runsOp(plain, 5, 7).paragraphs[0].runs.every((r) => r.color === "FF0000")).toBe(true);
    expect(wireLook({ bold: true })).toEqual({ bold: true });
    expect(wireLook({ color: "000000", theme: { slot: "tx1" } })).toEqual({ color: { slot: "tx1" } });
  });

  it("merges only runs from one run of the file with one look", () => {
    const model = modelOf(shape(), FALLBACK);
    const merged = normalize([{ ...model[0], runs: [model[0].runs[0], { ...model[0].runs[0], text: "x" }, model[0].runs[1]] }]);
    expect(merged[0].runs.map((r) => r.text)).toEqual(["Who x", "comes"]);
  });
});

const paraWords = (p: { runs: Array<{ text: string }> }): string => p.runs.map((r) => r.text).join("");

describe("a box's words once the host wrote them", () => {
  it("moves every run and paragraph onto where the edit wrote it: a run one file run a piece, each line break one", () => {
    const words = modelOf(shape(), FALLBACK);
    // Return after "Who ", then a line break typed into the second paragraph, and half of "Students" made italic.
    const split = splitParagraph(words, at(0, 4));
    const broke = insertText(split.model, at(2, 3), "\n").model;
    const sent = applyLook(broke, at(2, 5, 2, 9), { italic: true }).model;
    expect(sent.map((p) => [p.from, p.runs.map((r) => [r.text, r.from])])).toEqual([
      [0, [["Who ", [0, 0]]]],
      [0, [["comes", [0, 1]], ["\n", [0, 2]]]],
      [1, [["Stu\nd", [1, 0]], ["ents", [1, 0]]]],
    ]);
    const moved = renumber(sent)(sent);
    expect(moved.map((p) => [p.from, p.runs.map((r) => [r.text, r.from])])).toEqual([
      [0, [["Who ", [0, 0]]]],
      [0, [["comes", [1, 0]], ["\n", [1, 1]]]],
      // "Stu", a break and "d" are three runs of the file: "ents" is its fourth.
      [2, [["Stu\nd", [2, 0]], ["ents", [2, 3]]]],
    ]);
    // What the edit sends next names those, and nothing changed reads as nothing changed.
    expect(unchanged(moved, renumber(sent)(sent))).toBe(true);
    expect(runsOp(moved, 3, 2).paragraphs[2]).toEqual({ from: 2, runs: [{ text: "Stu\nd", from: [2, 0] }, { text: "ents", from: [2, 3], italic: true }] });
  });

  it("lets go of a run the edit did not write", () => {
    const words = modelOf(shape(), FALLBACK);
    const sent = deleteRange(words, at(0, 0, 0, 4)).model;
    const before = renumber(sent)(words);
    // "Who " was taken out before the send: an undo that brings it back has no run of the file to name.
    expect(before[0].runs.map((r) => [r.text, r.from])).toEqual([["Who ", undefined], ["comes", [0, 0]], ["\n", [0, 1]]]);
  });
});
