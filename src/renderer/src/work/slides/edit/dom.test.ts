// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { DeckShape } from "@shared/contract-work-slides";
import { paint, placeOf, pointOf, readModel, readSel, writeSel } from "./dom";
import { modelOf, modelText, runsOp } from "./model";

const FALLBACK = { font: "Calibri", size: 18, color: "000000" };
const SHAPE: DeckShape = {
  id: 2,
  name: "Title 1",
  bbox: [0.1, 0.1, 0.9, 0.3],
  text: "Who comes",
  kind: "text",
  paragraphs: [
    { level: 0, align: "center", list: "none", runs: [{ text: "Who ", font: "Calibri", size: 40 }, { text: "comes", font: "Calibri", size: 40, bold: true, color: "1F4E79" }] },
    { level: 0, align: "left", list: "bullet", runs: [{ text: "One", size: 20 }, { text: "\n", size: 20 }, { text: "Two", size: 20 }] },
  ],
};
/** 960px of stage for a 16:9 slide 12,192,000 EMU wide. */
const EMU = 960 / 12_192_000;

function drawn() {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const model = modelOf(SHAPE, FALLBACK);
  paint(root, model, EMU);
  return { root, model };
}

describe("the typing box in the page", () => {
  it("draws one block a paragraph and one span a run, in the run's look scaled to the stage", () => {
    const { root } = drawn();
    const [title, list] = [...root.children] as HTMLElement[];
    expect(title.dataset.p).toBe("0");
    expect(title.style.textAlign).toBe("center");
    const comes = title.querySelector<HTMLElement>('[data-r="0:1"]')!;
    expect(comes.textContent).toBe("comes");
    expect(comes.style.fontWeight).toBe("700");
    // 40pt on a 960px stage: 40 × 12,700 EMU × 960 / 12,192,000.
    expect(Number.parseFloat(comes.style.fontSize)).toBeCloseTo(40, 1);
    expect(comes.style.fontFamily).toContain("Carlito");
    expect(list.style.display).toBe("list-item");
    expect(list.style.listStyleType).toBe("disc");
    // A line break is a <br> inside its run.
    expect(list.querySelectorAll("br")).toHaveLength(1);
  });

  it("reads back what it drew unchanged", () => {
    const { root, model } = drawn();
    expect(readModel(root, model)).toEqual(model);
  });

  it("reads words typed into a run, and words the browser put in no run, into the run before them", () => {
    const { root, model } = drawn();
    const who = root.querySelector('[data-r="0:0"]')!.firstChild as Text;
    who.data = "Who now ";
    root.querySelector('[data-r="0:1"]')!.after(document.createTextNode("!"));
    const read = readModel(root, model);
    expect(modelText(read)).toBe("Who now comes!\nOne\nTwo");
    expect(runsOp(read, 1, 2).paragraphs[0].runs).toEqual([
      { text: "Who now ", from: [0, 0] },
      { text: "comes!", from: [0, 1] },
    ]);
  });

  it("reads two paragraphs the browser joined, each run still from where it came", () => {
    const { root, model } = drawn();
    const [title, list] = [...root.children] as HTMLElement[];
    title.append(...list.childNodes);
    list.remove();
    const read = readModel(root, model);
    expect(read).toHaveLength(1);
    expect(runsOp(read, 1, 2).paragraphs).toEqual([{ from: 0, runs: [{ text: "Who ", from: [0, 0] }, { text: "comes", from: [0, 1] }, { text: "One", from: [1, 0] }, { text: "\n", from: [1, 1] }, { text: "Two", from: [1, 2] }] }]);
  });

  it("drops the browser's own last break, and reads an emptied paragraph as one with no words", () => {
    const { root, model } = drawn();
    const title = root.children[0] as HTMLElement;
    title.replaceChildren(document.createElement("br"));
    const read = readModel(root, model);
    expect(read[0].runs).toEqual([]);
    expect(read[0].from).toBe(0);
    // Words typed into it take the paragraph's look.
    title.replaceChildren(document.createTextNode("Hi"), document.createElement("br"));
    expect(readModel(root, model)[0].runs).toEqual([{ text: "Hi", look: model[0].look, set: {} }]);
  });

  it("maps a place in the page to a place among the words and back, a line break counting one", () => {
    const { root } = drawn();
    const two = root.querySelector('[data-r="1:2"]')!.firstChild as Text;
    expect(pointOf(root, two, 1)).toEqual([1, 5]);
    expect(pointOf(root, root.children[1], 0)).toEqual([1, 0]);
    expect(pointOf(root, root, 2)).toEqual([1, 7]);
    expect(pointOf(root, document.body, 0)).toBeNull();
    // Between two runs, the end of the run before.
    const [node, offset] = placeOf(root, [0, 4]);
    expect(node.textContent).toBe("Who ");
    expect(offset).toBe(4);
    for (const point of [[0, 0], [0, 6], [1, 3], [1, 4], [1, 7]] as const) {
      const [n, o] = placeOf(root, point);
      expect(pointOf(root, n, o)).toEqual(point);
    }
  });

  it("reads and writes the page's selection as a selection of the words", () => {
    const { root } = drawn();
    writeSel(root, { from: [0, 2], to: [1, 2] });
    expect(readSel(root)).toEqual({ from: [0, 2], to: [1, 2] });
    document.getSelection()!.removeAllRanges();
    expect(readSel(root)).toBeNull();
  });
});
