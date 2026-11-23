import { describe, expect, it, vi } from "vitest";
import { DeckStore } from "../deck";
import { deckView, fakeDeckHost, slide, textShape } from "../testkit";
import { insertText } from "./model";
import { HandSession } from "./session";

vi.mock("../../canvas/frame", () => ({ sayError: () => undefined }));

const TITLE = textShape(2, [{ level: 0, align: "left", list: "none", runs: [{ text: "Who comes", size: 40 }] }]);

function setUp() {
  const view = deckView({ slides: [slide(3, { shapes: [TITLE] })], hand: { undo: false, redo: false } });
  const host = fakeDeckHost(view);
  const store = new DeckStore();
  store.view(view);
  const session = new HandSession(host, store);
  const deck = store.get().view!;
  return { host, store, session, slide: deck.slides[0], shape: deck.slides[0].shapes[0] };
}

/** He types at the end of the words. */
function type(session: HandSession, text: string): void {
  const box = session.get().box!;
  const end = box.sel.to;
  const { model, at } = insertText(box.model, { from: end, to: end }, text);
  session.typed(model, { from: at, to: at });
}

describe("his hand on a deck", () => {
  it("keeps the box until the stage paints a picture of another revision than the one it opened over", async () => {
    const { session, slide, shape } = setUp();
    expect(session.open(slide, shape, "end")).toBe(true);
    type(session, " today");
    await session.commit();
    expect(session.get().box?.phase).toBe("landing");
    expect(session.get().savedAt).not.toBeNull();
    session.painted(slide.key, "f1");
    expect(session.get().box).not.toBeNull();
    session.painted(slide.key, "f1+");
    expect(session.get().box).toBeNull();
  });

  it("opens no box while his last words are on their way, and none on a deck he cannot edit by hand", async () => {
    const { host, session, slide, shape, store } = setUp();
    let write!: () => void;
    host.hold = new Promise<void>((done) => (write = done));
    session.open(slide, shape, "end");
    type(session, "!");
    const sending = session.commit();
    expect(session.get().box?.phase).toBe("saving");
    expect(session.open(slide, shape, "all")).toBe(false);
    write();
    await sending;
    store.view({ ...store.get().view!, hand: undefined });
    session.cancel();
    expect(session.open(slide, store.get().view!.slides[0].shapes[0], "end")).toBe(false);
  });

  it("calls words over changed words a conflict and sends nothing until Reload keeps them over the new ones", async () => {
    const { host, session, slide, shape, store } = setUp();
    session.open(slide, shape, "end");
    type(session, "!");
    const moved = textShape(2, [{ level: 0, align: "left", list: "none", runs: [{ text: "Who goes", size: 40 }] }]);
    host.view = { ...host.view, slides: [{ ...slide, shapes: [moved] }] };
    store.view(host.view);
    await session.commit();
    expect(session.get().failure).toEqual({ conflict: true, message: "The deck changed while you typed" });
    expect(host.calls.some(([name]) => name === "edit")).toBe(false);
    expect(session.saved(() => undefined)).toMatchObject({ state: "conflict" });
    await session.reload();
    expect(session.get().failure).toBeNull();
    await session.commit();
    expect(host.calls.filter(([name]) => name === "edit")).toHaveLength(1);
  });

  it("walks the box's own undo and redo, a typing burst one step", () => {
    const { session, slide, shape } = setUp();
    session.open(slide, shape, "end");
    type(session, "a");
    type(session, "b");
    session.look({ bold: true });
    expect(session.get().undo).toBe(true);
    session.undo();
    session.undo();
    expect(session.get().box!.model[0].runs.map((r) => r.text).join("")).toBe("Who comes");
    expect(session.get().redo).toBe(true);
    session.redo();
    expect(session.get().box!.model[0].runs.map((r) => r.text).join("")).toBe("Who comesab");
    session.cancel();
    expect(session.get().box).toBeNull();
  });
});
