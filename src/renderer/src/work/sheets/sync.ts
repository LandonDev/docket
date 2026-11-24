import { useSyncExternalStore } from "react";
import type { SheetCellJson, SheetMutationJson, SheetView } from "@shared/contract-work-sheets";
import type { ObjectChange, SheetObjects } from "work-kit/sheet";
import { AUTO_FIT, forPackage, isObjectList, latestRules, ruleKinds, SHEET_MOVES, sheetStopWords, type ObjectIds, type RulesSetParams, type SheetRuleKind } from "@shared/work/sheets";
import { cellText, holds } from "./model";
import { FileIds, listChanges, listMedia, MadePictures, objectListOf, tabList } from "./objects";
import { EDIT_MAX, fromBase64, LOAD_MAX, type SheetHost, type SheetPushed } from "./host";
import { CloseRefused } from "../canvas/flush";

/**
 * One sheet item's sync with its host (docs/agents/work-sheets.md): the
 * view, the workbook loaded at a revision, the person's edits sent in
 * batches from the revision the grid stands at, what landed since brought
 * in, and the agent's open suggestions laid into their cells so each
 * holds the value it would leave. No React and no Univer: the grid is a
 * `GridLink`, so a test drives it all.
 */

/** A workbook as the grid opens it: a Univer snapshot. */
export type Workbook = { id?: string; sheetOrder?: string[]; sheets?: Record<string, { name?: string }> } & Record<string, unknown>;

/** What the sync needs of a mounted grid. */
export interface GridLink {
  /** the workbook's id in the grid, for the mutations it lays in */
  unitId: string;
  /** applies mutations that came from elsewhere; they are not reported back */
  apply(mutations: SheetMutationJson[]): void;
  /** every mutation the person makes */
  onMutation(listener: (mutation: SheetMutationJson) => void): () => void;
  read(sheet: string, row: number, col: number): SheetCellJson | null;
  /** the formula text the grid holds for a cell (a fill's cell holds only its shared formula's id) */
  formula(sheet: string, row: number, col: number): string | null;
  /** takes back the grid's last command: how a change its store cannot keep is stopped as he makes it */
  undo(): void | Promise<unknown>;
  /** ends the cell editor, keeping what he typed in it (an open cell is his edit too): false when it stays open (the grid refused the value); absent in a grid with no editor */
  commit?(): Promise<boolean>;
  /** every command he runs in the grid, as it ends; absent in a grid that cannot say (each turn is then taken for one) */
  onCommand?(listener: (id: string) => void): () => void;
  /** a style the grid names by its own id, as the style itself; null when it knows none by that id */
  style?(id: string): Record<string, unknown> | null;
  /** a sheet's rules of one kind as they stand now (the workbook's names take no sheet); absent in a grid with no rules */
  rules?(kind: SheetRuleKind, sheet?: string): unknown;
  /** the grid's charts and pictures: every one as it stands, a tab's id by its name, and changes from elsewhere laid in (not told back); absent in a grid with none */
  objects?: { list(): SheetObjects; sheetId(name: string): string | undefined; sheetName(id: string): string | undefined; apply(changes: ObjectChange[]): void };
}

export interface SheetSyncState {
  view: SheetView | null;
  /** the item could not be opened or its workbook read */
  failed: string | null;
  book: (Book & { key: number }) | null;
  /** the person's edits did not reach the host */
  sendError: string | null;
  /** edits of his wait to be sent, or are on their way */
  saving: boolean;
  /** when his last edit was saved (epoch ms); null before the first */
  savedAt: number | null;
  /** the book is being read again from its store after a stop, or a move is on its way to the host: the grid takes no edit until it is drawn or the host has answered */
  reloading: boolean;
  /** a change the sheet's store cannot keep was stopped as he made it: why, in the words he reads, and which time (so the same words twice are said twice) */
  stopped: { why: string; n: number } | null;
  /** the change the stepper is on */
  current: number;
  /** goes up whenever a cell changes, for what reads the grid (a chart) */
  tick: number;
}

/** A workbook as it was read, with its charts and pictures and their bytes by part where it holds any (an Excel file's own; absent elsewhere). */
export interface Book {
  workbook: Workbook;
  objects?: SheetObjects;
  media?: ReadonlyMap<string, { bytes: Uint8Array; type: string }>;
}
/** Bytes and their format, as the grid opens them. */
export type Decode = (bytes: Uint8Array, format: "xlsx" | "snapshot") => Promise<Book>;

