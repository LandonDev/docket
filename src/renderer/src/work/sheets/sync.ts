import { useSyncExternalStore } from "react";
import type { SheetCellJson, SheetMutationJson, SheetView } from "@shared/contract-work-sheets";
import type { ObjectChange, SheetObjects } from "work-kit/sheet";
import { AUTO_FIT, forPackage, isObjectList, latestRules, ruleKinds, SHEET_MOVES, sheetStopWords, type ObjectIds, type RulesSetParams, type SheetRuleKind } from "@shared/work/sheets";
import { cellText, holds } from "./model";
import { FileIds, listChanges, listMedia, MadePictures, objectListOf, pictureAdded, tabList } from "./objects";
import { EDIT_MAX, fromBase64, LOAD_MAX, type LoadAnswer, type SheetHost, type SheetPushed } from "./host";
import type { Draft } from "@shared/work/drafts";
import type { DraftJournal } from "../canvas/drafts";
import { CloseRefused } from "../canvas/flush";
import { onItemsGone } from "../canvas/gone";

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
  /** the save line's clock (canvas/calm.ts): when his last edit not yet sent was made, and when the run of sends now out began; null when none */
  editedAt: number | null;
  sentAt: number | null;
  /** the book is being read again from its store after a stop, or a move is on its way to the host: the grid takes no edit until it is drawn or the host has answered */
  reloading: boolean;
  /** a change the sheet's store cannot keep was stopped as he made it: why, in the words he reads, and which time (so the same words twice are said twice) */
  stopped: { why: string; n: number } | null;
  /** the change the stepper is on */
  current: number;
  /** goes up whenever a cell changes, for what reads the grid (a chart) */
  tick: number;
  /** a book of more than one piece is on its way: the bytes read of it so far, of its size; null otherwise */
  loading: { at: number; size: number } | null;
  /**
   * Edits of his a window kept on this computer and the host never answered (canvas/drafts.ts), offered as the sheet
   * opens: `same` when the file is still at the revision they were made on (Restore sends them as a live edit), else
   * the file changed since and they are offered to copy, never laid over it. The grid takes no edit until he answers.
   */
  offer?: { at: number; same: boolean; cells: string[] } | null;
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
/** How many of a book's pieces after the first are asked for at once. */
export const LOAD_AT_ONCE = 3;
/** How many books of tabs not shown are kept, so a tab shown again draws its book without reading it again. */
export const KEPT_BOOKS = 2;
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
  const cells = cellsOf(batch);
  const moves = batch.filter((m) => SHEET_MOVES.has(m.id)).length;
  const moved = moves === 1 ? "a move" : moves > 1 ? `${moves} moves` : "";
  if (!cells.length) return moved ? `The file changed before ${moved === "a move" ? "your move was" : "your moves were"} saved, so ${moves === 1 ? "it was" : "they were"} not made. Make ${moves === 1 ? "it" : "them"} again.` : "The file changed before your last change was saved, so it was not made. Make it again.";
  const many = new Set(cells.map((x) => x.sheet)).size > 1;
  const named = cells.slice(0, NAMED_MOST).map((x) => `${many ? `${sheetName(x.sheet) ?? x.sheet}!` : ""}${x.at} ${x.put}`);
  const more = cells.length - named.length;
  return `The file changed before this was saved: ${named.join(", ")}${more ? ` and ${more} more` : ""}${moved ? `, and ${moved}` : ""}. Make it again.`;
}

/** A kept draft's cells as lines to copy: "Sheet1!A1<tab>42", each he wrote, what he put in it whole. */
export function draftCellLines(batch: readonly SheetMutationJson[], sheetName: (id: string) => string | undefined): string[] {
  return cellsOf(batch, Infinity).map((x) => `${sheetName(x.sheet) ?? x.sheet}!${x.at}\t${x.put === "cleared" ? "" : x.put}`);
}

