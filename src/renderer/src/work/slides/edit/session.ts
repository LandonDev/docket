import type { DeckShape, DeckSlide, DeckView, SlideOp } from "@shared/contract-work-slides";
import { CloseRefused } from "../../canvas/flush";
import { sayError } from "../../canvas/frame";
import { openDeck, type DeckHost, type DeckStore } from "../deck";
import type { Quad } from "../geometry";
import {
  applyLook,
  applyPara,
  DEFAULT_SIZE,
  formatOp,
  insertText,
  modelOf,
  pasteText,
  rebase,
  renumber,
  runsOp,
  sameWords,
  splitParagraph,
  typable,
  unchanged,
  wordsOf,
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
 * The box's life: `typing` (he types; a press outside or ⌘↩ commits, Escape
 * puts the words back), `saving` (the `runs` edit is on its way; the box
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
  /** the shape as it was when the box opened: the words his `from`s name */
  shape: DeckShape;
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

export interface HandState {
  picked: { slideKey: string; shapeId: number } | null;
  box: BoxState | null;
  /** his edits on their way (the box's, the row's, an undo, a restore) */
  busy: number;
  /** when the host last wrote one of his edits */
  savedAt: number | null;
  /** why the last edit did not go in, for the pane's one state line */
  failure: Failure | null;
  /** a look the row laid on the picked shape, shown until the deck comes back with it */
  shapeLook: { shapeId: number; set: RunLook & ParaLook } | null;
  /** a shape's carried picture, or the ground over a deleted one, until the new picture lands */
  land: Landing | null;
  /** where a picture or a video he is adding will lie, while it is on its way to the host */
  adding: { slideKey: string; quad: Quad } | null;
  /** the box's own undo and redo */
  undo: boolean;
  redo: boolean;
}

/** The host's word when the file moved between the read and the write (src/main/server/work/slides/view.ts). */
const MOVED = /changed while this was being made/i;
export const CONFLICT_WORD = "The deck changed while you typed";
/** Why a slide an agent's suggestion changes takes no hand edit. */
export const SUGGESTED = "Accept or reject the suggestion on this slide first";
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
    this.state = { ...this.state, ...patch, undo: this.past.length > 0, redo: this.future.length > 0 };
    for (const listener of this.listeners) listener();
  }
  private setBox(patch: Partial<BoxState>): void {
    if (this.state.box) this.set({ box: { ...this.state.box, ...patch } });
  }

  /** The words of a shape with none: the deck's body font and its first ink. */
  fallback(view: DeckView | null = this.store.get().view): RunLook {
    return { font: view?.theme?.minor || "Calibri", size: DEFAULT_SIZE, color: (view?.theme?.colors.dk1 ?? "000000").replace(/^#/, "").toUpperCase() };
  }

  pick(slideKey: string, shapeId: number | null): void {
    this.set({ picked: shapeId === null ? null : { slideKey, shapeId } });
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

  /** Opens the typing box on a shape: Return selects its words, F2 and a second press put the caret in them. */
  open(slide: DeckSlide, shape: DeckShape, start: Start): boolean {
    // While his last words are on their way the deck's words are about to change: a box now would be built on the old ones.
    if (this.state.box?.phase === "saving") return false;
    const why = this.refusal(slide, shape);
    if (why !== null) {
      if (why) sayError(new Error(why), why);
      return false;
    }
    const view = this.store.get().view;
    const model = modelOf(shape, this.fallback(view));
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
        shape,
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
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = setTimeout(() => {
      this.keepTimer = null;
      void this.keep();
    }, TYPING_SAVE_MS);
  }

  /** Runs one send of the box's words, after any still on its way. */
  private async sendBox(work: () => Promise<void>): Promise<void> {
    await this.settled();
    const run = work();
    this.sending = run;
    try {
      await run;
    } finally {
      if (this.sending === run) this.sending = null;
    }
  }

  /** Settles once no words of the box are on their way. */
  private async settled(): Promise<void> {
    while (this.sending) await this.sending.catch(() => undefined);
  }

  /**
   * Sends the box's words as they stand, the box left open with his caret in it: what is typed in a box reaches the
   * file within seconds, as everything else he does to a deck does, and never waits on the box being left. Escape after
   * it puts back only the words typed since. Words over a shape that changed are left for the commit to call a conflict.
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
        const next = await this.host.edit([runsOp(sent, box.slideId, box.shape.id, wordsOf(box.shape))]);
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

  /** Escape: the words go back as they were when last written; nothing is sent. */
  cancel(): void {
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = null;
    if (!this.state.box || this.state.box.phase !== "typing") return;
    this.past = [];
    this.future = [];
    this.set({ box: null, failure: null });
  }

  /** The shape the box is on, as the deck holds it now. */
  private shapeNow(box: BoxState, view: DeckView | null = this.store.get().view): DeckShape | undefined {
    return view?.slides.find((s) => s.id === box.slideId && s.tint !== "del")?.shapes.find((s) => s.id === box.shape.id);
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
      const next = await this.host.edit([runsOp(box.model, box.slideId, box.shape.id, wordsOf(box.shape))]);
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
    await this.commit();
    await this.settled();
    const { box, failure } = this.state;
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
      this.set({ failure: { conflict: true, message: "The shape is no longer on the slide" } });
      return;
    }
    const model = rebase(box.model, shape);
    this.setBox({ shape, initial: modelOf(shape, this.fallback()), model, drawn: model, conflict: false, paint: box.paint + 1, before: this.store.get().view?.renders.file?.rev ?? box.before });
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

  /** What saved means now, for a file's save line (FILES-SEAM.md "Save state"). */
  saved(reload: () => void): { state: "saved" | "saving" | "conflict"; at?: number; detail?: string; actions?: Array<{ id: string; label: string; run(): void }> } {
    const { busy, savedAt, failure, box } = this.state;
    if (failure?.conflict) return { state: "conflict", detail: failure.message, actions: [{ id: "reload", label: "Reload", run: reload }] };
    // Words in an open box that are not in the file yet are on their way (`keep`, within seconds): never saved.
    if (busy > 0 || (box?.phase === "typing" && !box.conflict && !unchanged(box.model, box.initial))) return { state: "saving" };
    return savedAt ? { state: "saved", at: savedAt } : { state: "saved" };
  }
}