const SET_RANGE_VALUES = "sheet.mutation.set-range-values";
/** Every key a cell can hold, as null: what a restored cell is laid over, so nothing of the overlay stays. */
const CLEAR = { v: null, t: null, f: null, si: null, p: null, s: null, custom: null, ref: null, ft: null, fd: null };
/** How long edits gather before they are sent. */
export const EDIT_WAIT = 150;
const CONFLICT_TRIES = 5;
/** Univer's own bookkeeping after an edit (the heights it works out again from what a row holds): nothing a file keeps, so never sent and never said. */
const BOOKKEEPING = new Set(["sheet.mutation.set-worksheet-row-auto-height"]);

export { forPackage, latestRules, ruleKinds };
/** Why a change cannot be saved, in the words he reads as it is stopped: the shared words, which the host's own refusals say too. */
export const stoppedWords = sheetStopWords;

/** An op as this grid names its workbook: the host's unit id and the grid's can differ. */
const inUnit = (mutation: SheetMutationJson, unitId: string): SheetMutationJson =>
  mutation.params && typeof mutation.params === "object" && "unitId" in mutation.params ? { ...mutation, params: { ...(mutation.params as object), unitId } } : mutation;

/** Whether a mutation changes this grid's workbook: one that names another unit (the cell editor's document) does not; one that names none is the workbook's. */
export const ofUnit = (mutation: SheetMutationJson, unitId: string): boolean => {
  const named = mutation.params && typeof mutation.params === "object" ? (mutation.params as { unitId?: unknown }).unitId : undefined;
  return typeof named !== "string" || !unitId || named === unitId;
};

const message = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