/** Each cell a batch writes and what it puts there, cut at `cut` characters. */
function cellsOf(batch: readonly SheetMutationJson[], cut = 40): { sheet: string; at: string; put: string }[] {
  const cells: { sheet: string; at: string; put: string }[] = [];
  for (const m of batch) {
    if (m.id !== SET_RANGE_VALUES) continue;
    const p = m.params as { subUnitId?: string; cellValue?: Record<string, Record<string, (SheetCellJson & { p?: { body?: { dataStream?: string } } }) | null>> };
    for (const [r, cols] of Object.entries(p.cellValue ?? {}))
      for (const [c, cell] of Object.entries(cols ?? {})) {
        // (a style alone keeps what the cell held)
        if (cell && !("v" in cell) && !("f" in cell) && !("p" in cell)) continue;
        const text = cell?.f ?? cell?.p?.body?.dataStream?.replace(/[\r\n]+$/, "") ?? (cell?.v === null || cell?.v === undefined ? "" : String(cell.v));
        const put = text === "" ? "cleared" : text.length > cut ? `${text.slice(0, cut - 1)}…` : text;
        cells.push({ sheet: p.subUnitId ?? "", at: `${columnName(Number(c))}${Number(r) + 1}`, put });
      }
  }
  return cells;
}

interface Laid {
  sheet: string;
  row: number;
  col: number;
  put: SheetCellJson | null;
  under: SheetCellJson | null;
}

export class SheetSync {
  state: SheetSyncState = { view: null, failed: null, book: null, sendError: null, saving: false, savedAt: null, editedAt: null, sentAt: null, reloading: false, stopped: null, current: 0, tick: 0, loading: null };
  /** the op the grid stands at */
  rev = 0;
  /** a shared .csv's cache the grid drew (its load's `gen`): its edits and catch-ups name it, so the host answers for this draw */
  private gen: string | undefined;
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
  /** goes up with every open or load begun: only the newest may land (sol S6), whatever the body's mounts meanwhile */
  private loads = 0;
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
  /** how many hold the grid still (`lock`) */
  private locks = 0;
  /** a catch-up that is owed: one that failed, or a reload put off while an edit waits for Retry */
  private owed = false;
  /** each edit of his dropped or refused on its way (said once then), and why: what an action waiting on `written` reads */
  private lost = { n: 0, why: "" };
  /**
   * The book as it was read, at the revision it stands at, never handed to a grid: a grid changes the workbook it draws
   * in place, so each one draws a copy (`drawn`), and a tab shown again draws this one again without reading it.
   */
  private kept: { book: Book; rev: number; gen?: string } | null = null;
  /** work under way in `run` */
  private busy = 0;
  /** its item closed while a body still held it: let go at the release */
  gone = false;
  /** where his unanswered edits are kept on this computer; null where there is no store */
  private journal: DraftJournal | null = null;
  /** the batch on its way to the host: his until it answers */
  private inflight: SheetMutationJson[] = [];
  /** the draft offered as the sheet opened, until he answers it */
  private offered: Draft | null = null;
  private looked = false;

  constructor(
    readonly host: SheetHost,
    private readonly decode: Decode,
  ) {}

