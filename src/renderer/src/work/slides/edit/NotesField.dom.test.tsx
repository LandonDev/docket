// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeckStore } from "../deck";
import { deckView, fakeDeckHost, slide } from "../testkit";
import { NotesField } from "./NotesField";
import { HandSession } from "./session";

vi.mock("../../canvas/frame", () => ({ sayError: () => undefined }));

/** The notes field drawn again, the stage back on a slide (docs/agents/work-slides.md "Notes he types"). */
afterEach(cleanup);

describe("the notes field drawn again", () => {
  it("shows his words still on their way, never the deck's older notes, and his next key goes over his own words", async () => {
    const view = deckView({ slides: [slide(3, { notes: "Say hello" })], hand: { undo: false, redo: false } });
    const host = fakeDeckHost(view);
    const store = new DeckStore();
    store.view(view);
    const session = new HandSession(host, store);
    let land!: () => void;
    host.hold = new Promise<void>((r) => (land = r));
    const first = render(<NotesField slide={view.slides[0]} session={session} />);
    const field = () => first.container.ownerDocument.querySelector<HTMLTextAreaElement>("[data-slide-notes-field]")!;
    fireEvent.change(field(), { target: { value: "Say hello, then the plan" } });
    fireEvent.blur(field());
    // The stage leaves the slide and comes back before the send answers: the deck still says the old notes.
    first.unmount();
    render(<NotesField slide={view.slides[0]} session={session} />);
    expect(field().value).toBe("Say hello, then the plan");
    fireEvent.change(field(), { target: { value: "Say hello, then the plan, then thanks" } });
    land();
    await session.keepNotes();
    const edits = host.calls.filter(([name]) => name === "edit").map(([, ops]) => ops);
    expect(edits.at(-1)).toEqual([{ op: "notes", slide: 3, text: "Say hello, then the plan, then thanks", was: "Say hello, then the plan" }]);
  });

  it("shows a line break inside a paragraph as a line, and sends it back as one", async () => {
    const view = deckView({ slides: [slide(3, { notes: "Thank the sponsors\vDoors open at six" })], hand: { undo: false, redo: false } });
    const host = fakeDeckHost(view);
    const store = new DeckStore();
    store.view(view);
    const session = new HandSession(host, store);
    const { container } = render(<NotesField slide={view.slides[0]} session={session} />);
    const field = () => container.querySelector<HTMLTextAreaElement>("[data-slide-notes-field]")!;
    expect(field().value).toBe("Thank the sponsors\nDoors open at six");
    fireEvent.change(field(), { target: { value: "Thank the sponsors\nDoors open at six sharp" } });
    await session.keepNotes();
    const edits = host.calls.filter(([name]) => name === "edit").map(([, ops]) => ops);
    expect(edits.at(-1)).toEqual([{ op: "notes", slide: 3, text: "Thank the sponsors\vDoors open at six sharp", was: "Thank the sponsors\vDoors open at six" }]);
  });

  it("makes Return's paragraph on the side of a break the caret was on", async () => {
    // Council r5 (Sol 5): Return just before a break wrote the paragraph after it.
    const view = deckView({ slides: [slide(3, { notes: "first\vsecond" })], hand: { undo: false, redo: false } });
    const host = fakeDeckHost(view);
    const store = new DeckStore();
    store.view(view);
    const session = new HandSession(host, store);
    const { container } = render(<NotesField slide={view.slides[0]} session={session} />);
    const field = () => container.querySelector<HTMLTextAreaElement>("[data-slide-notes-field]")!;
    fireEvent.change(field(), { target: { value: "first\n\nsecond", selectionStart: 6, selectionEnd: 6 } });
    await session.keepNotes();
    const edits = host.calls.filter(([name]) => name === "edit").map(([, ops]) => ops);
    expect(edits.at(-1)).toEqual([{ op: "notes", slide: 3, text: "first\n\vsecond", was: "first\vsecond" }]);
  });

  it("takes the deck's notes again on Reload over notes changed elsewhere", async () => {
    const view = deckView({ slides: [slide(3, { notes: "Say hello" })], hand: { undo: false, redo: false } });
    const host = fakeDeckHost(view);
    const store = new DeckStore();
    store.view(view);
    const session = new HandSession(host, store);
    host.refuse = "The deck changed while this was being made. Nothing was written; look at it again.";
    const changed = { ...view, slides: view.slides.map((s) => ({ ...s, notes: "Changed in PowerPoint" })) };
    host.view = changed;
    const { rerender, container } = render(<NotesField slide={view.slides[0]} session={session} />);
    const field = () => container.querySelector<HTMLTextAreaElement>("[data-slide-notes-field]")!;
    fireEvent.change(field(), { target: { value: "Mine" } });
    await act(async () => void (await session.keepNotes()));
    host.refuse = null;
    // The deck's notes changed in the view meanwhile: his words stay in the field.
    rerender(<NotesField slide={changed.slides[0]} session={session} />);
    expect(field().value).toBe("Mine");
    await act(async () => session.saved(() => undefined).actions!.find((a) => a.id === "reload")!.run());
    await waitFor(() => expect(field().value).toBe("Changed in PowerPoint"));
  });
});
