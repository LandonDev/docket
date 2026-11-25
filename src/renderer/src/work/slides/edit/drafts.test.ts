import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftStore } from "../../../../../main/drafts";
import { DraftJournal, type DraftsPort } from "../../canvas/drafts";
import { DeckStore } from "../deck";
import { boxShape, deckView, fakeDeckHost, slide, textShape } from "../testkit";
import { insertText } from "./model";
import { HandSession } from "./session";

vi.mock("../../canvas/frame", () => ({ sayError: () => undefined }));
const copied = vi.hoisted(() => [] as string[]);
vi.mock("../../../lib/clipboard", () => ({ copyText: async (text: string) => void copied.push(text) }));

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
  await session.lookForDrafts();
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
    expect(kept).toMatchObject({ base: expect.stringMatching(/^3:2:\w+$/), body: { kind: "deck", slideId: 3, shapeId: 2, words: [["Who comes"]] } });
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
    await vi.waitFor(() => expect(session.get().offer).toMatchObject({ at: AT, same: true, text: "Who comes today", where: "Words on slide 3" }));
    expect(session.saved(() => undefined)).toMatchObject({ state: "conflict", detail: "Words on slide 3 from 2:30 PM were not saved" });
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
    expect(session.saved(() => undefined)).toMatchObject({ detail: "Words on slide 3 from 2:30 PM were not saved. The slide changed since", actions: [{ label: "Copy Words" }, { label: "Discard" }] });
    await session.restoreDraft();
    expect(host.calls.filter(([name]) => name === "edit")).toEqual([]);
    session.discardDraft();
    await after.s.settled();
    expect(await after.kept()).toEqual([]);
  });

  it("on a table's cell is kept with its cell, and Restore sends its words to that cell", async () => {
    const table = boxShape(9, [0.1, 0.5, 0.5, 0.9], { kind: "table", cells: [["Team", "Seats"], ["Gold", "12"]] });
    const before = store();
    const first = deck(table);
    const session = new HandSession(first.host, first.decks);
    session.journalTo(before.journal);
    await session.lookForDrafts();
    const v = first.decks.get().view!;
    session.open(v.slides[0], v.slides[0].shapes[0], "end", { row: 1, col: 0 });
    const box = session.get().box!;
    const { model, at } = insertText(box.model, { from: box.sel.to, to: box.sel.to }, " team");
    session.typed(model, { from: at, to: at });
    await before.s.settled();
    const [kept] = await before.kept();
    expect(kept).toMatchObject({ body: { kind: "deck", slideId: 3, shapeId: 9, cell: { row: 1, col: 0 }, words: [["Gold"]] } });
    const after = store(before.dir, 2);
    const { host, decks } = deck(table);
    const again = new HandSession(host, decks);
    again.journalTo(after.journal);
    await vi.waitFor(() => expect(again.get().offer).toMatchObject({ at: AT, same: true, text: "Gold team" }));
    await again.restoreDraft();
    const edits = host.calls.filter(([name]) => name === "edit").map(([, ops]) => ops);
    expect(edits).toEqual([[expect.objectContaining({ op: "runs", shape: 9, row: 1, col: 0 })]]);
  });

  it("of notes he typed is kept at once, goes once the host has them, and a crash in the pause offers them to restore", async () => {
    const before = store();
    const first = deck();
    const session = new HandSession(first.host, first.decks);
    session.journalTo(before.journal);
    session.typeNotes(3, "Thank the sponsors", "");
    await before.s.settled();
    expect((await before.kept()).map((d) => d.body)).toEqual([{ kind: "notes", slideId: 3, text: "Thank the sponsors", was: "" }]);
    // The window goes in the pause: the next open offers them, and Restore sends them over the notes they were typed over.
    const after = store(before.dir, 2);
    const { host, decks } = deck();
    const again = new HandSession(host, decks);
    again.journalTo(after.journal);
    await vi.waitFor(() => expect(again.get().offer).toMatchObject({ at: AT, same: true, text: "Thank the sponsors", where: "Notes on slide 3" }));
    await again.restoreDraft();
    expect(host.calls.filter(([name]) => name === "edit").map(([, ops]) => ops)).toEqual([[{ op: "notes", slide: 3, text: "Thank the sponsors", was: "" }]]);
    await after.s.settled();
    expect(await after.kept()).toEqual([]);
  });

  it("of notes turns to Copy Words once newer notes of that slide save, and Restore sends nothing", async () => {
    // Council r7 (Sol 4): the offer read the deck once, so Restore stayed on screen over notes saved since.
    const before = store();
    const first = deck();
    const session = new HandSession(first.host, first.decks);
    session.journalTo(before.journal);
    session.typeNotes(3, "Thank the sponsors", "");
    await before.s.settled();
    const after = store(before.dir, 2);
    const { host, decks } = deck();
    const again = new HandSession(host, decks);
    again.journalTo(after.journal);
    await vi.waitFor(() => expect(again.get().offer).toMatchObject({ same: true, where: "Notes on slide 3" }));
    // Newer notes of slide 3 save, from this window or another.
    decks.view(await host.edit([{ op: "notes", slide: 3, text: "Thank the hosts", was: "" }]));
    expect(again.get().offer).toMatchObject({ same: false, text: "Thank the sponsors" });
    expect(again.saved(() => undefined)).toMatchObject({ actions: [{ label: "Copy Words" }, { label: "Discard" }] });
    await again.restoreDraft();
    expect(host.calls.filter(([name]) => name === "edit")).toHaveLength(1);
  });

  it("of later notes stay kept when an earlier send of them lands; refused, the line says Not saved with Retry", async () => {
    const before = store();
    const { host, decks } = deck();
    const session = new HandSession(host, decks);
    session.journalTo(before.journal);
    // The first send lands only once the second is on its way; the second is refused after it.
    let land!: () => void;
    const landed = new Promise<void>((r) => (land = r));
    const edit = host.edit.bind(host);
    let sends = 0;
    host.edit = async (ops) => {
      const mine = ++sends;
      await landed;
      if (mine === 1) return edit(ops);
      await new Promise((r) => setTimeout(r, 0));
      throw new Error("No room");
    };
    session.typeNotes(3, "Thank", "");
    const one = session.keepNotes();
    session.typeNotes(3, "Thank the sponsors", "");
    const two = session.keepNotes();
    land();
    expect(await one).toBe(true);
    await before.s.settled();
    expect((await before.kept()).map((d) => d.body)).toEqual([{ kind: "notes", slideId: 3, text: "Thank the sponsors", was: "Thank" }]);
    expect(await two).toBe(false);
    const line = session.saved(() => undefined);
    expect(line).toMatchObject({ state: "conflict", detail: "Not saved. No room.", actions: [{ id: "retry", label: "Retry" }] });
    // Retry sends them over the notes as the deck has them now, and the line is saved again.
    host.edit = edit;
    line.actions![0].run();
    await vi.waitFor(() => expect(session.saved(() => undefined).state).toBe("saved"));
    expect(host.view.slides[0].notes).toBe("Thank the sponsors");
    await before.s.settled();
    expect(await before.kept()).toEqual([]);
  });

  it("of two slides' notes are kept apart: one refused while the other lands stays on this computer", async () => {
    const before = store();
    const view = deckView({ slides: [slide(3), slide(5)], hand: { undo: false, redo: false } });
    const host = fakeDeckHost(view);
    const decks = new DeckStore();
    decks.view(view);
    const session = new HandSession(host, decks);
    session.journalTo(before.journal);
    // Slide 3's send is still out when he types in slide 5's notes; it is refused, and slide 5's lands.
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const edit = host.edit.bind(host);
    host.edit = async (ops) => {
      if (ops[0]?.op === "notes" && ops[0].slide === 3) {
        await answered;
        throw new Error("No room");
      }
      return edit(ops);
    };
    session.typeNotes(3, "Thank the sponsors", "");
    const three = session.keepNotes();
    session.typeNotes(5, "Doors at six", "");
    const five = session.keepNotes();
    answer();
    expect(await three).toBe(false);
    await five;
    expect(host.view.slides[1].notes).toBe("Doors at six");
    await before.s.settled();
    expect((await before.kept()).map((d) => d.body)).toEqual([{ kind: "notes", slideId: 3, text: "Thank the sponsors", was: "" }]);
  });

  it("of two slides' notes are each offered in turn, and his new words never go over one he was not shown", async () => {
    // Council r5 (Sol 1): after Restore of one, the other slide's draft was never offered, and his typing there wrote over it.
    const before = store();
    const view = deckView({ slides: [slide(3), slide(5)], hand: { undo: false, redo: false } });
    const first = fakeDeckHost(view);
    // Neither send answers before the app goes.
    first.edit = () => new Promise(() => undefined);
    const firstDecks = new DeckStore();
    firstDecks.view(view);
    const session = new HandSession(first, firstDecks);
    session.journalTo(before.journal);
    session.typeNotes(3, "Thank the sponsors", "");
    session.typeNotes(5, "Doors at six", "");
    await before.s.settled();
    expect((await before.kept()).map((d) => d.body.kind)).toEqual(["notes", "notes"]);
    const after = store(before.dir, 2);
    const host = fakeDeckHost(view);
    const decks = new DeckStore();
    decks.view(view);
    const again = new HandSession(host, decks);
    again.journalTo(after.journal);
    await vi.waitFor(() => expect(again.get().offer).toBeTruthy());
    const texts = ["Thank the sponsors", "Doors at six"];
    const shown = again.get().offer!.text;
    const other = texts.find((t) => t !== shown)!;
    const otherSlide = other === "Doors at six" ? 5 : 3;
    await again.restoreDraft();
    // The other slide's draft is offered next.
    expect(again.get().offer).toMatchObject({ at: AT, same: true, text: other, where: `Notes on slide ${otherSlide}` });
    // He types in that slide's notes before he answers: the draft he has not answered stays kept, never written over.
    again.typeNotes(otherSlide, "New words", "");
    expect(await again.keepNotes()).toBe(true);
    await after.s.settled();
    expect((await after.kept()).map((d) => d.body)).toEqual([{ kind: "notes", slideId: otherSlide, text: other, was: "" }]);
    expect(again.get().offer).toMatchObject({ text: other });
    again.discardDraft();
    expect(again.get().offer).toBeNull();
    await after.s.settled();
    expect(await after.kept()).toEqual([]);
  });

  it("opens no box while the first look for kept drafts is out, and his new words never take a kept draft's slot", async () => {
    // Council r6 (Sol 2): typed in the same shape before the lookup answered, the box wrote into the old draft's slot,
    // and saving his new title left no draft at all.
    const before = await typedAndKilled();
    const after = store(before.dir, 2);
    const { host, decks } = deck();
    const session = new HandSession(host, decks);
    session.journalTo(after.journal);
    const v = decks.get().view!;
    expect(session.open(v.slides[0], v.slides[0].shapes[0], "end")).toBe(false);
    await vi.waitFor(() => expect(session.get().offer).toBeTruthy());
    // A store whose list fails offers nothing: his words in the same shape still keep a slot of their own.
    const blind: DraftsPort = { put: (d) => after.s.put(d, 3), drop: (k) => after.s.drop(k), release: (k) => after.s.release(k), list: () => Promise.reject(new Error("no list")) };
    const third = new HandSession(host, decks);
    third.journalTo(new DraftJournal(blind, { ...place, name: "Deck.pptx" }, () => AT));
    await third.lookForDrafts();
    expect(third.open(v.slides[0], v.slides[0].shapes[0], "end")).toBe(true);
    const box = third.get().box!;
    const { model, at } = insertText(box.model, { from: box.sel.to, to: box.sel.to }, " again");
    third.typed(model, { from: at, to: at });
    await third.commit();
    await after.s.settled();
    // The draft kept from before is still there, unanswered.
    expect((await after.kept()).map((d) => d.body.kind)).toEqual(["deck"]);
  });

  it("of two offers in turn, names each one's place, and the line's presses always act on the one shown", async () => {
    // Council r6 (Sol 1, Opus 2): the second offer read the same as the first, and Copy Words copied the first again.
    const two = deckView({ slides: [slide(3, { shapes: [TITLE, textShape(4, [{ level: 0, align: "left", list: "none", runs: [{ text: "Doors", size: 20 }] }])] })], hand: { undo: false, redo: false } });
    const before = store();
    // Two windows' boxes, each killed with words unsent: one on the title, one on the shape below it.
    for (const [n, words] of [[0, " today"], [1, " at six"]] as const) {
      const decks = new DeckStore();
      decks.view(two);
      const session = new HandSession(fakeDeckHost(two), decks);
      const port: DraftsPort = { put: (d) => before.s.put(d, 10 + n), drop: (k) => before.s.drop(k), release: (k) => before.s.release(k), list: (k) => before.s.list(k) };
      session.journalTo(new DraftJournal(port, { ...place, name: "Deck.pptx" }, () => AT));
      await session.lookForDrafts();
      session.open(two.slides[0], two.slides[0].shapes[n], "end");
      const box = session.get().box!;
      const typed = insertText(box.model, { from: box.sel.to, to: box.sel.to }, words);
      session.typed(typed.model, { from: typed.at, to: typed.at });
      await before.s.settled();
    }
    // Both windows go.
    before.s.releaseOwner(10);
    before.s.releaseOwner(11);
    // Both shapes changed since.
    const moved = deckView({ slides: [slide(3, { shapes: [textShape(2, [{ level: 0, align: "left", list: "none", runs: [{ text: "Who goes", size: 40 }] }]), textShape(4, [{ level: 0, align: "left", list: "none", runs: [{ text: "Gates", size: 20 }] }])] })], hand: { undo: false, redo: false } });
    const after = store(before.dir, 2);
    const decks = new DeckStore();
    decks.view(moved);
    const session = new HandSession(fakeDeckHost(moved), decks);
    session.journalTo(after.journal);
    await vi.waitFor(() => expect(session.get().offer).toBeTruthy());
    expect(session.saved(() => undefined).detail).toBe("Words on slide 3 from 2:30 PM were not saved. The slide changed since");
    const first = session.get().offer!.text;
    // The line as the window drew it for the first offer: Discard, then Copy Words from that same line.
    const line = session.saved(() => undefined);
    copied.length = 0;
    line.actions!.find((a) => a.id === "discard")!.run();
    const second = session.get().offer!.text;
    expect(second).not.toBe(first);
    await line.actions!.find((a) => a.id === "copy")!.run();
    expect(copied).toEqual([second]);
  });

  it("moves the offers on only by Restore's own answer: Discard waits for it, and the next draft is still offered", async () => {
    // Council r6 (Sol 4): Discard during a Restore advanced the offers, and the Restore's answer advanced them again.
    const before = store();
    const view = deckView({ slides: [slide(3), slide(5)], hand: { undo: false, redo: false } });
    const first = fakeDeckHost(view);
    first.edit = () => new Promise(() => undefined);
    const firstDecks = new DeckStore();
    firstDecks.view(view);
    const session = new HandSession(first, firstDecks);
    session.journalTo(before.journal);
    session.typeNotes(3, "Thank the sponsors", "");
    session.typeNotes(5, "Doors at six", "");
    await before.s.settled();
    const after = store(before.dir, 2);
    const host = fakeDeckHost(view);
    let answer = (): void => undefined;
    host.hold = new Promise<void>((done) => (answer = done));
    const decks = new DeckStore();
    decks.view(view);
    const again = new HandSession(host, decks);
    again.journalTo(after.journal);
    await vi.waitFor(() => expect(again.get().offer).toBeTruthy());
    const shown = again.get().offer!;
    expect(again.saved(() => undefined).detail).toBe(`${shown.where} from 2:30 PM were not saved`);
    const restoring = again.saved(() => undefined).actions!.find((a) => a.id === "restore")!.run();
    expect(restoring).toBeInstanceOf(Promise);
    again.discardDraft();
    expect(again.get().offer).toMatchObject({ key: shown.key });
    answer();
    await restoring;
    expect(again.get().offer).toMatchObject({ same: true });
    expect(again.get().offer!.key).not.toBe(shown.key);
    expect(again.get().offer!.where).not.toBe(shown.where);
  });

  it("of notes the host took is let go", async () => {
    const before = store();
    const { host, decks } = deck();
    const session = new HandSession(host, decks);
    session.journalTo(before.journal);
    session.typeNotes(3, "Thank the sponsors", "");
    expect(await session.keepNotes()).toBe(true);
    await before.s.settled();
    expect(await before.kept()).toEqual([]);
  });
});
