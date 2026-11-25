// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
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
});
