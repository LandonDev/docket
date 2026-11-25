import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckShape } from "@shared/contract-work-slides";
import { DeckStore } from "../deck";
import { boxShape, deckView, fakeDeckHost, slide } from "../testkit";
import { COPY_STEP, copyShape, duplicateBox, duplicateShape, forgetHeld, heldShape, pasteBox, pasteShape, SHAPE_TYPE } from "./clipboard";
import { HandSession } from "./session";

vi.mock("../../canvas/frame", () => ({ sayError: () => undefined }));

const SIZE = { width: 12_192_000, height: 6_858_000 };
const own = (box: [number, number, number, number]) => ({ box, rot: 0, flipH: false, flipV: false });
const TAG: DeckShape = { ...boxShape(4, [0.1, 0.1, 0.3, 0.2], { kind: "text", text: "Up 25%" }, SIZE), own: own([1_000_000, 700_000, 2_400_000, 700_000]) };

function deck(itemId: string, shapes: DeckShape[] = [TAG]) {
  const view = deckView({ itemId, slides: [slide(3, { number: 1, shapes }), slide(5, { number: 2 })], hand: { undo: false, redo: false }, size: SIZE });
  const host = fakeDeckHost(view);
  const store = new DeckStore();
  store.view(view);
  const session = new HandSession(host, store);
  const edits = () => host.calls.filter(([name]) => name === "edit").map(([, ops]) => ops);
  return { view, host, store, session, edits };
}

/** A clipboard as a copy or a paste event carries it. */
function board(): DataTransfer {
  const data = new Map<string, string>();
  return { setData: (type: string, value: string) => void data.set(type, value), getData: (type: string) => data.get(type) ?? "" } as unknown as DataTransfer;
}

beforeEach(() => forgetHeld());

describe("a shape duplicated", () => {
  it("lies 12 points down and right; from the copy the last ⌘D made, as far again as he moved it", async () => {
    const { session, store, view, host, edits } = deck("a");
    expect(duplicateBox("3", TAG)).toEqual([1_000_000 + COPY_STEP, 700_000 + COPY_STEP, 2_400_000, 700_000]);
    await duplicateShape(session, store, view.slides[0], TAG);
    expect(edits()).toEqual([[{ op: "copy", slide: 3, shape: 4, box: [1_000_000 + COPY_STEP, 700_000 + COPY_STEP, 2_400_000, 700_000] }]]);
    // The copy is picked, as an added shape is.
    const made = host.view.slides[0].shapes.at(-1)!;
    expect(session.get().picked).toEqual({ slideKey: "3", shapeId: made.id });
    // He moves the copy 1 cm right of the first; the next ⌘D on it goes as far again.
    const moved = { ...made, own: own([1_360_000, 700_000, 2_400_000, 700_000]) };
    expect(duplicateBox("3", moved)).toEqual([1_720_000, 700_000, 2_400_000, 700_000]);
    // On another shape it is the plain step again.
    expect(duplicateBox("3", TAG)).toEqual([1_000_000 + COPY_STEP, 700_000 + COPY_STEP, 2_400_000, 700_000]);
  });

  it("with no box of its own (a shape the host places), the host is left to place it", async () => {
    const loose = boxShape(7, [0.5, 0.5, 0.6, 0.6], { kind: "text", text: "Loose" }, SIZE);
    const { session, store, view, edits } = deck("a", [{ ...loose, own: undefined }]);
    await duplicateShape(session, store, view.slides[0], { ...loose, own: undefined });
    expect(edits()).toEqual([[{ op: "copy", slide: 3, shape: 7 }]]);
  });
});

describe("a shape copied and pasted", () => {
  it("holds the shape for this window, its words on the clipboard; a later copy of anything else wins", () => {
    const a = deck("a");
    const clip = board();
    copyShape(clip, { env: "local", itemId: "a", host: a.host, slideId: 3, slideKey: "3", shapeId: 4, box: TAG.own!.box }, TAG);
    expect(clip.getData("text/plain")).toBe("Up 25%");
    expect(heldShape(clip)?.shapeId).toBe(4);
    // Words copied from elsewhere since: the clipboard's mark is not this window's shape.
    const other = board();
    other.setData("text/plain", "Up 25%");
    expect(heldShape(other)).toBeNull();
  });

  it("lies over its first on the slide it came from, a step on each time; on another slide in its own place first", () => {
    const at = { env: "local", itemId: "a", slideKey: "3", box: [100, 200, 300, 400] as [number, number, number, number], pasted: new Map<string, number>() };
    expect(pasteBox(at, { env: "local", itemId: "a", slideKey: "3" })).toEqual([100 + COPY_STEP, 200 + COPY_STEP, 300, 400]);
    expect(pasteBox(at, { env: "local", itemId: "a", slideKey: "5" })).toEqual([100, 200, 300, 400]);
    at.pasted.set("local\na\n5", 1);
    expect(pasteBox(at, { env: "local", itemId: "a", slideKey: "5" })).toEqual([100 + COPY_STEP, 200 + COPY_STEP, 300, 400]);
    expect(pasteBox(at, { env: "box", itemId: "b", slideKey: "3" })).toEqual([100, 200, 300, 400]);
  });

  it("within a deck names the shape; in another deck brings the slide it lies on from its own host, then copies the shape onto his slide", async () => {
    const a = deck("a");
    const clip = board();
    const held = copyShape(clip, { env: "local", itemId: "a", host: a.host, slideId: 3, slideKey: "3", shapeId: 4, box: TAG.own!.box }, TAG);
    await pasteShape(held, { env: "local", itemId: "a", host: a.host, session: a.session, store: a.store, slide: a.view.slides[1], size: SIZE });
    expect(a.edits()).toEqual([[{ op: "copy", slide: 3, shape: 4, to: 5, box: TAG.own!.box }]]);
    expect(a.host.calls.some(([name]) => name === "clip")).toBe(false);
    // Another deck, on another host.
    const b = deck("b", []);
    await pasteShape(held, { env: "box", itemId: "b", host: b.host, session: b.session, store: b.store, slide: b.view.slides[0], size: SIZE });
    expect(a.host.calls.filter(([name]) => name === "clip")).toEqual([["clip", { slide: 3, offset: 0 }]]);
    expect(b.host.calls.filter(([name]) => name === "attach")).toEqual([["attach", { name: "Pasted shape.pptx", size: 10 }]]);
    expect(b.edits()).toEqual([[{ op: "copy", slide: 3, shape: 4, to: 3, file: "token:Pasted shape.pptx", box: TAG.own!.box }]]);
    expect(b.session.get().picked?.slideKey).toBe("3");
    expect(b.session.get().adding).toBeNull();
  });
});
