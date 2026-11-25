import type { DeckShape, DeckSlide, DeckView, SlideOp } from "@shared/contract-work-slides";
import type { Draft } from "@shared/work/drafts";
import type { DraftJournal } from "../../canvas/drafts";
import { copyText } from "../../../lib/clipboard";
import { CloseRefused, FLUSH_WAIT_MS } from "../../canvas/flush";
import { notSavedWords, whenWords } from "../../files/fileText";
import type { Unsaved } from "../../canvas/calm";
import { sayError } from "../../canvas/frame";
import { openDeck, type DeckHost, type DeckStore } from "../deck";
import type { Quad } from "../geometry";
import {
  applyLook,
  applyPara,
  cellShape,
  DEFAULT_SIZE,
  formatOp,
  insertText,
  modelOf,
  modelText,
  pasteText,
  rebase,
  renumber,
  runsOp,
  sameWords,
  splitParagraph,
  typable,
  unchanged,
  wordsOf,
  type Cell,
  type Model,
  type ParaLook,
  type RunLook,
  type Sel,
} from "./model";

/**
 * His hand on one deck in one window (docs/agents/work-slides.md "Typing on
 * a slide"): the shape he picked, the typing box while it is open, and his
 * edits on their way to the host. The stage, the format row and the bar all
 * read it; the box's page side lives in TypingBox.tsx.
 *
 * The box's life: `typing` (he types; a press outside, ⌘↩ or Escape
 * commits), `saving` (the `runs` edit is on its way; the box
 * shows his words and takes no pointer), `landing` (the host wrote it; the
 * box stays until the stage has painted the new picture of the slide). A
 * refused edit puts it back to `typing` with his words and says why; a deck
 * whose words changed under him is a conflict, which Reload settles.
 */

export type Start = "end" | "all" | { x: number; y: number };

export interface BoxState {
  /** this box among every box opened in the window: a new one is drawn afresh */
  id: number;
  slideId: number;
  slideKey: string;
  /** the shape as it was when the box opened: the words his `from`s name (a table's cell: that cell, `cellShape`) */
  shape: DeckShape;
  /** a table's cell the box types in; absent for a shape's own words */
  cell?: Cell;
  initial: Model;
  model: Model;
  /** the model the page's spans were last drawn from */
  drawn: Model;
  sel: Sel;
  /** a look set at a caret, for the words typed next */
  pending: RunLook;
  phase: "typing" | "saving" | "landing";
  /** counts each time the page must draw `model` again and put `sel` back (a look, an undo, a paste) */
  paint: number;
  /** counts each time the keyboard goes back into the box from the row */
  focus: number;
  start: Start;
  /** the words under him changed: nothing is sent until Reload */
  conflict: boolean;
  /** the slide's picture's revision when the box opened: the box goes once the stage paints another */
  before: string | null;
}

export interface Failure {
  conflict: boolean;
  message: string;
}

/**
 * What stands in for a shape's new picture after one of his edits to it, until the stage paints the slide anew: the
 * shape's own picture carried to where he put it (a move, a resize, a turn), or the slide's ground laid over where it
 * was (a delete). `saving` while the edit is on its way, `landing` once it is written.
 */
export interface Landing {
  slideKey: string;
  shapeId: number;
  /** where it is now, in shares of the slide */
  quad: Quad;
  /** the slide's colour round the shape, laid over its place: a delete */
  ground?: string;
  phase: "saving" | "landing";
  /** the slide's picture's revision when the edit was made */
  before: string | null;
}

/** A place the stage marks for him while a row of the sheet that names it is under his pointer or focus: an outline, or a filled band (a table's row or column). */
export interface Mark {
  slideKey: string;
  quad: Quad;
  fill: boolean;
}

export interface HandState {
  picked: { slideKey: string; shapeId: number } | null;
  /** what a row of the Format sheet points at on the stage now */
  mark?: Mark | null;
  box: BoxState | null;
  /** his edits on their way (the box's, the row's, an undo, a restore) */
  busy: number;
  /** when the host last wrote one of his edits */
  savedAt: number | null;
  /** the save line's clock (canvas/calm.ts): when his last word in the box was typed, and when the run of edits now on their way began */
  editedAt?: number | null;
  busySince?: number | null;
  /** why the last edit did not go in, for the pane's one state line */
  failure: Failure | null;
  /** why the host refused his notes, said in the save line with Retry until he types in them again or they go in */
  notesFailure?: string | null;
  /** when his last key in the notes field was, while those notes wait for the pause; nothing is on its way for them yet */
  notesEditedAt?: number | null;
  /** a look the row laid on the picked shape, shown until the deck comes back with it */
  shapeLook: { shapeId: number; set: RunLook & ParaLook } | null;
  /** a shape's carried picture, or the ground over a deleted one, until the new picture lands */
  land: Landing | null;
  /** where a picture or a video he is adding will lie, while it is on its way to the host */
  adding: { slideKey: string; quad: Quad; /** bytes the host holds of the file, of `total`, where it goes in more than one piece */ sent?: number; total?: number } | null;
  /** the box's own undo and redo */
  undo: boolean;
  redo: boolean;
  /**
   * A box's words a window kept on this computer and never sent (canvas/drafts.ts), offered as the deck opens: `same`
   * when the shape still holds the words the box opened on (Restore sends them as a commit does), else they are offered
   * to copy, never written over the shape. No box opens until he answers.
   */
  offer?: { at: number; same: boolean; text: string } | null;
}

