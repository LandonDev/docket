import { describe, expect, it, vi } from "vitest";
import { DeckStore } from "../deck";
import { deckView, fakeDeckHost, slide, textShape } from "../testkit";
import { deleteRange, insertText } from "./model";
import { HandSession, TYPING_SAVE_MS } from "./session";

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

  it("reads theme colours back as hex after format and run edits", async () => {
    const { host, slide, shape } = setUp();
    const formatted = await host.edit([{ op: "format", slide: slide.id, shape: shape.id, set: { color: { slot: "tx1" } } }]);
    expect(formatted.slides[0].shapes[0].paragraphs?.[0].runs[0].color).toBe("000000");
    const typed = await host.edit([{
      op: "runs",
      slide: slide.id,
      shape: shape.id,
      paragraphs: [{ runs: [{ text: "New title", color: { slot: "accent1" } }] }],
    }]);
    expect(typed.slides[0].shapes[0].paragraphs?.[0].runs[0].color).toBe("4472C4");
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

describe("words in an open box reach the file while he types", () => {
  it("sends them after a pause with the box left open, and never says saved while they wait", async () => {
    vi.useFakeTimers();
    try {
      const { host, session, slide, shape } = setUp();
      session.open(slide, shape, "end");
      expect(session.saved(() => undefined).state).toBe("saved");
      type(session, " today");
      expect(session.saved(() => undefined).state).toBe("saving");
      expect(host.calls.filter(([name]) => name === "edit")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
      expect(host.calls.filter(([name]) => name === "edit")).toHaveLength(1);
      expect(session.get().box?.phase).toBe("typing");
      expect(session.saved(() => undefined)).toMatchObject({ state: "saved" });
      // Nothing more typed: leaving the box sends nothing again.
      await session.commit();
      expect(host.calls.filter(([name]) => name === "edit")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("each new word moves the pause on, and Escape puts back only what was typed since the last send", async () => {
    vi.useFakeTimers();
    try {
      const { host, session, slide, shape } = setUp();
      session.open(slide, shape, "end");
      type(session, " to");
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS - 500);
      type(session, "day");
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS - 500);
      expect(host.calls.filter(([name]) => name === "edit")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(500);
      const edits = host.calls.filter(([name]) => name === "edit");
      expect(edits).toHaveLength(1);
      expect(JSON.stringify(edits[0]![1])).toContain("Who comes today");
      type(session, "!");
      session.cancel();
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
      expect(host.calls.filter(([name]) => name === "edit")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("each send of a box names the runs its words lie in now", () => {
  const AGENDA = textShape(2, [
    { level: 0, align: "left", list: "none", runs: [{ text: "Agenda", size: 28 }] },
    { level: 1, align: "left", list: "bullet", runs: [{ text: "Budget", size: 20 }] },
  ]);
  function deck(shape = AGENDA) {
    const view = deckView({ slides: [slide(3, { shapes: [shape] })], hand: { undo: false, redo: false } });
    const host = fakeDeckHost(view);
    const store = new DeckStore();
    store.view(view);
    return { host, store, session: new HandSession(host, store), slide: view.slides[0], shape };
  }
  /** He types at a place in the words. */
  function typeAt(session: HandSession, at: [number, number], text: string): void {
    const { model, at: end } = insertText(session.get().box!.model, { from: at, to: at }, text);
    session.typed(model, { from: end, to: end });
  }
  const lastRuns = (host: ReturnType<typeof deck>["host"]) => {
    const ops = host.calls.filter(([name]) => name === "edit").at(-1)![1] as Array<{ op: string; paragraphs: Array<{ from?: number; runs: Array<{ text: string; from?: [number, number]; bold?: boolean }> }>; was?: string[][] }>;
    return ops[0];
  };

  it("a paragraph made with Return and kept moves the ones after it: the next send names them where they are now", async () => {
    vi.useFakeTimers();
    try {
      const { host, session, slide: s, shape } = deck();
      session.open(s, shape, "end");
      session.select({ from: [0, 6], to: [0, 6] });
      session.enter();
      typeAt(session, [1, 0], "Hiring");
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
      expect(host.view.slides[0].shapes[0].paragraphs!.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["Agenda", "Hiring", "Budget"]);
      typeAt(session, [2, 6], " review");
      await session.commit();
      const op = lastRuns(host);
      // "Budget" is the file's third paragraph now: its level, bullet and look come from there, never from "Hiring".
      expect(op.paragraphs[2]).toMatchObject({ from: 2, runs: [{ text: "Budget review", from: [2, 0] }] });
      expect(op.was).toEqual([["Agenda"], ["Hiring"], ["Budget"]]);
      expect(host.view.slides[0].shapes[0].paragraphs![2]).toMatchObject({ level: 1, list: "bullet", runs: [{ text: "Budget review", size: 20 }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("half a run made bold and kept: words typed in the plain half stay plain", async () => {
    vi.useFakeTimers();
    try {
      const plain = textShape(2, [{ level: 0, align: "left", list: "none", runs: [{ text: "Hello world", size: 24 }] }]);
      const { host, session, slide: s } = deck(plain);
      session.open(s, plain, "end");
      session.select({ from: [0, 0], to: [0, 5] });
      session.look({ bold: true });
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
      expect(host.view.slides[0].shapes[0].paragraphs![0].runs.map((r) => [r.text, !!r.bold])).toEqual([["Hello", true], [" world", false]]);
      typeAt(session, [0, 11], "!");
      // Undo after a send is a change of its own, sent after its pause too.
      session.undo();
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
      expect(host.calls.filter(([name]) => name === "edit")).toHaveLength(1);
      session.redo();
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
      const op = lastRuns(host);
      expect(op.paragraphs[0].runs).toEqual([{ text: "Hello", from: [0, 0], bold: true }, { text: " world!", from: [0, 1] }]);
      expect(host.view.slides[0].shapes[0].paragraphs![0].runs.map((r) => [r.text, !!r.bold])).toEqual([["Hello", true], [" world!", false]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("words taken out, kept, then brought back with the box's Undo keep their look: a bold run and a bulleted paragraph", async () => {
    vi.useFakeTimers();
    try {
      const mixed = textShape(2, [
        { level: 0, align: "left", list: "none", runs: [{ text: "Hello ", size: 24 }, { text: "World", size: 24, bold: true }] },
        { level: 1, align: "left", list: "bullet", runs: [{ text: "Budget", size: 20 }] },
      ]);
      const { host, session, slide: s } = deck(mixed);
      session.open(s, mixed, "end");
      // "World" and the bulleted "Budget" go; the 2 s save writes "Hello " alone.
      const { model, at } = deleteRange(session.get().box!.model, { from: [0, 6], to: [1, 6] });
      session.typed(model, { from: at, to: at });
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
      expect(host.view.slides[0].shapes[0].paragraphs!.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["Hello "]);
      // ⌘Z in the box brings them back; the next send names no run of the file for them, so it sets their look.
      session.undo();
      await session.commit();
      const op = lastRuns(host) as unknown as { paragraphs: Array<{ level?: number; list?: string; runs: Array<{ text: string; bold?: boolean; size?: number }> }> };
      expect(op.paragraphs[0].runs[1]).toMatchObject({ text: "World", bold: true, size: 24 });
      expect(op.paragraphs[1]).toMatchObject({ level: 1, list: "bullet" });
      const written = host.view.slides[0].shapes[0].paragraphs!;
      expect(written[0].runs.map((r) => [r.text, !!r.bold])).toEqual([["Hello ", false], ["World", true]]);
      expect([written[1].level, written[1].list]).toEqual([1, "bullet"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a close waits for the send on its way, and is refused with the host's word when the words did not go in", async () => {
    const { host, session, slide: s, shape } = deck();
    session.open(s, shape, "end");
    typeAt(session, [1, 6], "!");
    let release!: () => void;
    host.hold = new Promise<void>((done) => (release = done));
    host.refuse = "The disk is full";
    const leaving = session.commit();
    const closing = session.flush();
    release();
    await leaving;
    await expect(closing).rejects.toThrow("The disk is full");
    expect(session.get().box).toMatchObject({ phase: "typing" });
    expect(session.get().box!.model[1].runs.map((r) => r.text).join("")).toBe("Budget!");
    // Once the host takes them, the close goes ahead.
    host.hold = null;
    host.refuse = null;
    await expect(session.flush()).resolves.toBeUndefined();
    expect(session.get().box?.phase ?? null).not.toBe("typing");
  });
});

describe("a close while the box's words are on their way", () => {
  function deck() {
    const view = deckView({ slides: [slide(3, { shapes: [TITLE] })], hand: { undo: false, redo: false } });
    const host = fakeDeckHost(view);
    const store = new DeckStore();
    store.view(view);
    return { host, store, session: new HandSession(host, store), slide: view.slides[0], shape: view.slides[0].shapes[0] };
  }
  /** Each edit waits until the test lets it go; the edits sent so far. */
  function held(host: ReturnType<typeof deck>["host"]) {
    const gates: Array<() => void> = [];
    const edit = host.edit.bind(host);
    host.edit = async (ops) => {
      await new Promise<void>((go) => gates.push(go));
      return edit(ops);
    };
    return { gates };
  }
  const sentEdits = (host: ReturnType<typeof deck>["host"]) => host.calls.filter(([name]) => name === "edit");
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it("a keep on its way, then a press away and the close together: the close settles once the words are in, with one write", async () => {
    vi.useFakeTimers();
    try {
      const { host, session, slide: s, shape } = deck();
      const { gates } = held(host);
      session.open(s, shape, "end");
      type(session, " today");
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
      expect(gates).toHaveLength(1);
      // He presses away (the tab's More), then closes the tab while the keep is still on its way.
      const away = session.commit();
      let closed = false;
      const closing = session.flush().then(() => void (closed = true));
      await settle();
      expect(closed).toBe(false);
      gates.shift()!();
      await away;
      await closing;
      expect(closed).toBe(true);
      expect(sentEdits(host)).toHaveLength(1);
      expect(session.get().box?.phase ?? null).not.toBe("typing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("words typed while a keep is on its way: the close waits for both writes, and settles only once the second is in", async () => {
    vi.useFakeTimers();
    try {
      const { host, session, slide: s, shape } = deck();
      const { gates } = held(host);
      session.open(s, shape, "end");
      type(session, " today");
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
      type(session, "!");
      const away = session.commit();
      let closed = false;
      const closing = session.flush().then(() => void (closed = true));
      gates.shift()!();
      await settle();
      // The keep is in; the box's own words are not yet: the close still waits.
      expect(closed).toBe(false);
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      expect(closed).toBe(false);
      gates.shift()!();
      await away;
      await closing;
      expect(sentEdits(host)).toHaveLength(2);
      expect(host.view.slides[0].shapes[0].paragraphs![0].runs.map((r) => r.text).join("")).toBe("Who comes today!");
      expect(session.get().box?.phase ?? null).not.toBe("typing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a press away and the close at once: the close waits for the commit's write, never passing it while it is queued", async () => {
    const { host, session, slide: s, shape } = deck();
    const { gates } = held(host);
    session.open(s, shape, "end");
    type(session, " today");
    const away = session.commit();
    let closed = false;
    const closing = session.flush().then(() => void (closed = true));
    await settle();
    expect(closed).toBe(false);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(closed).toBe(false);
    gates.shift()!();
    await away;
    await closing;
    expect(sentEdits(host)).toHaveLength(1);
    expect(session.get().box?.phase ?? null).not.toBe("typing");
  });

  it("a close whose words are still in this window when its wait runs out keeps the tab, and the words go in after", async () => {
    vi.useFakeTimers();
    try {
      const { host, session, slide: s, shape } = deck();
      const { gates } = held(host);
      session.open(s, shape, "end");
      type(session, " today");
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
      // A slow keep; words typed meanwhile wait behind it, in this window.
      type(session, "!");
      const closing = session.flush();
      const refused = expect(closing).rejects.toThrow("The words in the open box are not saved yet");
      await vi.advanceTimersByTimeAsync(7600);
      await refused;
      expect(session.get().box!.model[0].runs.map((r) => r.text).join("")).toBe("Who comes today!");
      // The keep lands, then the box's own words: nothing is lost.
      gates.shift()!();
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      gates.shift()!();
      await vi.waitFor(() => expect(host.view.slides[0].shapes[0].paragraphs![0].runs.map((r) => r.text).join("")).toBe("Who comes today!"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("no box opens over words not saved yet: a conflict that waits for Reload keeps its box", async () => {
    const { host, session, slide: s, shape, store } = deck();
    session.open(s, shape, "end");
    type(session, " today");
    host.view = { ...host.view, slides: [{ ...s, shapes: [textShape(2, [{ level: 0, align: "left", list: "none", runs: [{ text: "Who goes", size: 40 }] }])] }] };
    store.view(host.view);
    await session.commit();
    expect(session.get().failure?.conflict).toBe(true);
    const other = store.get().view!.slides[0].shapes[0];
    expect(session.open(store.get().view!.slides[0], other, "all")).toBe(false);
    expect(session.get().box!.model[0].runs.map((r) => r.text).join("")).toBe("Who comes today");
    // Escape puts his words back; then a box opens.
    session.cancel();
    expect(session.open(store.get().view!.slides[0], other, "all")).toBe(true);
  });

  it("after a keep the box opened on what was written: a press away and the close send nothing more and settle at once", async () => {
    vi.useFakeTimers();
    try {
      const { host, session, slide: s, shape } = deck();
      session.open(s, shape, "end");
      type(session, " today");
      await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
      const box = session.get().box!;
      expect(box.phase).toBe("typing");
      expect(JSON.stringify(box.initial)).toBe(JSON.stringify(box.model));
      expect(session.saved(() => undefined).state).toBe("saved");
      void session.commit();
      await session.flush();
      expect(sentEdits(host)).toHaveLength(1);
      expect(session.get().box).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