const columnName = (col: number): string => {
  let name = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
/** The most cells the words name; past it they are counted. */
const NAMED_MOST = 3;

/**
 * What a batch the file no longer takes held, said once as it is dropped: each cell he wrote and what he put in it,
 * so he can make it again on the sheet as it is now. A sheet is named only when the cells lie on more than one.
 */
export function notSavedWords(batch: readonly SheetMutationJson[], sheetName: (id: string) => string | undefined): string {
  const cells: { sheet: string; at: string; put: string }[] = [];
  for (const m of batch) {
    if (m.id !== SET_RANGE_VALUES) continue;
    const p = m.params as { subUnitId?: string; cellValue?: Record<string, Record<string, (SheetCellJson & { p?: { body?: { dataStream?: string } } }) | null>> };
    for (const [r, cols] of Object.entries(p.cellValue ?? {}))
      for (const [c, cell] of Object.entries(cols ?? {})) {
        // (a style alone keeps what the cell held)
        if (cell && !("v" in cell) && !("f" in cell) && !("p" in cell)) continue;
        const text = cell?.f ?? cell?.p?.body?.dataStream?.replace(/[\r\n]+$/, "") ?? (cell?.v === null || cell?.v === undefined ? "" : String(cell.v));
        const put = text === "" ? "cleared" : text.length > 40 ? `${text.slice(0, 39)}…` : text;
        cells.push({ sheet: p.subUnitId ?? "", at: `${columnName(Number(c))}${Number(r) + 1}`, put });
      }
  }
  if (!cells.length) return "The file changed before your last change was saved, so it was not made. Make it again.";
  const many = new Set(cells.map((x) => x.sheet)).size > 1;
  const named = cells.slice(0, NAMED_MOST).map((x) => `${many ? `${sheetName(x.sheet) ?? x.sheet}!` : ""}${x.at} ${x.put}`);
  const more = cells.length - named.length;
  return `The file changed before this was saved: ${named.join(", ")}${more ? ` and ${more} more` : ""}. Make it again.`;
}

interface Laid {
  sheet: string;
  row: number;
  col: number;
  put: SheetCellJson | null;
  under: SheetCellJson | null;
}

export class SheetSync {
  state: SheetSyncState = { view: null, failed: null, book: null, sendError: null, saving: false, savedAt: null, reloading: false, stopped: null, current: 0, tick: 0 };
  /** the op the grid stands at */
  rev = 0;
  private readonly mine = new Set<number>();
  private queue: SheetMutationJson[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private grid: GridLink | null = null;
  private offGrid: (() => void) | null = null;
  /** takes in the mutations of the command in hand now, before a send */
  private settle: (() => void) | null = null;
  /** the grid is taking a stopped change back */
  private reverting = false;
  private offPush: (() => void) | null = null;
  /** ops landed while no grid was up: brought in when one is */
  private behind = false;
  private laid = new Map<string, Laid>();
  private readonly listeners = new Set<() => void>();
  private live = 0;
  private books = 0;
  /** the bytes of pictures made here, until the grid lets go */
  private made = new MadePictures();
  /** the made pictures whose bytes the host has: a list sends them no more */
  private sentMedia = new Set<string>();
  /** the file's names for the objects this grid made, which keeps its own (its Undo names them so) */
  private fileIds = new FileIds();
  /** the chart and picture lists of the turn in hand: sent after its other mutations (a row put in, then the list it left) */
  private pendingObjects: SheetMutationJson[] = [];
  /** gathers the turn in hand, while a grid is up */
  private gather: (() => void) | null = null;
  /** ops from elsewhere are being laid on the grid: the objects it moves under them are not his change */
  private applying = false;
  /** each edit of his dropped or refused on its way (said once then), and why: what an action waiting on `written` reads */
  private lost = { n: 0, why: "" };

  constructor(
    readonly host: SheetHost,
    private readonly decode: Decode,
  ) {}

  get = (): SheetSyncState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(patch: Partial<SheetSyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Opens the item and loads its workbook; what it returns lets go. A body that comes back opens it again. */
  start(): () => void {
    if (this.live++ === 0) {
      this.offPush = this.host.onPush((push) => this.pushed(push));
      void this.open();
    }
    return () => {
      if (--this.live > 0) return;
      this.offPush?.();
      this.offPush = null;
      this.flush();
    };
  }

  /** Opens again from nothing: Retry after a failure. */
  async open(): Promise<void> {
    this.set({ failed: null });
    try {
      const view = await this.host.open();
      this.view(view);
      await this.load(view.rev);
    } catch (error) {
      this.set({ failed: message(error, "The host did not answer") });
    }
  }

  private async load(rev: number): Promise<void> {
    const parts: Uint8Array[] = [];
    let size = Infinity;
    let at = 0;
    let format: "xlsx" | "snapshot" = "snapshot";
    let stood = rev;
    while (at < size) {
      const frame = await this.host.load(rev, at, LOAD_MAX);
      const bytes = fromBase64(frame.data);
      size = frame.size;
      format = frame.format;
      stood = frame.rev;
      parts.push(bytes);
      at += bytes.length;
      if (bytes.length === 0) break;
    }
    const whole = new Uint8Array(at);
    let offset = 0;
    for (const part of parts) {
      whole.set(part, offset);
      offset += part.length;
    }
    const book = await this.decode(whole, format);
    this.rev = stood;
    this.mine.clear();
    this.queue = [];
    this.detach();
    this.made = new MadePictures();
    this.sentMedia = new Set();
    this.fileIds = new FileIds();
    this.pendingObjects = [];
    this.set({ book: { ...book, key: ++this.books } });
  }

  /** A new view: the stepper stays on its change where it can, and the cells follow the suggestions. */
  view(view: SheetView): void {
    this.set({ view });
    this.lay();
  }

  private pushed(push: SheetPushed): void {
    if (push.view) this.view(push.view);
    // A sheet others can open: the host sends no view, and answers each caller its own.
    else if (push.stale) this.run(async () => this.view(await this.host.open()));
    if (push.rev > this.rev) this.run(async () => void (await this.catchUp()));
  }

  /** The grid is up: edits go out from it and what landed comes in. What it returns lets go. */
  attach(grid: GridLink): () => void {
    this.detach();
    this.grid = grid;
    // What he does in one turn is taken together: its commands are counted and their mutations gathered, so a
    // turn with a part the store cannot keep is stopped whole and nothing of it is sent.
    let group: SheetMutationJson[] = [];
    let stop: string | null = null;
    // A move's turn: the move alone is sent. What else the turn did (the formulas, merges, rules and notes the grid moved
    // beside it) the host's LibreOffice does to the file itself, and every grid then reads the file again.
    let moves: SheetMutationJson[] = [];
    let moveStop: string | null = null;
    let commands = 0;
    let gathering = false;
    const settle = (): void => {
      gathering = false;
      // The turn's chart and picture lists go after its other mutations: rows put in first, then the lists they left.
      const lists = this.pendingObjects.splice(0);
      const moved = moves.length > 0 || moveStop !== null;
      const taken = moved ? moves : group;
      const why = moved ? moveStop : stop;
      const ran = commands;
      group = [];
      stop = null;
      moves = [];
      moveStop = null;
      commands = 0;
      if (why) return this.stop(grid, why, grid.onCommand ? ran : 1);
      if (lists.length) {
        const keys = new Set(lists.map(listKey));
        this.queue = this.queue.filter((m) => !isObjectList(m) || !keys.has(listKey(m)));
      }
      if (taken.length === 0) {
        if (!lists.length) return;
        this.queue.push(...lists);
        this.set({ saving: true });
        this.wait();
        return;
      }
      if (moved) {
        // A move goes now, by itself (`batch`), and the grid takes no edit until the host has answered: the host may still
        // refuse it (a table it would cut, a formula that reads where it lands), and an edit made on a move the file never
        // took would be lost with it or written into another cell.
        this.queue.push(...taken, ...lists);
        this.set({ tick: this.state.tick + 1, saving: true, reloading: true });
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.run(() => this.send());
        return;
      }
      this.queue.push(...latestRules([...taken, ...lists]));
      this.set({ tick: this.state.tick + 1, saving: true });
      if (this.queue.length >= EDIT_MAX) this.flush();
      else this.wait();
    };
    this.settle = settle;
    const gather = (): void => {
      if (gathering) return;
      gathering = true;
      queueMicrotask(settle);
    };
    this.gather = gather;
    const offCommand = grid.onCommand?.(() => {
      if (this.reverting) return;
      commands++;
      gather();
    });
    const offMutation = grid.onMutation((mutation) => {
      // What the grid does to take a stopped change back is not his edit, and neither is a change to another unit: the
      // cell editor's own document takes each key he types (`doc.mutation.rich-text-editing`), and what he commits
      // comes as the workbook's own mutation.
      if (BOOKKEEPING.has(mutation.id) || this.reverting || !ofUnit(mutation, grid.unitId)) return;
      const view = this.state.view;
      if (view?.store === "package") {
        const got = forPackage(mutation, (sheet, row, col) => grid.formula(sheet, row, col), {
          formats: (view.row?.length ?? 0) > 0,
          google: view.reach?.to === "google",
          ...(grid.style ? { style: (id: string) => grid.style!(id) } : {}),
          ...(grid.rules ? { rules: (kind: SheetRuleKind, sheet?: string) => grid.rules!(kind, sheet), kinds: ruleKinds(view.row) } : {}),
          moves: view.moves === true,
          // A rich cell's document as the grid holds it now (a style set over one changes its runs), and what its notes take.
          doc: (sheet: string, row: number, col: number) => (grid.read(sheet, row, col) as { p?: unknown } | null)?.p ?? null,
          ...(view.notes ? { notes: view.notes } : {}),
        });
        if (SHEET_MOVES.has(mutation.id)) {
          if ("stop" in got) moveStop ??= got.stop;
          else moves.push(...got.keep);
        } else if ("stop" in got) stop ??= got.stop;
        else group.push(...got.keep);
      } else if (mutation.id !== AUTO_FIT) group.push(mutation);
      gather();
    });
    const off = (): void => {
      offCommand?.();
      offMutation();
    };
    this.offGrid = () => {
      off();
      if (this.grid === grid) this.grid = null;
    };
    this.lay();
    if (this.behind) this.run(async () => void (await this.catchUp()));
    return () => {
      settle();
      this.flush();
      this.detach();
    };
  }

  /**
   * Takes a change back in the grid as he makes it, and says why once. `commands` is how many commands the turn
   * ran: one is the usual press, taken back by one undo. Anything else (a press that ran several commands, or
   * mutations that came with no command of their own: the tail of one that began in an earlier turn) is undone as
   * far as it can be and the book is then read again from its store, so the grid is the file whatever the grid
   * made of the undo.
   */
  private stop(grid: GridLink, why: string, commands: number): void {
    this.reverting = true;
    // The grid is locked from the stop until the book is drawn again: an edit made in between would be in neither.
    if (commands !== 1) this.set({ reloading: true });
    const done = (): void => {
      this.reverting = false;
      if (commands !== 1)
        this.run(async () => {
          try {
            await this.send();
            await this.open();
          } finally {
            this.set({ reloading: false });
          }
        });
    };
    const undo = async (): Promise<void> => {
      for (let i = 0; i < Math.max(1, commands); i++) await grid.undo();
    };
    void undo().then(done, done);
    this.set({ stopped: { why, n: (this.state.stopped?.n ?? 0) + 1 } });
  }

  /**
   * A press that hands the item to another file (Save as Excel reseats the tab on the .xlsx): his last edit reaches the
   * file first, and the grid takes none until the host has answered, since one made meanwhile would be in neither. The
   * open cell is ended before the lock, which would refuse it.
   */
  async handOver<T>(work: () => Promise<T>): Promise<T> {
    await this.endEditor();
    this.set({ reloading: true });
    try {
      await this.written();
      return await work();
    } finally {
      this.set({ reloading: false });
    }
  }

  /** An edit of his that will not reach the file: counted for what waits on `written`. */
  private drop(why: string): void {
    this.lost = { n: this.lost.n + 1, why };
  }

  private detach(): void {
    this.offGrid?.();
    this.offGrid = null;
    this.settle = null;
    this.gather = null;
    this.grid = null;
    this.laid = new Map();
  }

  private wait(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), EDIT_WAIT);
  }

  /** Sends what has gathered now. */
  flush(): void {
    this.settle?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.length > 0) this.run(() => this.send());
  }

  /**
   * Sends what has gathered and settles once the host has answered every send under way: a tab's close awaits it
   * (canvas/flush.ts), so his last edit is in the file before the item goes, never sent after it to a sheet that is gone.
   * A cell still open in the grid's editor is ended first, keeping what he typed: it is an edit he made.
   */
  async flushed(): Promise<boolean> {
    const ended = await this.endEditor();
    this.flush();
    await this.chain;
    return ended;
  }

  /** Ends a cell still open in the grid's editor, keeping what he typed: false when it stays open or could not be ended. */
  private async endEditor(): Promise<boolean> {
    try {
      return (await this.grid?.commit?.()) !== false;
    } catch {
      return false;
    }
  }

  /**
   * Settles once every edit of his is in the file, or rejects in his words when one is not: what reads the file
   * (Preview, Save back, Save as Excel, the switch that replaces the item) waits on it, so it never reads the workbook
   * without an edit he made, dropped on its way or refused. What would be lost with the tab (an open cell the grid kept
   * open, edits waiting for Retry) refuses its close too (`CloseRefused`); an edit that can no longer be saved does not.
   */
  async written(): Promise<void> {
    const lost = this.lost.n;
    if (!(await this.flushed())) throw new CloseRefused("The cell being typed in is not saved yet: finish it, or press Esc to drop it");
    const error = this.state.sendError;
    if (error && this.queue.length > 0) throw new CloseRefused(`An edit is not saved yet: ${error}. Retry it first`);
    if (error) throw new Error(`An edit is not saved: ${error}`);
    if (this.lost.n !== lost) throw new Error(`An edit is not saved: ${this.lost.why}`);
  }

  /**
   * After a save that failed. An opened Excel file refuses a batch for good
   * (a locked cell, a change it cannot keep), so its grid holds an edit the
   * file does not: it is loaded again and the edits that wait are dropped.
   * Elsewhere the edits go again, or with none waiting the view is read again
   * to see whether the host's save still fails.
   */
  retry(): void {
    this.set({ sendError: null });
    if (this.state.view?.store === "package") {
      this.queue = [];
      this.run(() => this.open());
    } else if (this.queue.length > 0) this.flush();
    else this.run(async () => this.view(await this.host.open()));
  }

  /** One thing at a time with the host, in order: a send, a catch-up, a load. */
  private run(work: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(work).catch(() => undefined);
    return this.chain;
  }

  /** The next batch to send. A move goes by itself: what he did before it first, then the move alone, so the host takes or refuses it whole and nothing else with it. */
  private batch(): SheetMutationJson[] {
    const move = this.queue.findIndex((m) => SHEET_MOVES.has(m.id));
    return this.queue.splice(0, move === 0 ? 1 : move > 0 ? Math.min(move, EDIT_MAX) : EDIT_MAX);
  }

  private async send(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.batch();
    const move = SHEET_MOVES.has(batch[0]!.id);
    // A receipt past an op the grid has not laid (someone's that landed between): caught up before what comes next.
    let behind = false;
    try {
      for (let tries = 0; ; tries++) {
        // A chart or picture list is the tab's as the grid holds it at the send: one queued before a conflict's catch-up
        // goes as the grid now has it, under the names the file gave its objects.
        const sent = batch.map((m) => (isObjectList(m) ? this.fileIds.out(this.fresh(m)) : m));
        const answer = await this.host.edit(this.rev, sent);
        if (!answer.conflict) {
          this.mine.add(answer.rev);
          // The receipt is not the grid's revision: the grid stands at it only when nothing landed between, else it
          // catches up (passing its own), so it shows theirs and a list it sends next is made over theirs.
          if (answer.rev <= this.rev + 1) this.rev = Math.max(this.rev, answer.rev);
          else behind = true;
          for (const m of sent) if (isObjectList(m)) for (const [part] of listMedia(m)) this.sentMedia.add(part);
          if (answer.ids) this.rekey(answer.ids);
          break;
        }
        if (tries + 1 >= CONFLICT_TRIES) throw new Error("Others kept changing the sheet; your edits did not save");
        // A move is made on the sheet as he saw it: once the sheet changed under it, its rows and columns name other cells. It is not sent again.
        if (move) throw new Error("The sheet changed under that move. Make it again");
        // A conflict the grid can only answer by reading the file again (it changed outside TempCode, was restored, or
        // its rows moved): the batch names cells of a sheet that is gone, so it is not sent again. He is told what it held.
        if (await this.catchUp(batch)) return;
      }
      if (behind) await this.catchUp();
      // (an opened Excel file's refused batch is still not in the file: its line stays until Reload makes the grid the file again)
      if (this.state.sendError && this.state.view?.store !== "package") this.set({ sendError: null });
      if (this.queue.length === 0) this.set({ saving: false, savedAt: Date.now() });
    } catch (error) {
      // An opened Excel file refuses a batch for good: it is not sent again, and the edits after it go on. Reload makes the grid the file again.
      if (this.state.view?.store !== "package") {
        this.queue.unshift(...batch);
        this.set({ sendError: message(error, "The host did not answer"), saving: false });
        return;
      }
      if (batch.some(isObjectList)) {
        // A chart or picture the file's writer refused (a protected sheet, a range it cannot name, a kind it cannot make):
        // said once, as a change stopped at the press, and the book read again from the file so the object is as it was.
        // What waits after it goes first.
        this.set({ reloading: true, stopped: { why: message(error, "The host did not answer"), n: (this.state.stopped?.n ?? 0) + 1 } });
        this.drop(message(error, "The host did not answer"));
        try {
          if (this.queue.length > 0) await this.send();
          await this.open();
        } finally {
          this.set({ reloading: false, saving: false });
        }
        return;
      }
      if (move) {
        // A move the file did not take: the grid shows cells where the file has none, so the canvas takes it back itself.
        // The words are said once, as for a change stopped at the press, and the book is read again from its file.
        this.queue = [];
        this.set({ saving: false, stopped: { why: message(error, "The host did not answer"), n: (this.state.stopped?.n ?? 0) + 1 } });
        this.drop(message(error, "The host did not answer"));
        // (the grid is let go whether or not the book could be read again: a host that is gone must not leave it locked)
        try {
          await this.open();
        } finally {
          this.set({ reloading: false });
        }
        return;
      }
      this.set({ sendError: message(error, "The host did not answer"), saving: this.queue.length > 0 });
    }
    if (move) {
      // A move the file took: LibreOffice and the graft wrote it, not Univer, so the grid that made it reads the file
      // again too (a rule's ranges or a chart's may differ from Univer's picture, and his next change would send that).
      try {
        await this.open();
      } finally {
        this.set({ reloading: false });
      }
    }
    if (this.queue.length > 0) await this.send();
  }

  /**
   * Brings in what landed after the revision the grid stands at, but not the ops this canvas sent. Answers whether the
   * grid read the file again. `refused`: the batch the host just answered with a conflict.
   */
  private async catchUp(refused?: SheetMutationJson[]): Promise<boolean> {
    const grid = this.grid;
    if (!grid) {
      this.behind = true;
      return false;
    }
    this.behind = false;
    const answer = await this.host.since(this.rev);
    if ("reload" in answer) {
      // A cell still open in the editor is ended first, keeping what he typed, against the book it was typed on: it goes
      // with what waits (or is named with it below). The workbook is not yet locked, which would refuse the end.
      const ended = await this.endEditor();
      // The grid takes no edit until the file is drawn again: one made meanwhile would be in neither.
      this.set({ reloading: true });
      try {
        this.settle?.();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        const books = this.books;
        if (refused) {
          // After a conflict, what waits was made on the same sheet the refused batch was: none of it is sent.
          const lost = [...refused, ...this.queue];
          this.queue = [];
          this.set({ saving: false, stopped: { why: notSavedWords(lost, (id) => grid.objects?.sheetName(id) ?? this.state.book?.workbook.sheets?.[id]?.name), n: (this.state.stopped?.n ?? 0) + 1 } });
          this.drop("the file changed before it was saved");
        } else {
          // What waits goes first: the host moves an edit through what it missed (a rule's list, a shared workbook's
          // edit), and refuses one the file can no longer take, which is then said (above).
          await this.send();
        }
        // A cell the grid kept open (it refused the value) is gone with the book: said once.
        if (!ended) {
          this.set({ stopped: { why: "The file was read again while a cell was open, so what was typed there is not saved. Type it again.", n: (this.state.stopped?.n ?? 0) + 1 } });
          this.drop("a cell was open as the file was read again");
        }
        // (a send that met a conflict has read the file again already)
        if (this.books === books) await this.load(answer.rev);
      } finally {
        this.set({ reloading: false });
      }
      return true;
    }
    for (const op of answer.ops) {
      if (op.rev <= this.rev) continue;
      if (!this.mine.has(op.rev)) this.applyFrom(grid, op.mutations);
      this.rev = op.rev;
    }
    this.rev = Math.max(this.rev, answer.rev);
    this.set({ tick: this.state.tick + 1 });
    return false;
  }

  /**
   * Lays each open suggestion's value into its cell and takes back the
   * ones no longer open. A cell is put back only while it still holds what
   * was laid there: an op or an edit that wrote it since stands.
   */
  private lay(): void {
    const grid = this.grid;
    if (!grid) return;
    const want = new Map<string, SheetView["suggestions"][number]>();
    for (const s of this.state.view?.suggestions ?? []) if (s.state === "pending" || s.state === "conflict") want.set(`${s.id}\n${s.sheet}\n${s.row}\n${s.col}`, s);
    const mutations: SheetMutationJson[] = [];
    const write = (sheet: string, row: number, col: number, value: SheetCellJson | null): void => {
      mutations.push({ id: SET_RANGE_VALUES, params: { unitId: grid.unitId, subUnitId: sheet, cellValue: { [row]: { [col]: value } } } });
    };
    for (const [key, laid] of this.laid) {
      if (want.has(key)) continue;
      this.laid.delete(key);
      if (holds(grid.read(laid.sheet, laid.row, laid.col), laid.put)) write(laid.sheet, laid.row, laid.col, laid.under ? ({ ...CLEAR, ...laid.under } as SheetCellJson) : null);
    }
    for (const [key, s] of want) {
      if (this.laid.has(key)) continue;
      const under = grid.read(s.sheet, s.row, s.col);
      this.laid.set(key, { sheet: s.sheet, row: s.row, col: s.col, put: s.proposed, under });
      write(s.sheet, s.row, s.col, s.proposed);
    }
    if (mutations.length === 0) return;
    grid.apply(mutations);
    this.set({ tick: this.state.tick + 1 });
  }

  /** What a suggestion laid at this cell replaces, in words ("was 412"), or undefined when none is laid there. */
  was(sheet: string, row: number, col: number): string | undefined {
    for (const laid of this.laid.values()) if (laid.sheet === sheet && laid.row === row && laid.col === col) return `was ${cellText(laid.under)}`;
    return undefined;
  }

  step(to: number): void {
    this.set({ current: to });
  }

  /**
   * A change to the grid's charts or pictures. Where the host keeps them (its row lists `objects`), the
   * tab's whole list goes in the change's place, replacing one of the same tab that waits to be sent.
   */
  object(change: ObjectChange): void {
    this.made.take(change);
    const grid = this.grid;
    const view = this.state.view;
    if (!grid?.objects || !view?.row?.includes("objects")) return;
    // Objects moved under rows and columns: an Excel file's own writer moves its drawings, and what the grid laid from
    // elsewhere moved them on the host already. A sheet the service holds takes his own grid's list after his rows.
    if (change.cause === "cells" && (view.store === "package" || this.applying)) return;
    const objects = grid.objects;
    const list = objectListOf(change, objects.list(), (name) => objects.sheetId(name), (part) => this.bytesToSend(part), true);
    if (!list) return;
    this.pendingObjects = [...this.pendingObjects.filter((m) => listKey(m) !== listKey(list)), list];
    this.gather?.();
  }

  /** A made picture's bytes while the host does not have them. */
  private bytesToSend(part: string): Uint8Array | undefined {
    return this.sentMedia.has(part) ? undefined : this.made.get(part)?.bytes;
  }

  /** A queued chart or picture list as the grid holds that tab now; anything else as it is. */
  private fresh(m: SheetMutationJson): SheetMutationJson {
    const objects = this.grid?.objects;
    if (!objects || !isObjectList(m)) return m;
    const p = m.params as RulesSetParams;
    const tab = objects.sheetName(p.subUnitId ?? "");
    return tab === undefined ? m : tabList(p.kind as "charts" | "pictures", p.subUnitId!, tab, objects.list(), (part) => this.bytesToSend(part));
  }

  /** Ops from elsewhere laid on the grid: a chart or picture list on its objects (the bytes it carries kept to draw), the rest on its cells. */
  private applyFrom(grid: GridLink, mutations: readonly SheetMutationJson[]): void {
    this.applying = true;
    try {
      let cells: SheetMutationJson[] = [];
      const flush = (): void => {
        if (cells.length) grid.apply(cells.map((m) => inUnit(m, grid.unitId)));
        cells = [];
      };
      for (const m of mutations) {
        if (!isObjectList(m)) {
          cells.push(m);
          continue;
        }
        flush();
        const tab = grid.objects?.sheetName((m.params as RulesSetParams).subUnitId ?? "");
        if (!grid.objects || tab === undefined) continue;
        for (const [part, media] of listMedia(m)) {
          this.made.keep(part, media);
          this.sentMedia.add(part);
        }
        grid.objects.apply(listChanges(grid.objects.list(), this.fileIds.in(m), tab));
      }
      flush();
    } finally {
      this.applying = false;
    }
  }

  /** A picture's bytes by its part, for the grid to draw: the file's own as it was read, or one made here. */
  media = async (part: string): Promise<Blob> => {
    const got = this.state.book?.media?.get(part) ?? this.made.get(part);
    if (!got) throw new Error("That picture is not in the file.");
    return new Blob([got.bytes as BlobPart], { type: got.type });
  };

  /**
   * A save named objects anew: the grid keeps its own ids (its Undo and Redo name each object by them) and the next
   * list names them as the file does, a picture by the file's part.
   */
  private rekey(ids: ObjectIds): void {
    const objects = this.grid?.objects;
    if (objects) this.fileIds.take(objects.list(), ids);
  }
}

/** A chart or picture list's kind and tab: one list a tab waits to be sent. */
const listKey = (m: SheetMutationJson): string => `${(m.params as RulesSetParams).kind}\u0000${(m.params as RulesSetParams).subUnitId}`;

export const useSheetSync = (sync: SheetSync): SheetSyncState => useSyncExternalStore(sync.subscribe, sync.get, sync.get);

const syncs = new Map<string, SheetSync>();

/** The one sync of an item in this window, shared by its body, bar and tab-row parts. */
export function syncOf(key: string, make: () => SheetSync): SheetSync {
  let sync = syncs.get(key);
  if (!sync) {
    sync = make();
    syncs.set(key, sync);
  }
  return sync;
}

/** For tests and previews: every item starts again. */
export function resetSheetSyncs(): void {
  syncs.clear();
}