/** The host's word when the file moved between the read and the write (src/main/server/work/slides/view.ts). */
const MOVED = /changed while this was being made/i;
export const CONFLICT_WORD = "The deck changed while you typed";
/** Why a slide an agent's suggestion changes takes no hand edit. */
export const SUGGESTED = "Accept or reject the suggestion on this slide first";
/** A conflict whose shape another save took off the slide: the box cannot be drawn, so its words wait to be copied. */
export const SHAPE_GONE = "The shape is no longer on the slide";
/** Words in the open box that are not in the file yet. */
const boxWaits = ({ box }: HandState): boolean => box?.phase === "typing" && !box.conflict && !unchanged(box.model, box.initial);

/** The save line's facts for canvas/calm.ts, from the session's state: the box's words not sent yet, and the edits on their way. */
export function unsavedOf(state: HandState): Unsaved {
  return { edited: boxWaits(state) ? (state.editedAt ?? Date.now()) : (state.notesEditedAt ?? null), pause: TYPING_SAVE_MS, sent: state.busy > 0 ? (state.busySince ?? Date.now()) : null };
}

/** The box's words as one `runs` edit, on its cell where it types in a table's. */
const runsOf = (model: Model, box: BoxState): Extract<SlideOp, { op: "runs" }> => ({ ...runsOp(model, box.slideId, box.shape.id, wordsOf(box.shape)), ...box.cell });

/** Words in a box not saved yet, when another box would open over them. */
export const UNSAVED = "The words in the open box are not saved yet";
/** A close that waited this long for words still in this window keeps its tab (canvas/flush.ts closes it at FLUSH_WAIT_MS). */
const CLOSE_WAIT_MS = FLUSH_WAIT_MS - 500;
/** A typing pause longer than this starts a new step of the box's own undo. */
const TYPING_STEP_MS = 1000;
/** A typing pause this long sends the box's words to the file, the box left open (`keep`). */
export const TYPING_SAVE_MS = 2000;

interface Snapshot {
  model: Model;
  sel: Sel;
  pending: RunLook;
}

/** Every box opened in this window, counted. */
let opened = 0;

const message = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

