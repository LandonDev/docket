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

  it("refused because they changed elsewhere: Replace and Reload in the line, and neither a close nor another key writes over the other save", async () => {
    const { host, session, edits, store } = setUp();
    host.refuse = "The deck changed while this was being made. Nothing was written; look at it again.";
    store.view({ ...store.get().view!, slides: store.get().view!.slides.map((s) => (s.id === 3 ? { ...s, notes: "Changed in PowerPoint" } : s)) });
    session.typeNotes(3, "Mine", "Say hello");
    expect(await session.keepNotes()).toBe(false);
    host.refuse = undefined;
    const line = session.saved(() => undefined);
    expect(line).toMatchObject({ state: "conflict", detail: "The deck changed while you typed", actions: [{ id: "replace", label: "Replace" }, { id: "reload", label: "Reload" }] });
    // A close is refused, with his words kept; another key keeps them his and sends nothing.
    await expect(session.flush()).rejects.toThrow("Your notes changed elsewhere");
    session.typeNotes(3, "Mine, more", "Say hello");
    await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS * 2);
    expect(edits()).toHaveLength(1);
    expect(session.pendingNotes(3)).toBe("Mine, more");
    expect(session.saved(() => undefined).state).toBe("conflict");
    // Replace writes them over the notes as they are now, the other save kept in the deck's versions.
    session.saved(() => undefined).actions!.find((a) => a.id === "replace")!.run();
    await vi.waitFor(() => expect(edits().at(-1)).toEqual([{ op: "notes", slide: 3, text: "Mine, more", was: "Changed in PowerPoint" }]));
    await vi.waitFor(() => expect(session.notesPending(3)).toBe(false));
  });

  it("Reload drops his words for the notes as they are now, and sends nothing", async () => {
    const { host, session, edits, store } = setUp();
    host.refuse = "The deck changed while this was being made. Nothing was written; look at it again.";
    store.view({ ...store.get().view!, slides: store.get().view!.slides.map((s) => (s.id === 3 ? { ...s, notes: "Changed in PowerPoint" } : s)) });
    session.typeNotes(3, "Mine", "Say hello");
    await session.keepNotes();
    host.refuse = undefined;
    const reloads = session.get().notesReload ?? 0;
    session.saved(() => undefined).actions!.find((a) => a.id === "reload")!.run();
    await vi.waitFor(() => expect(session.notesPending(3)).toBe(false));
    expect(session.pendingNotes(3)).toBeNull();
    expect(session.get().notesReload).toBe(reloads + 1);
    expect(session.saved(() => undefined).state).toBe("saved");
    await session.flush();
    expect(edits()).toHaveLength(1);
  });

  it("refused on one slide stay that slide's when he types in another's: the field, the line and Retry keep them", async () => {
    const { host, session, edits } = setUp();
    host.refuse = "No room";
    session.typeNotes(3, "Thank the sponsors", "Say hello");
    expect(await session.keepNotes()).toBe(false);
    host.refuse = undefined;
    session.typeNotes(5, "Five", "");
    expect(session.pendingNotes(3)).toBe("Thank the sponsors");
    expect(session.saved(() => undefined)).toMatchObject({ state: "conflict", detail: "Not saved. No room.", actions: [{ id: "retry" }] });
    // His key on slide 5 cleared only slide 5's: Retry sends slide 3's, and slide 5's go with the pause.
    session.saved(() => undefined).actions![0].run();
    await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
    await vi.waitFor(() => expect(session.saved(() => undefined).state).toBe("saved"));
    expect(edits().slice(1)).toEqual(expect.arrayContaining([[{ op: "notes", slide: 3, text: "Thank the sponsors", was: "Say hello" }], [{ op: "notes", slide: 5, text: "Five", was: "" }]]));
    expect(session.notesPending(3)).toBe(false);
  });

  it("a close waits for them, and stays open when the host will not take them", async () => {
    const { host, session } = setUp();
    session.typeNotes(3, "Mine", "Say hello");
    host.refuse = "No room";
    await expect(session.flush()).rejects.toThrow("Your notes are not in the file yet");
  });
});