  get = (): SheetSyncState => this.state;
  /** A body shows the item now. */
  isShown = (): boolean => this.live > 0;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(patch: Partial<SheetSyncState>): void {
    // Nothing of his waits or is on its way: the line's clock stops.
    if (patch.saving === false) patch = { ...patch, editedAt: null, sentAt: null };
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * Opens the item and loads its workbook; what it returns lets go. A body that comes back to a book still kept draws
   * it again and asks only what landed since (`work.sheets.since`), reading the file again only when the host says to.
   */
  start(): () => void {
    if (this.live++ === 0) {
      unkeep(this);
      this.listen();
      if (this.kept) this.again();
      else void this.open();
    }
    return () => {
      if (--this.live > 0) return;
      this.flush();
      // Gone with edits the host has not answered: they are offered when the file opens again.
      if (this.gone && this.journal?.holding) void this.chain.then(() => this.journal?.release());
      if (this.gone) forget(this);
      else if (this.kept) keep(this);
      else this.dropBook();
    };
  }

  /** Follows what lands on the item: while a body shows it, and while its book is kept. */
  private listen(): void {
    this.offPush ??= this.host.onPush((push) => this.pushed(push));
  }

  /** Opens again from nothing: Retry after a failure. */
  async open(): Promise<void> {
    const mine = ++this.loads;
    try {
      // The first piece of the book comes with the view (`first`), so a book of one piece is one request. A failure
      // already said stays until the host answers (his Retry spins meanwhile), never bones in its place.
      const { first, ...view } = await this.host.open(true);
      // An open begun later (the tab shown again) answers for the item now (sol S6).
      if (mine !== this.loads) return;
      this.set({ failed: null });
      this.view(view);
      await this.load(view.rev, first, mine);
      void this.lookForDrafts();
    } catch (error) {
      if (mine === this.loads) this.set({ failed: message(error, "The host did not answer"), loading: null });
    }
  }

  /**
   * Reads the book at `rev`: its first piece (carried by the open when it came with it), then the rest a few at a time,
   * each into its place, with what has come said for a book of more than one piece.
   */
  private async load(rev: number, first?: LoadAnswer, mine = ++this.loads): Promise<void> {
    const head = first && first.rev === rev ? first : await this.host.load(rev, 0, LOAD_MAX);
    const start = fromBase64(head.data);
    const size = Math.max(head.size, start.length);
    const whole = new Uint8Array(size);
    whole.set(start, 0);
    const offsets: number[] = [];
    if (start.length > 0) for (let at = start.length; at < size; at += LOAD_MAX) offsets.push(at);
    let got = start.length;
    if (offsets.length) this.set({ loading: { at: got, size } });
    try {
      await inTurns(offsets, LOAD_AT_ONCE, async (at) => {
        const bytes = fromBase64((await this.host.load(rev, at, LOAD_MAX)).data);
        if (bytes.length !== Math.min(LOAD_MAX, size - at)) throw new Error("The workbook did not come whole. Try again");
        whole.set(bytes, at);
        got += bytes.length;
        this.set({ loading: { at: got, size } });
      });
    } finally {
      if (this.state.loading) this.set({ loading: null });
    }
    const book = await this.decode(got === size ? whole : whole.subarray(0, got), head.format);
    // No body shows the item now (its tab went while the book came): the book is not kept, so it never sits outside
    // the two kept ones (sol S6); a body that comes back reads the file again.
    // A newer load begun meanwhile (the tab shown again) has its own book: this one would replace it and drop the edits
    // made on it (sol S6).
    if (!this.isShown() || mine !== this.loads) return;
    this.kept = { book, rev: head.rev, ...(head.gen ? { gen: head.gen } : {}) };
    this.reset(head.rev, head.gen);
    this.set({ book: this.drawn() });
  }

  /** What a grid drawn afresh starts from: the revision of the book it draws, and nothing of the last grid's. */
  private reset(rev: number, gen?: string): void {
    this.rev = rev;
    this.gen = gen;
    this.mine.clear();
    this.dropQueue();
    this.detach();
    this.made = new MadePictures();
    this.sentMedia = new Set();
    this.fileIds = new FileIds();
    this.pendingObjects = [];
  }

  /** The kept book as the next grid draws it: a copy of its workbook and objects, which that grid may change. */
  private drawn(): Book & { key: number } {
    const { book } = this.kept!;
    return { ...book, workbook: structuredClone(book.workbook), ...(book.objects ? { objects: structuredClone(book.objects) } : {}), key: ++this.books };
  }

  /**
   * A body came back to a kept book. It is drawn again once nothing is on its way (a send of the last grid's edits lands
   * first), and the grid then asks what landed since the book's revision, his own edits among them, since the copy holds
   * none of them. Edits that wait to be sent, or a grid held still, read the file again instead.
   */
  private again(): void {
    const redraw = async (): Promise<void> => {
      if (!this.kept || this.queue.length > 0 || this.state.sendError || this.locks > 0 || this.state.failed) return this.open();
      // The kept book is the newest now: an open still out from before (a Retry he pressed and left) lands nothing
      // over it (sol S6); the grid's catch-up from the book's revision brings it current.
      ++this.loads;
      this.reset(this.kept.rev, this.kept.gen);
      this.owed = false;
      this.behind = true;
      this.set({ book: this.drawn() });
    };
    if (this.busy === 0) void redraw();
    else {
      this.set({ book: null });
      void this.run(redraw);
    }
  }

  /** The kept book goes, and with it what follows the item: the next body reads the file again. */
  dropBook(): void {
    this.offPush?.();
    this.offPush = null;
    this.kept = null;
    if (this.state.book) this.set({ book: null });
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
        this.note();
        this.set({ saving: true, editedAt: Date.now() });
        this.wait();
        return;
      }
      if (moved) {
        // A move goes now, by itself (`batch`), and the grid takes no edit until the host has answered: the host may still
        // refuse it (a table it would cut, a formula that reads where it lands), and an edit made on a move the file never
        // took would be lost with it or written into another cell.
        this.queue.push(...taken, ...lists);
        this.note();
        this.lock();
        this.set({ tick: this.state.tick + 1, saving: true });
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.run(() => this.send());
        return;
      }
      this.queue.push(...latestRules([...taken, ...lists]));
      this.note();
      this.set({ tick: this.state.tick + 1, saving: true, editedAt: Date.now() });
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
    if (commands !== 1) this.lock();
    const done = (): void => {
      this.reverting = false;
      if (commands !== 1)
        this.run(async () => {
          try {
            await this.send();
            await this.open();
          } finally {
            this.unlock();
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
    this.lock();
    try {
      await this.written();
      return await work();
    } finally {
      this.unlock();
    }
  }

  /**
   * The grid takes no edit while anything holds it (a reload, a move on its way, a press handing the item over): each
   * holder takes a lock and lets its own go, so one that ends first never frees the grid under another.
   */
  private lock(): void {
    if (this.locks++ === 0) this.set({ reloading: true });
  }
  private unlock(): void {
    if (this.locks > 0 && --this.locks === 0) this.set({ reloading: false });
  }

  /**
   * Empties the queue without sending it, and answers what it held. A move waiting in it held the grid still until its
   * send (`lock`): dropped unsent, its lock is let go here, so the grid never stays still for a move that will not go.
   */
  private dropQueue(): SheetMutationJson[] {
    const dropped = this.queue;
    this.queue = [];
    for (const m of dropped) if (SHEET_MOVES.has(m.id)) this.unlock();
    this.note();
    return dropped;
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
      this.dropQueue();
      this.run(() => this.open());
    } else if (this.queue.length > 0) this.flush();
    else this.run(async () => this.view(await this.host.open()));
  }

  /** What the host has not answered, kept on this computer by the revision it was made on; nothing once all is answered. */
  private note(): void {
    const all = [...this.inflight, ...this.queue];
    this.journal?.keep(String(this.rev), all.length ? { kind: "sheet", mutations: all } : null);
  }

  /** Where his unanswered edits are kept (SheetBody, as the item is drawn); a book already read asks for an earlier draft now. */
  journalTo(journal: DraftJournal | null): void {
    if (this.journal || !journal) return;
    this.journal = journal;
    if (this.kept) void this.lookForDrafts();
  }

  /** Once, as the book is read: the newest draft no live window holds is offered, and the grid waits for his answer. */
  private async lookForDrafts(): Promise<void> {
    if (this.looked || !this.journal || !this.kept) return;
    this.looked = true;
    const draft = (await this.journal.offered("sheet"))[0];
    if (!draft || draft.body.kind !== "sheet") return;
    this.offered = draft;
    this.set({ offer: { at: draft.at, same: draft.base === String(this.rev), cells: draftCellLines(draft.body.mutations, (id) => this.state.book?.workbook.sheets?.[id]?.name) } });
  }

  /** Restore: the offered edits, made on the revision the file still stands at, sent as a live edit is and laid on the grid. A file that moved on meanwhile turns the offer to Copy. */
  restoreDraft(): Promise<void> {
    const draft = this.offered;
    if (!draft || draft.body.kind !== "sheet" || draft.base !== String(this.rev)) return Promise.resolve();
    const mutations = draft.body.mutations as SheetMutationJson[];
    return this.run(async () => {
      try {
        const answer = await this.host.edit(this.rev, mutations);
        if (answer.conflict) return this.set({ offer: { ...this.state.offer!, same: false } });
        this.journal?.drop(draft);
        this.offered = null;
        this.set({ offer: null, savedAt: Date.now() });
        // Not this grid's own op: the catch-up lays it on the grid as it lays anyone's.
        await this.catchUp();
      } catch (error) {
        this.set({ sendError: message(error, "The host did not answer") });
      }
    });
  }

  /** Discard: the offered edits go, and the grid is his again. */
  discardDraft(): void {
    if (!this.offered) return;
    this.journal?.drop(this.offered);
    this.offered = null;
    this.set({ offer: null });
  }

  /** One thing at a time with the host, in order: a send, a catch-up, a load. */
  private run(work: () => Promise<void>): Promise<void> {
    this.busy++;
    this.chain = this.chain
      .then(work)
      .catch(() => undefined)
      .finally(() => void this.busy--);
    return this.chain;
  }

  /** The next batch to send. A move goes by itself: what he did before it first, then the move alone, so the host takes or refuses it whole and nothing else with it. */
  private batch(): SheetMutationJson[] {
    const move = this.queue.findIndex((m) => SHEET_MOVES.has(m.id));
    return this.queue.splice(0, move === 0 ? 1 : move > 0 ? Math.min(move, EDIT_MAX) : EDIT_MAX);
  }

  private async send(): Promise<void> {
    if (this.queue.length === 0) return;
    // A run of sends back to back is one on the line: its clock starts at the first.
    if (this.state.sentAt === null) this.set({ sentAt: Date.now() });
    const batch = this.batch();
    this.inflight = batch;
    try {
      await this.sendBatch(batch);
    } finally {
      // Answered or put back in the queue: what is kept now is what still waits.
      if (this.inflight === batch) this.inflight = [];
      this.note();
    }
  }

  private async sendBatch(batch: SheetMutationJson[]): Promise<void> {
    const move = SHEET_MOVES.has(batch[0]!.id);
    // A receipt past an op the grid has not laid (someone's that landed between): caught up before what comes next.
    let behind = false;
    try {
      for (let tries = 0; ; tries++) {
        // A chart or picture list is the tab's as the grid holds it at the send: one queued before a conflict's catch-up
        // goes as the grid now has it, under the names the file gave its objects.
        const sent = batch.map((m) => (isObjectList(m) ? this.fileIds.out(this.fresh(m)) : m));
        const answer = await this.host.edit(this.rev, sent, this.gen);
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
      // (an opened Excel file's refused batch is still not in the file: its line stays until Reload makes the grid the file again)
      if (this.state.sendError && this.state.view?.store !== "package") this.set({ sendError: null });
      if (this.queue.length === 0) this.set({ saving: false, savedAt: Date.now() });
      // The save stands, whatever its catch-up does: one that fails is owed, and the next send or push makes it. The
      // grid stays at the revision it last laid, so what it sends meanwhile is judged against that one.
      if (behind || this.owed) {
        this.owed = false;
        await this.catchUp().catch(() => {
          this.owed = true;
        });
      }
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
        this.lock();
        this.set({ stopped: { why: message(error, "The host did not answer"), n: (this.state.stopped?.n ?? 0) + 1 } });
        this.drop(message(error, "The host did not answer"));
        try {
          if (this.queue.length > 0) await this.send();
          await this.open();
        } finally {
          this.unlock();
          this.set({ saving: false });
        }
        return;
      }
      if (move) {
        // A move the file did not take: the grid shows cells where the file has none, so the canvas takes it back itself.
        // The words are said once, as for a change stopped at the press, and the book is read again from its file.
        this.dropQueue();
        this.set({ saving: false, stopped: { why: message(error, "The host did not answer"), n: (this.state.stopped?.n ?? 0) + 1 } });
        this.drop(message(error, "The host did not answer"));
        // (the grid is let go whether or not the book could be read again: a host that is gone must not leave it locked)
        try {
          await this.open();
        } finally {
          this.unlock();
        }
        return;
      }
      this.set({ sendError: message(error, "The host did not answer"), saving: this.queue.length > 0, sentAt: null });
    }
    if (move) {
      // A move the file took: LibreOffice and the graft wrote it, not Univer, so the grid that made it reads the file
      // again too (a rule's ranges or a chart's may differ from Univer's picture, and his next change would send that).
      try {
        await this.open();
      } finally {
        this.unlock();
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
    const answer = await this.host.since(this.rev, this.gen);
    if ("reload" in answer) {
      // A cell still open in the editor is ended first, keeping what he typed, against the book it was typed on: it goes
      // with what waits (or is named with it below). The workbook is not yet locked, which would refuse the end.
      const ended = await this.endEditor();
      // The grid takes no edit until the file is drawn again: one made meanwhile would be in neither.
      this.lock();
      try {
        this.settle?.();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        const books = this.books;
        if (refused) {
          // After a conflict, what waits was made on the same sheet the refused batch was: none of it is sent.
          const lost = [...refused, ...this.dropQueue()];
          // His cells are set aside as a draft before the book is read again under them: each where he put it, over the
          // revision and cache it was made on, which the file no longer is, so the next open offers them to copy.
          if (lost.length) this.journal?.setAside(`${this.rev}${this.gen ? `@${this.gen}` : ""} refused`, { kind: "sheet", mutations: lost });
          this.set({ saving: false, stopped: { why: notSavedWords(lost, (id) => grid.objects?.sheetName(id) ?? this.state.book?.workbook.sheets?.[id]?.name), n: (this.state.stopped?.n ?? 0) + 1 } });
          this.drop("the file changed before it was saved");
        } else {
          // What waits goes first: the host moves an edit through what it missed (a rule's list, a shared workbook's
          // edit), and refuses one the file can no longer take, which is then said (above).
          await this.send();
          // One that failed and waits for Retry keeps its grid: the book is not read again under it, so the edit the line
          // offers to send again is still there to send, and still shown. The reload is owed: made after it lands.
          if (this.queue.length > 0 && this.state.sendError) {
            this.owed = true;
            return false;
          }
        }
        // A cell the grid kept open (it refused the value) is gone with the book: said once.
        if (!ended) {
          this.set({ stopped: { why: "The file was read again while a cell was open, so what was typed there is not saved. Type it again.", n: (this.state.stopped?.n ?? 0) + 1 } });
          this.drop("a cell was open as the file was read again");
        }
        // (a send that met a conflict has read the file again already)
        if (this.books === books) await this.load(answer.rev);
      } finally {
        this.unlock();
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
    pictureAdded(change, this.fileIds, this.sentMedia, this.made, (part) => this.state.book?.media?.get(part));
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

/** Runs `work` on each of `items`, at most `most` at once; rejects with the first failure, once the ones under way end. */
export async function inTurns<T>(items: readonly T[], most: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const lane = async (): Promise<void> => {
    while (next < items.length && failed === null) {
      const item = items[next++]!;
      await work(item).catch((error: unknown) => void (failed ??= error));
    }
  };
  await Promise.all(Array.from({ length: Math.min(most, items.length) }, lane));
  if (failed !== null) throw failed;
}

/** The syncs of the items open in this window, by `${env}\n${itemId}`. */
const syncs = new Map<string, SheetSync>();
/** The syncs whose body is not shown and whose book is kept, the most recently left last (`KEPT_BOOKS` at most). */
const keptOrder: SheetSync[] = [];

function unkeep(sync: SheetSync): void {
  const at = keptOrder.indexOf(sync);
  if (at >= 0) keptOrder.splice(at, 1);
}
/** A body let its sync go: the book is kept, and the oldest kept past `KEPT_BOOKS` drops its own. */
function keep(sync: SheetSync): void {
  unkeep(sync);
  keptOrder.push(sync);
  while (keptOrder.length > KEPT_BOOKS) keptOrder.shift()!.dropBook();
}
/** An item that closed: its sync and its book go. */
function forget(sync: SheetSync): void {
  unkeep(sync);
  sync.dropBook();
  for (const [key, held] of syncs) if (held === sync) syncs.delete(key);
}

/** The one sync of an item in this window, shared by its body, bar and tab-row parts. */
export function syncOf(key: string, make: () => SheetSync): SheetSync {
  let sync = syncs.get(key);
  if (!sync) {
    sync = make();
    syncs.set(key, sync);
  }
  return sync;
}

/**
 * The items the host says closed: their syncs go, a book with them (also the one of a file others can open). A sync a
 * body still holds goes when the body lets it go; its last edits were flushed before the close (canvas/flush.ts).
 */
export function forgetItems(itemIds: readonly string[]): void {
  const gone = new Set(itemIds);
  for (const [key, sync] of [...syncs]) {
    if (!gone.has(key.slice(key.indexOf("\n") + 1))) continue;
    sync.gone = true;
    if (!sync.isShown()) forget(sync);
  }
}
onItemsGone(forgetItems);

/** For tests: the syncs held, and the books kept for tabs not shown. */
export const sheetSyncCount = (): number => syncs.size;
export const keptBookCount = (): number => keptOrder.length;

/** For tests and previews: every item starts again. */
export function resetSheetSyncs(): void {
  for (const sync of syncs.values()) sync.dropBook();
  syncs.clear();
  keptOrder.length = 0;
}
