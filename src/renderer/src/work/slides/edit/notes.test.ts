import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeckStore } from "../deck";
import { deckView, fakeDeckHost, slide } from "../testkit";
import { savingNow } from "../../canvas/calm";
import { HandSession, TYPING_SAVE_MS, unsavedOf } from "./session";

vi.mock("../../canvas/frame", () => ({ sayError: () => undefined }));

/** His notes typed in the field under the stage (docs/agents/work-slides.md "Notes he types"). */
function setUp(notes = "Say hello") {
  const view = deckView({ slides: [slide(3, { notes }), slide(5)], hand: { undo: false, redo: false } });
  const host = fakeDeckHost(view);
  const store = new DeckStore();
  store.view(view);
  const session = new HandSession(host, store);
  const edits = () => host.calls.filter(([name]) => name === "edit").map(([, ops]) => ops);
  const line = () => session.saved(() => undefined).state;
  return { host, store, session, edits, line };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("notes he types", () => {
  it("go as one notes edit after a 2 s pause, naming the notes they began from; the line says saving until the host has them", async () => {
    const { session, edits, line, store } = setUp();
    session.typeNotes(3, "Say hello,", "Say hello");
    expect(line()).toBe("saving");
    await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS - 100);
    session.typeNotes(3, "Say hello, then the plan", "Say hello");
    await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS - 100);
    expect(edits()).toEqual([]);
    expect(line()).toBe("saving");
    await vi.advanceTimersByTimeAsync(200);
    expect(edits()).toEqual([[{ op: "notes", slide: 3, text: "Say hello, then the plan", was: "Say hello" }]]);
    await vi.waitFor(() => expect(line()).toBe("saved"));
    expect(store.get().view!.slides[0].notes).toBe("Say hello, then the plan");
    expect(session.notesPending(3)).toBe(false);
  });

  it("inside the 2 s pause keep the last Saved line: nothing is on its way until the pause sends them", async () => {
    const { session, edits } = setUp();
    const saving = () => savingNow(unsavedOf(session.get()), Date.now()).saving;
    session.typeNotes(3, "Say hello,", "Say hello");
    await vi.advanceTimersByTimeAsync(1500);
    session.typeNotes(3, "Say hello, then", "Say hello");
    await vi.advanceTimersByTimeAsync(1500);
    expect(edits()).toEqual([]);
    expect(unsavedOf(session.get()).sent).toBeNull();
    expect(saving()).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(edits()).toHaveLength(1);
    await vi.waitFor(() => expect(unsavedOf(session.get())).toMatchObject({ edited: null, sent: null }));
  });

  it("leaving the field sends them at once; the next keep is written over what the last one wrote; nothing typed sends nothing", async () => {
    const { session, edits } = setUp();
    session.typeNotes(3, "One", "Say hello");
    await session.keepNotes();
    session.typeNotes(3, "One, two", "Say hello");
    await session.keepNotes();
    expect(edits()).toEqual([[{ op: "notes", slide: 3, text: "One", was: "Say hello" }], [{ op: "notes", slide: 3, text: "One, two", was: "One" }]]);
    session.typeNotes(3, "One, two", "Say hello");
    await session.keepNotes();
    expect(edits()).toHaveLength(2);
  });

  it("another slide's notes go first when he types on the next slide's", async () => {
    const { session, edits } = setUp();
    session.typeNotes(3, "Three", "Say hello");
    session.typeNotes(5, "Five", "");
    await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
    await session.keepNotes();
    expect(edits()).toEqual([[{ op: "notes", slide: 3, text: "Three", was: "Say hello" }], [{ op: "notes", slide: 5, text: "Five", was: "" }]]);
  });

  it("refused (changed elsewhere), his words stay his; a close sends them once more over the notes as they are now", async () => {
    const { host, session, edits, store } = setUp();
    host.refuse = "The deck changed while this was being made. Nothing was written; look at it again.";
    store.view({ ...store.get().view!, slides: store.get().view!.slides.map((s) => (s.id === 3 ? { ...s, notes: "Changed in PowerPoint" } : s)) });
    session.typeNotes(3, "Mine", "Say hello");
    expect(await session.keepNotes()).toBe(false);
    expect(session.notesPending(3)).toBe(true);
    host.refuse = undefined;
    await session.flush();
    expect(edits().at(-1)).toEqual([{ op: "notes", slide: 3, text: "Mine", was: "Changed in PowerPoint" }]);
    expect(session.notesPending(3)).toBe(false);
  });

  it("a close waits for them, and stays open when the host will not take them", async () => {
    const { host, session } = setUp();
    session.typeNotes(3, "Mine", "Say hello");
    host.refuse = "No room";
    await expect(session.flush()).rejects.toThrow("Your notes are not in the file yet");
  });
});