export class HandSession {
  private state: HandState = { picked: null, box: null, busy: 0, savedAt: null, failure: null, shapeLook: null, land: null, adding: null, undo: false, redo: false };
  private listeners = new Set<() => void>();
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private typedAt = 0;
  private keepTimer: ReturnType<typeof setTimeout> | null = null;
  /** The box's words on their way to the host (a keep or a commit): one at a time, each sent over what the last wrote. */
  private sending: Promise<void> | null = null;
  /** His notes waiting for the typing pause, the send of them on its way, and what the host last took for each slide. */
  private notesWaiting: { slide: number; text: string; began: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private notesSending: { slide: number; text: string; done: Promise<boolean> } | null = null;
  private notesHeld = new Map<number, string>();
  /** His notes the host refused, still in the field until he types again. */
  private notesRefused: { slide: number; text: string } | null = null;
  /** where the open box's unsent words are kept on this computer; null where there is no store */
  private journal: DraftJournal | null = null;
  /** where his notes not yet in the file are kept, beside the box's */
  private notesJournal: DraftJournal | null = null;
  /** what was last kept, as its JSON: the same box said again is not written again */
  private keptJson = "";
  private offered: Draft | null = null;
  private looked = false;

  constructor(
    private host: DeckHost,
    private store: DeckStore,
  ) {}

  get = (): HandState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(patch: Partial<HandState>): void {
    // The line's clock for edits on their way: from the first of a run, until none is.
    if (patch.busy !== undefined) patch = { ...patch, busySince: patch.busy <= 0 ? null : this.state.busy > 0 ? (this.state.busySince ?? Date.now()) : Date.now() };
    this.state = { ...this.state, ...patch, undo: this.past.length > 0, redo: this.future.length > 0 };
    for (const listener of this.listeners) listener();
    this.note();
  }

  /** The open box's words the host has not written, kept on this computer by the shape they are on; nothing once written, or the box gone. */
  private note(): void {
    if (!this.journal) return;
    const box = this.state.box;
    const waits = box && (box.phase === "typing" || box.phase === "saving") && !unchanged(box.model, box.initial);
    const body = waits ? { kind: "deck" as const, slideId: box.slideId, shapeId: box.shape.id, ...(box.cell ? { cell: box.cell } : {}), words: wordsOf(box.shape), model: box.model } : null;
    const json = body ? JSON.stringify(body) : "";
    if (json === this.keptJson) return;
    this.keptJson = json;
    this.journal.keep(body ? `${body.slideId}:${body.shapeId}${box?.cell ? `:${box.cell.row}:${box.cell.col}` : ""}` : "", body);
  }

  /** Where the box's unsent words are kept (SlidesCanvas, as the item is drawn); a deck already read asks for an earlier draft now. */
  journalTo(journal: DraftJournal | null): void {
    if (this.journal || !journal) return;
    this.journal = journal;
    this.notesJournal = journal.twin();
    void this.lookForDrafts();
  }

  /** Once, as the deck is read: the newest draft no live window holds is offered, and no box opens until he answers. */
  async lookForDrafts(): Promise<void> {
    const view = this.store.get().view;
    if (this.looked || !this.journal || !view) return;
    this.looked = true;
    // A box's words first; else notes he typed: the slide's notes must still be what they were typed over.
    const draft = (await this.journal.offered("deck"))[0] ?? (await this.journal.offered("notes"))[0];
    if (draft?.body.kind === "notes") {
      const { slideId, text, was } = draft.body;
      const now = view.slides.find((s) => s.id === slideId && s.tint !== "del")?.notes;
      this.offered = draft;
      this.set({ offer: { at: draft.at, same: now === was, text } });
      return;
    }
    if (!draft || draft.body.kind !== "deck") return;
    const { slideId, shapeId, cell, words, model } = draft.body;
    const found = view.slides.find((s) => s.id === slideId && s.tint !== "del")?.shapes.find((s) => s.id === shapeId);
    const shape = found && cell ? cellShape(found, cell) : found;
    this.offered = draft;
    this.set({ offer: { at: draft.at, same: !!shape && JSON.stringify(wordsOf(shape)) === JSON.stringify(words), text: modelText(model as Model) } });
  }

  /** Restore: the kept words, over a shape that still holds what the box opened on, sent as the box's commit sends them. A shape that moved on meanwhile turns the offer to Copy. */
  async restoreDraft(): Promise<void> {
    const draft = this.offered;
    if (!draft || (draft.body.kind !== "deck" && draft.body.kind !== "notes") || !this.state.offer?.same) return;
    const body = draft.body;
    this.set({ busy: this.state.busy + 1 });
    try {
      const op: SlideOp =
        body.kind === "notes" ? { op: "notes", slide: body.slideId, text: body.text, was: body.was } : { ...runsOp(body.model as Model, body.slideId, body.shapeId, body.words), ...body.cell };
      this.store.view(await this.host.edit([op]));
      this.journal?.drop(draft);
      this.offered = null;
      this.set({ busy: this.state.busy - 1, savedAt: Date.now(), offer: null });
    } catch (error) {
      const said = message(error, "The host did not answer");
      if (MOVED.test(said)) this.set({ busy: this.state.busy - 1, offer: { ...this.state.offer!, same: false } });
      else {
        this.set({ busy: this.state.busy - 1 });
        sayError(error, "Couldn't restore your words");
      }
    }
  }

  /** Discard: the kept words go. */
  discardDraft(): void {
    if (!this.offered) return;
    this.journal?.drop(this.offered);
    this.offered = null;
    this.set({ offer: null });
  }
  private setBox(patch: Partial<BoxState>): void {
    if (this.state.box) this.set({ box: { ...this.state.box, ...patch } });
  }

  /** The words of a shape with none: the deck's body font and its first ink. */
  fallback(view: DeckView | null = this.store.get().view): RunLook {
    return { font: view?.theme?.minor || "Calibri", size: DEFAULT_SIZE, color: (view?.theme?.colors.dk1 ?? "000000").replace(/^#/, "").toUpperCase() };
  }

  /** The look of words a box draws with none of their own: a cell's take no ink here, so they are drawn in the table's (TypingBox's `ink`). */
  private lookFor(cell: Cell | undefined, view: DeckView | null = this.store.get().view): RunLook {
    const look = this.fallback(view);
    if (!cell) return look;
    const { color: _ink, ...rest } = look;
    return rest;
  }

  pick(slideKey: string, shapeId: number | null): void {
    this.set({ picked: shapeId === null ? null : { slideKey, shapeId } });
  }

  /** The stage marks what a row of the sheet names, while it is under his pointer or focus; null lets it go. */
  mark(mark: Mark | null): void {
    const was = this.state.mark ?? null;
    if (was === mark || (was && mark && was.slideKey === mark.slideKey && was.fill === mark.fill && JSON.stringify(was.quad) === JSON.stringify(mark.quad))) return;
    this.set({ mark });
  }

  /** Why a shape cannot take his words now, or null when it can. */
  refusal(slide: DeckSlide, shape: DeckShape): string | null {
    return typable(shape) ? this.slideRefusal(slide) : "";
  }

  /**
   * Why a slide (its shapes, its place) cannot take his hand now, or null when it can: "" where the deck cannot be
   * edited by hand; a sentence on a slide a suggestion changes, whose picture and shapes are the proposed deck's.
   */
  slideRefusal(slide: DeckSlide): string | null {
    if (!this.store.get().view?.hand) return "";
    if (slide.change !== null || slide.from !== "file") return SUGGESTED;
    return null;
  }

  /**
   * Opens the typing box on a shape: Return selects its words, F2 and a second press put the caret in them. On a table
   * it opens on one cell: `cell`, else the first.
   */
  open(slide: DeckSlide, shape: DeckShape, start: Start, cell?: Cell): boolean {
    // While his last words are on their way the deck's words are about to change: a box now would be built on the old ones.
    if (this.state.box?.phase === "saving") return false;
    // Words kept from before wait for his answer first: a box now could be built over the shape they belong to.
    if (this.state.offer) return false;
    // Words still in a box (a conflict that waits for Reload, a send the host refused) are never drawn over by another.
    const was = this.state.box;
    if (was?.phase === "typing" && (was.conflict || !unchanged(was.model, was.initial))) {
      sayError(new Error(UNSAVED), UNSAVED);
      return false;
    }
    const at = shape.kind === "table" ? (cell ?? { row: 0, col: 0 }) : undefined;
    const words = at ? cellShape(shape, at) : shape;
    if (!words) return false;
    const why = this.refusal(slide, words);
    if (why !== null) {
      if (why) sayError(new Error(why), why);
      return false;
    }
    const view = this.store.get().view;
    const model = modelOf(words, this.lookFor(at, view));
    const end = model.length - 1;
    const length = model[end].runs.reduce((n, r) => n + r.text.length, 0);
    this.past = [];
    this.future = [];
    this.set({
      picked: { slideKey: slide.key, shapeId: shape.id },
      failure: null,
      box: {
        id: ++opened,
        slideId: slide.id,
        slideKey: slide.key,
        shape: words,
        ...(at ? { cell: at } : {}),
        initial: model,
        model,
        drawn: model,
        sel: start === "all" ? { from: [0, 0], to: [end, length] } : { from: [end, length], to: [end, length] },
        pending: {},
        phase: "typing",
        paint: 1,
        focus: 0,
        start,
        conflict: false,
        before: view?.renders[slide.from]?.rev ?? null,
      },
    });
    return true;
  }

  private remember(kind: "type" | "act"): void {
    const box = this.state.box;
    if (!box) return;
    const now = Date.now();
    if (kind === "act" || now - this.typedAt > TYPING_STEP_MS) this.past.push({ model: box.model, sel: box.sel, pending: box.pending });
    this.typedAt = kind === "type" ? now : 0;
    this.future = [];
  }

  /** What the page holds after he typed. */
  typed(model: Model, sel: Sel | null): void {
    const box = this.state.box;
    if (!box || box.phase !== "typing") return;
    this.remember("type");
    this.setBox({ model, ...(sel ? { sel } : {}), pending: {} });
    this.keepLater();
  }

  select(sel: Sel): void {
    const box = this.state.box;
    if (!box || (box.sel.from[0] === sel.from[0] && box.sel.from[1] === sel.from[1] && box.sel.to[0] === sel.to[0] && box.sel.to[1] === sel.to[1])) return;
    this.setBox({ sel, pending: {} });
  }

  /** A change the box draws again: its model, its selection, and what waits for the next words. */
  private act(model: Model, sel: Sel, pending: RunLook = {}): void {
    const box = this.state.box;
    if (!box || box.phase !== "typing") return;
    this.remember("act");
    this.setBox({ model, drawn: model, sel, pending, paint: box.paint + 1 });
    this.keepLater();
  }

  look(look: RunLook): void {
    const box = this.state.box;
    if (!box || box.phase !== "typing") return;
    const next = applyLook(box.model, box.sel, look, box.pending);
    if (next.model === box.model) return this.setBox({ pending: next.pending });
    this.act(next.model, box.sel, next.pending);
  }

  para(set: ParaLook): void {
    const box = this.state.box;
    if (box?.phase === "typing") this.act(applyPara(box.model, box.sel, set), box.sel, box.pending);
  }

  /** Return: a new paragraph. */
  enter(): void {
    const box = this.state.box;
    if (box?.phase !== "typing") return;
    const { model, at } = splitParagraph(box.model, box.sel);
    this.act(model, { from: at, to: at }, box.pending);
  }

  /** Words put in by the box itself: a line break (Shift-Return), or words typed after a look set at a caret. */
  insert(text: string): void {
    const box = this.state.box;
    if (box?.phase !== "typing") return;
    const { model, at } = insertText(box.model, box.sel, text, box.pending);
    this.act(model, { from: at, to: at }, text === "\n" ? box.pending : {});
  }

  paste(text: string): void {
    const box = this.state.box;
    if (box?.phase !== "typing" || !text) return;
    const { model, at } = pasteText(box.model, box.sel, text, box.pending);
    this.act(model, { from: at, to: at });
  }

  undo(): void {
    const box = this.state.box;
    const back = this.past.pop();
    if (!box || box.phase !== "typing" || !back) return;
    this.future.push({ model: box.model, sel: box.sel, pending: box.pending });
    this.typedAt = 0;
    this.setBox({ model: back.model, drawn: back.model, sel: back.sel, pending: back.pending, paint: box.paint + 1 });
    this.keepLater();
  }

  redo(): void {
    const box = this.state.box;
    const ahead = this.future.pop();
    if (!box || box.phase !== "typing" || !ahead) return;
    this.past.push({ model: box.model, sel: box.sel, pending: box.pending });
    this.typedAt = 0;
    this.setBox({ model: ahead.model, drawn: ahead.model, sel: ahead.sel, pending: ahead.pending, paint: box.paint + 1 });
    this.keepLater();
  }

  /** The keyboard goes back into the box, his selection with it (Escape in the row). */
  focusBox(): void {
    const box = this.state.box;
    if (box?.phase === "typing") this.setBox({ focus: box.focus + 1 });
  }

  /** The page draws the words again as they stand (the stage changed size). */
  repaint(): void {
    const box = this.state.box;
    if (box) this.setBox({ drawn: box.model, paint: box.paint + 1 });
  }

  /** A pause in his typing sends the box's words; each new word moves the pause on. */
  private keepLater(): void {
    // Told at once, with the edit's own draw: the line's pause counts from this word.
    this.set({ editedAt: Date.now() });
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = setTimeout(() => {
      this.keepTimer = null;
      void this.keep();
    }, TYPING_SAVE_MS);
  }

  /**
   * Runs one send of the box's words after any still on its way. It joins the line at once, so a close that asks
   * (`settled`) never finds the line empty while this one waits its turn.
   */
  private sendBox(work: () => Promise<void>): Promise<void> {
    const run = (this.sending ?? Promise.resolve()).catch(() => undefined).then(work);
    this.sending = run;
    return run.finally(() => {
      if (this.sending === run) this.sending = null;
    });
  }

  /** Settles once no words of the box are on their way. */
  private async settled(): Promise<void> {
    while (this.sending) await this.sending.catch(() => undefined);
  }

  /**
   * Sends the box's words as they stand, the box left open with his caret in it: what is typed in a box reaches the
   * file within seconds, as everything else he does to a deck does, and never waits on the box being left. Words over a
   * shape that changed are left for the commit to call a conflict.
   */
  async keep(): Promise<void> {
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = null;
    await this.sendBox(async () => {
      const box = this.state.box;
      if (!box || box.phase !== "typing" || box.conflict || unchanged(box.model, box.initial)) return;
      if (!sameWords(this.shapeNow(box), box.shape)) return;
      const sent = box.model;
      this.set({ busy: this.state.busy + 1, failure: null });
      try {
        const next = await this.host.edit([runsOf(sent, box)]);
        this.store.view(next);
        const now = this.state.box;
        // Still this box: the file's paragraphs and runs are now the ones just written, so every `from` the box, its
        // undo and its redo hold moves onto them, and what it opened on is the words just written.
        if (now && now.id === box.id) {
          const shape = this.shapeNow(now, next);
          const move = renumber(sent);
          const moved = (s: Snapshot): Snapshot => ({ ...s, model: move(s.model) });
          this.past = this.past.map(moved);
          this.future = this.future.map(moved);
          this.setBox({ initial: move(sent), model: move(now.model), drawn: move(now.drawn), ...(shape ? { shape } : {}) });
        }
        this.set({ busy: this.state.busy - 1, savedAt: Date.now() });
      } catch (error) {
        const said = message(error, "The host did not answer");
        const conflict = MOVED.test(said);
        this.set({ busy: this.state.busy - 1, failure: { conflict, message: conflict ? CONFLICT_WORD : said } });
        if (conflict) this.setBox({ conflict: true });
      }
    });
  }

  /** The words of the open box, as plain text: what a box whose shape is gone hands his clipboard (`SHAPE_GONE`). */
  draftWords(): string {
    return this.state.box ? modelText(this.state.box.model) : "";
  }

  /** The box goes with its words, nothing sent: only once Copy words put them on his clipboard (`SHAPE_GONE`). */
  drop(): void {
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = null;
    if (!this.state.box || this.state.box.phase !== "typing") return;
    this.past = [];
    this.future = [];
    this.set({ box: null, failure: null });
  }

  /** The shape the box is on, as the deck holds it now (a table's cell: that cell). */
  private shapeNow(box: BoxState, view: DeckView | null = this.store.get().view): DeckShape | undefined {
    const shape = view?.slides.find((s) => s.id === box.slideId && s.tint !== "del")?.shapes.find((s) => s.id === box.shape.id);
    return shape && box.cell ? (cellShape(shape, box.cell) ?? undefined) : shape;
  }

  /**
   * Sends the box's words as one `runs` edit, or closes it when nothing
   * changed. Words over a shape that changed since the box opened are not
   * sent: that is a conflict, and the box keeps them.
   */
  async commit(): Promise<void> {
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = null;
    const first = this.state.box;
    // A commit already on its way: this one waits for it.
    if (first?.phase === "saving") return this.settled();
    if (!first || first.phase !== "typing" || first.conflict) return;
    // The box takes no more words and no other box opens while a keep on its way lands: this sends over what it wrote.
    this.setBox({ phase: "saving" });
    await this.sendBox(() => this.write(first.id));
  }

  /** The commit's own send, once nothing else of the box is on its way. */
  private async write(id: number): Promise<void> {
    const box = this.state.box;
    if (!box || box.id !== id) return;
    if (box.conflict) return this.setBox({ phase: "typing" });
    if (unchanged(box.model, box.initial)) {
      this.past = [];
      this.future = [];
      this.set({ box: null, failure: null });
      return;
    }
    if (!sameWords(this.shapeNow(box), box.shape)) {
      this.setBox({ phase: "typing", conflict: true });
      this.set({ failure: { conflict: true, message: CONFLICT_WORD } });
      return;
    }
    this.set({ busy: this.state.busy + 1, failure: null });
    try {
      const next = await this.host.edit([runsOf(box.model, box)]);
      this.store.view(next);
      const slide = next.slides.find((s) => s.id === box.slideId && s.tint !== "del");
      const rev = slide && !next.renderError ? (next.renders[slide.from]?.rev ?? null) : null;
      this.past = [];
      this.future = [];
      // The box stays until the stage paints the new picture; with none to wait for it goes now.
      const landing = rev !== null && rev !== box.before && this.state.box?.slideKey === box.slideKey;
      this.set({ busy: this.state.busy - 1, savedAt: Date.now(), box: landing ? { ...this.state.box!, phase: "landing" } : null });
    } catch (error) {
      const said = message(error, "The host did not answer");
      const conflict = MOVED.test(said);
      this.set({ busy: this.state.busy - 1, failure: { conflict, message: conflict ? CONFLICT_WORD : said } });
      this.setBox({ phase: "typing", conflict });
    }
  }

  /**
   * For a tab's close (canvas/flush.ts): the box's words sent, after any send on its way. Refused with the host's word
   * when they are still not in the file, so the tab stays open with them and the line's Retry or Reload.
   */
  async flush(): Promise<void> {
    // His notes go first, and a close waits for them as for the box. Notes refused before (changed elsewhere, said
    // then) go once more over the notes as they are now, the other save kept in the deck's versions; refused again,
    // the tab stays with them in the field.
    if (!(await this.retryNotes())) throw new CloseRefused("Your notes are not in the file yet");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = await Promise.race([
      (async () => {
        await this.commit();
        await this.settled();
        return false;
      })(),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), CLOSE_WAIT_MS))),
    ]);
    clearTimeout(timer);
    const { box, failure } = this.state;
    // Before the close's own wait runs out: words the host has not said it holds (still behind a slow keep, or a write
    // on its way that may yet be refused, whatever an earlier try did) would be lost with the item, so the tab stays.
    // So does a send still unanswered while the box matches what it was opened on: his Undo back to those words waits
    // behind it, and is sent only once it lands.
    if (late && box && (box.phase === "typing" || box.phase === "saving") && (this.sending !== null || !unchanged(box.model, box.initial))) throw new CloseRefused(UNSAVED);
    if (box?.phase === "typing" && !unchanged(box.model, box.initial)) throw new CloseRefused(failure?.message ?? "Your words in the box are not in the file yet");
  }

  /**
   * After a conflict: the deck read again, and his words kept in the box over
   * the shape as it is now, so a commit sends them over what is there.
   */
  async reload(): Promise<void> {
    await openDeck(this.host, this.store);
    const box = this.state.box;
    if (!box) return this.set({ failure: null });
    const shape = this.shapeNow(box);
    if (!shape || !typable(shape)) {
      this.set({ failure: { conflict: true, message: SHAPE_GONE } });
      return;
    }
    const model = rebase(box.model, box.shape, shape);
    // The box's own Undo and Redo hold words read from the same old runs: they move onto the new words the same way.
    const moved = (snap: Snapshot): Snapshot => ({ ...snap, model: rebase(snap.model, box.shape, shape) });
    this.past = this.past.map(moved);
    this.future = this.future.map(moved);
    this.setBox({ shape, initial: modelOf(shape, this.lookFor(box.cell)), model, drawn: model, conflict: false, paint: box.paint + 1, before: this.store.get().view?.renders.file?.rev ?? box.before });
    this.set({ failure: null });
  }

  /** The stage painted a picture of a slide at a revision: a box, a carried picture or a cover waiting for it goes. */
  painted(slideKey: string, rev: string | null): void {
    const { box, land } = this.state;
    if (box?.phase === "landing" && box.slideKey === slideKey && rev !== box.before) this.set({ box: null });
    if (land?.phase === "landing" && land.slideKey === slideKey && rev !== land.before) this.set({ land: null });
  }

  /** The stage could not paint the slide: its own line says so, and what waited for it goes. */
  paintFailed(slideKey: string): void {
    const { box, land } = this.state;
    if (box?.phase === "landing" && box.slideKey === slideKey) this.set({ box: null });
    if (land?.phase === "landing" && land.slideKey === slideKey) this.set({ land: null });
  }

  /** One of his edits from the row or the bar: on its way, then written, or said once as a toast. */
  private async send(work: () => Promise<DeckView>, fallback: string): Promise<boolean> {
    return (await this.sent(work, fallback)) !== null;
  }

  private async sent(work: () => Promise<DeckView>, fallback: string): Promise<DeckView | null> {
    this.set({ busy: this.state.busy + 1 });
    try {
      const next = await work();
      this.store.view(next);
      this.set({ busy: this.state.busy - 1, savedAt: Date.now() });
      return next;
    } catch (error) {
      this.set({ busy: this.state.busy - 1 });
      sayError(error, fallback);
      return null;
    }
  }

  /**
   * His edits to shapes, slides or the deck (`geometry`, `insert`, `order`, `fill`, a slide's place …), written at
   * once: the new view, or null when the host refused them (said once, as a toast). With `land`, the shape's carried
   * picture or the ground laid over it stays until the stage paints the slide anew, and goes at once if the edit fails.
   */
  async edit(ops: SlideOp[], fallback: string, land?: Omit<Landing, "phase" | "before">): Promise<DeckView | null> {
    let ours: Landing | null = null;
    if (land) {
      const view = this.store.get().view;
      const slide = view?.slides.find((s) => s.key === land.slideKey);
      ours = { ...land, phase: "saving", before: slide && view ? (view.renders[slide.from]?.rev ?? null) : null };
      this.set({ land: ours });
    }
    const next = await this.sent(() => this.host.edit(ops), fallback);
    if (ours && this.state.land === ours) {
      const slide = next?.slides.find((s) => s.key === ours.slideKey);
      const rev = slide && !next?.renderError ? (next?.renders[slide.from]?.rev ?? null) : null;
      this.set({ land: next && rev !== null && rev !== ours.before ? { ...ours, phase: "landing" } : null });
    }
    return next;
  }

  /** One of his edits from a dialog, which says a refusal itself: written at once, or thrown with the host's sentence. */
  async editOrThrow(ops: SlideOp[]): Promise<DeckView> {
    const next = await this.while(() => this.host.edit(ops));
    this.store.view(next);
    this.set({ savedAt: Date.now() });
    return next;
  }

  /**
   * His words in a slide's notes field, kept as the box's are (docs/agents/work-slides.md "Notes he types"): one
   * `notes` edit after a pause of `TYPING_SAVE_MS`, or at once (`keepNotes`: the field left, Escape, the stage leaving
   * the slide, the tab closing). Until they are in the file the line says saving. Each edit names the notes it was
   * written over (`was`): what the host last took from this field, else what the field began from.
   */
  typeNotes(slide: number, text: string, began: string): void {
    const waiting = this.notesWaiting;
    if (waiting && waiting.slide !== slide) void this.keepNotes();
    this.notesRefused = null;
    if (this.notesWaiting) clearTimeout(this.notesWaiting.timer);
    // Waiting for the pause, nothing is on its way: the line keeps its Saved until the pause ends or they are sent.
    this.set({ notesEditedAt: Date.now(), notesFailure: null });
    this.notesWaiting = { slide, text, began, timer: setTimeout(() => void this.keepNotes(), TYPING_SAVE_MS) };
    // Kept on this computer at once, so a crash in the pause loses nothing; they go from it once the host has them.
    this.notesJournal?.keep(`notes:${slide}`, { kind: "notes", slideId: slide, text, was: this.notesHeld.get(slide) ?? began });
  }

  /** The notes waiting for the pause, sent now; resolves once every notes edit on its way has its answer. False: refused. */
  async keepNotes(): Promise<boolean> {
    const waiting = this.notesWaiting;
    if (!waiting) return (await this.notesSending?.done) ?? true;
    clearTimeout(waiting.timer);
    this.notesWaiting = null;
    const was = this.notesHeld.get(waiting.slide) ?? waiting.began;
    if (waiting.text === was) {
      this.set({ notesEditedAt: null });
      // (a send on its way holds the same words: its answer lets the draft go)
      if (!this.notesSending) this.notesJournal?.clear();
      return (await this.notesSending?.done) ?? true;
    }
    // The send counts itself on its way as the wait ends, so the line never says saved between the two.
    this.notesHeld.set(waiting.slide, waiting.text);
    this.set({ busy: this.state.busy + 1, notesEditedAt: null });
    const sending: { slide: number; text: string; done: Promise<boolean> } = {
      slide: waiting.slide,
      text: waiting.text,
      done: this.host.edit([{ op: "notes", slide: waiting.slide, text: waiting.text, was }]).then(
        (next) => {
          this.store.view(next);
          this.set({ busy: this.state.busy - 1, savedAt: Date.now() });
          // Kept until this send's own answer: a later send's draft stays while it is on its way or waits.
          if (!this.notesWaiting && this.notesSending === sending) this.notesJournal?.clear();
          return true;
        },
        (error) => {
          // Refused (the notes changed elsewhere, or the host would not take them): said in the save line with Retry,
          // his words stay in the field and kept on this computer, and his next keep writes over the notes as the
          // deck has them now.
          const said = message(error, "Couldn't save the notes");
          this.notesHeld.set(waiting.slide, this.store.get().view?.slides.find((s) => s.id === waiting.slide)?.notes ?? was);
          this.notesRefused = { slide: waiting.slide, text: waiting.text };
          this.set({ busy: this.state.busy - 1, notesFailure: MOVED.test(said) ? CONFLICT_WORD : said });
          return false;
        },
      ),
    };
    this.notesSending = sending;
    const ok = await sending.done;
    if (this.notesSending === sending) this.notesSending = null;
    return ok;
  }

  /** His refused notes sent once more, over the notes as the deck has them now; resolves as `keepNotes` does. */
  retryNotes(): Promise<boolean> {
    const refused = this.notesRefused;
    if (refused && !this.notesWaiting) this.typeNotes(refused.slide, refused.text, refused.text);
    return this.keepNotes();
  }

  /** His notes for a slide that are not yet the deck's (waiting, on their way or refused): what a field drawn again starts from. */
  pendingNotes(slide: number): string | null {
    if (this.notesWaiting?.slide === slide) return this.notesWaiting.text;
    if (this.notesRefused?.slide === slide) return this.notesRefused.text;
    return this.notesSending?.slide === slide ? this.notesSending.text : null;
  }

  /** Whether his notes for a slide are not yet the deck's: waiting, on their way or refused. The field keeps them over a view that comes meanwhile. */
  notesPending(slide: number): boolean {
    return this.notesWaiting?.slide === slide || this.notesSending?.slide === slide || this.notesRefused?.slide === slide;
  }

  /** A picture or a video on its way to the host: where it will lie, or null once it is there or failed. */
  adding(at: HandState["adding"]): void {
    this.set({ adding: at });
  }

  /** Work for one of his edits that is not the edit itself (a file brought to the host): saving while it runs. */
  async while<T>(work: () => Promise<T>): Promise<T> {
    this.set({ busy: this.state.busy + 1 });
    try {
      return await work();
    } finally {
      this.set({ busy: this.state.busy - 1 });
    }
  }

  /** Whether one of his edits to a shape is still on its way: a new drag waits for it, as a new box does. */
  get moving(): boolean {
    return this.state.land?.phase === "saving";
  }

  /** A look laid on the whole of the picked shape, written at once. */
  async formatShape(slide: DeckSlide, shape: DeckShape, set: RunLook & ParaLook): Promise<void> {
    if (this.refusal(slide, shape) !== null) return;
    this.set({ shapeLook: { shapeId: shape.id, set: { ...(this.state.shapeLook?.shapeId === shape.id ? this.state.shapeLook.set : {}), ...set } } });
    await this.send(() => this.host.edit([formatOp(slide.id, shape.id, set)]), "Couldn't change the words");
    this.set({ shapeLook: null });
  }

  /** Undo or Redo of his edits to the file. */
  step(dir: "undo" | "redo"): Promise<boolean> {
    return this.send(() => this.host.step(dir), dir === "undo" ? "Couldn't undo" : "Couldn't redo");
  }

  restore(version: string): Promise<boolean> {
    return this.send(() => this.host.restore(version), "Couldn't restore that version");
  }

  /** The save line's facts for canvas/calm.ts: the box's words not sent yet, and the edits on their way. */
  unsaved(): Unsaved {
    return unsavedOf(this.state);
  }

  /**
   * What saved means now, for a file's save line (FILES-SEAM.md "Save state"). `saving` is canvas/calm.ts's answer
   * over `unsaved()`: words in the box inside its pause, and a send out less than 600 ms, keep the last Saved line.
   */
  saved(reload: () => void, copy?: () => void, saving = this.busyOrTyped()): { state: "saved" | "saving" | "conflict"; at?: number; detail?: string; actions?: Array<{ id: string; label: string; run(): void }> } {
    const { savedAt, failure, offer } = this.state;
    if (offer) {
      const when = whenWords(offer.at);
      return {
        state: "conflict",
        detail: offer.same ? `Edits from ${when} were not saved` : `Edits from ${when} were not saved. The slide changed since`,
        actions: [offer.same ? { id: "restore", label: "Restore", run: () => void this.restoreDraft() } : { id: "copy", label: "Copy Words", run: () => void copyText(offer.text) }, { id: "discard", label: "Discard", run: () => this.discardDraft() }],
      };
    }
    if (failure?.message === SHAPE_GONE && copy) return { state: "conflict", detail: failure.message, actions: [{ id: "copy", label: "Copy words", run: copy }] };
    if (failure?.conflict) return { state: "conflict", detail: failure.message, actions: [{ id: "reload", label: "Reload", run: reload }] };
    // A save that did not go in is said at once, never as saving: his words wait in the box, and Retry sends them again.
    if (failure) return { state: "conflict", detail: notSavedWords(failure.message), actions: [{ id: "retry", label: "Retry", run: () => void this.commit() }] };
    const { notesFailure } = this.state;
    if (notesFailure) return { state: "conflict", detail: notSavedWords(notesFailure), actions: [{ id: "retry", label: "Retry", run: () => void this.retryNotes() }] };
    if (saving) return { state: "saving" };
    return savedAt ? { state: "saved", at: savedAt } : { state: "saved" };
  }

  /** With no clock asked: anything not written yet. */
  private busyOrTyped(): boolean {
    return this.state.busy > 0 || boxWaits(this.state) || this.notesWaiting !== null;
  }
}
