import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftStore } from "../../../../../main/drafts";
import { DraftJournal, type DraftsPort } from "../../canvas/drafts";
import { DeckStore } from "../deck";
import { deckView, fakeDeckHost, slide, textShape } from "../testkit";
import { insertText } from "./model";
import { HandSession } from "./session";

vi.mock("../../canvas/frame", () => ({ sayError: () => undefined }));

/**
 * A deck's open box survives a crash (docs/agents/work-files.md "Drafts survive a crash"): its words kept on this
 * computer by the shape they are on, offered as the deck opens, sent by Restore as the box's commit sends them, and
 * never written over a shape whose words changed since.
 */

const TITLE = textShape(2, [{ level: 0, align: "left", list: "none", runs: [{ text: "Who comes", size: 40 }] }]);
const AT = new Date(new Date().setHours(14, 30, 0, 0)).getTime();
const place = { workspaceId: "w1", holder: "box", file: '{"at":"file","host":"box","path":"/w/Deck.pptx"}' };

const dirs: string[] = [];
const stores: DraftStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.settled()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function store(dir = (dirs.push(mkdtempSync(join(tmpdir(), "tc-drafts-"))), join(dirs.at(-1)!, "drafts")), window = 1) {
  const s = new DraftStore(dir);
  stores.push(s);
  const port: DraftsPort = { put: (d) => s.put(d, window), drop: (k) => s.drop(k), release: (k) => s.release(k), list: (k) => s.list(k) };
  return { s, dir, journal: new DraftJournal(port, { ...place, name: "Deck.pptx" }, () => AT), kept: async () => (s.releaseOwner(window), s.list(place)) };
}

function deck(shape = TITLE) {
  const view = deckView({ slides: [slide(3, { shapes: [shape] })], hand: { undo: false, redo: false } });
  const host = fakeDeckHost(view);
  const decks = new DeckStore();
  decks.view(view);
  return { host, decks };
}

/** He opens the title's box and types at the end of its words, with no commit. */
async function typedAndKilled() {
  const before = store();
  const { host, decks } = deck();
  const session = new HandSession(host, decks);
  session.journalTo(before.journal);
  const v = decks.get().view!;
  session.open(v.slides[0], v.slides[0].shapes[0], "end");
  const box = session.get().box!;
  const { model, at } = insertText(box.model, { from: box.sel.to, to: box.sel.to }, " today");
  session.typed(model, { from: at, to: at });
  await before.s.settled();
  return { ...before, session };
}

describe("a deck's open box", () => {
  it("is kept on this computer while its words are not written, by the shape it is on, and goes once they are", async () => {
    const before = await typedAndKilled();
    const [kept] = await before.kept();
    expect(kept).toMatchObject({ base: "3:2", body: { kind: "deck", slideId: 3, shapeId: 2, words: [["Who comes"]] } });
    await before.session.commit();
    await before.s.settled();
    expect(await before.kept()).toEqual([]);
  });

  it("is offered after the app went with no word, and Restore sends its words as the box's commit does", async () => {
    const before = await typedAndKilled();
    const after = store(before.dir, 2);
    const { host, decks } = deck();
    const session = new HandSession(host, decks);
    session.journalTo(after.journal);
    await vi.waitFor(() => expect(session.get().offer).toEqual({ at: AT, same: true, text: "Who comes today" }));
    expect(session.saved(() => undefined)).toMatchObject({ state: "conflict", detail: "Edits from 2:30 PM were not saved" });
    // No box opens over the offer.
    const v = decks.get().view!;
    expect(session.open(v.slides[0], v.slides[0].shapes[0], "end")).toBe(false);
    await session.restoreDraft();
    const edits = host.calls.filter(([name]) => name === "edit");
    expect(edits).toHaveLength(1);
    expect(JSON.stringify(edits[0])).toContain("Who comes today");
    expect(session.get().offer).toBeNull();
    await after.s.settled();
    expect(await after.kept()).toEqual([]);
  });

  it("is never written over a shape whose words changed since: Copy Words and Discard, and nothing is sent", async () => {
    const before = await typedAndKilled();
    const after = store(before.dir, 2);
    const { host, decks } = deck(textShape(2, [{ level: 0, align: "left", list: "none", runs: [{ text: "Who goes", size: 40 }] }]));
    const session = new HandSession(host, decks);
    session.journalTo(after.journal);
    await vi.waitFor(() => expect(session.get().offer?.same).toBe(false));
    expect(session.saved(() => undefined)).toMatchObject({ detail: "Edits from 2:30 PM were not saved. The slide changed since", actions: [{ label: "Copy Words" }, { label: "Discard" }] });
    await session.restoreDraft();
    expect(host.calls.filter(([name]) => name === "edit")).toEqual([]);
    session.discardDraft();
    await after.s.settled();
    expect(await after.kept()).toEqual([]);
  });
});
