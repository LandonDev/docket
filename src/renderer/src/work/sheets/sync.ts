import { useSyncExternalStore } from "react";
import type { SheetCellJson, SheetMutationJson, SheetView } from "@shared/contract-work-sheets";
import { cellText, holds } from "./model";
import { EDIT_MAX, fromBase64, LOAD_MAX, type SheetHost, type SheetPushed } from "./host";

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
}

export interface SheetSyncState {
  view: SheetView | null;
  /** the item could not be opened or its workbook read */
  failed: string | null;
  book: { workbook: Workbook; key: number } | null;
  /** the person's edits did not reach the host */
  sendError: string | null;
  /** an opened Excel file was given formatting or a row or column change, which it does not keep */
  dropped: boolean;
  /** the change the stepper is on */
  current: number;
  /** goes up whenever a cell changes, for what reads the grid (a chart) */
  tick: number;
}

/** Bytes and their format, as the grid opens them. */
export type Decode = (bytes: Uint8Array, format: "xlsx" | "snapshot") => Promise<Workbook>;

const SET_RANGE_VALUES = "sheet.mutation.set-range-values";
/** Every key a cell can hold, as null: what a restored cell is laid over, so nothing of the overlay stays. */
const CLEAR = { v: null, t: null, f: null, si: null, p: null, s: null, custom: null, ref: null, ft: null, fd: null };
/** How long edits gather before they are sent. */
export const EDIT_WAIT = 150;
const CONFLICT_TRIES = 5;
/** Univer's own bookkeeping after an edit: nothing a file keeps, so never sent and never said. */
const BOOKKEEPING = new Set(["sheet.mutation.set-worksheet-row-auto-height", "sheet.mutation.set-worksheet-row-is-auto-height"]);

/**
 * Whether an opened Excel file keeps this mutation: cell contents only, a
 * set-range-values whose every cell is cleared or carries a value or a
 * formula. Formatting, a row or column inserted or deleted, a fill (a
 * shared formula's follower, `si` with no `f`) and rich text it refuses.
 */
export function isContent(mutation: SheetMutationJson): boolean {
  if (mutation.id !== SET_RANGE_VALUES) return false;
  const cells = (mutation.params as { cellValue?: Record<string, Record<string, Record<string, unknown> | null>> } | null)?.cellValue;
  if (!cells) return false;
  for (const row of Object.values(cells))
    for (const cell of Object.values(row)) {
      if (cell === null) continue;
      if (!("v" in cell) && !("f" in cell)) return false;
      if (cell.si != null && cell.f == null) return false;
      if (cell.p != null) return false;
    }
  return true;
}

/** An op as this grid names its workbook: the host's unit id and the grid's can differ. */
const inUnit = (mutation: SheetMutationJson, unitId: string): SheetMutationJson =>
  mutation.params && typeof mutation.params === "object" && "unitId" in mutation.params ? { ...mutation, params: { ...(mutation.params as object), unitId } } : mutation;

const message = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

interface Laid {
  sheet: string;
  row: number;
  col: number;
  put: SheetCellJson | null;
  under: SheetCellJson | null;
}

export class SheetSync {
  state: SheetSyncState = { view: null, failed: null, book: null, sendError: null, dropped: false, current: 0, tick: 0 };
  /** the op the grid stands at */
  rev = 0;
  private readonly mine = new Set<number>();
  private queue: SheetMutationJson[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private grid: GridLink | null = null;
  private offGrid: (() => void) | null = null;
  private offPush: (() => void) | null = null;
  /** ops landed while no grid was up: brought in when one is */
  private behind = false;
  private laid = new Map<string, Laid>();
  private readonly listeners = new Set<() => void>();
  private live = 0;
  private books = 0;

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
    const workbook = await this.decode(whole, format);
    this.rev = stood;
    this.mine.clear();
    this.queue = [];
    this.detach();
    if (this.state.dropped) this.set({ dropped: false });
    this.set({ book: { workbook, key: ++this.books } });
  }

  /** A new view: the stepper stays on its change where it can, and the cells follow the suggestions. */
  view(view: SheetView): void {
    this.set({ view });
    this.lay();
  }

  private pushed(push: SheetPushed): void {
    if (push.view) this.view(push.view);
    if (push.rev > this.rev) this.run(() => this.catchUp());
  }

  /** The grid is up: edits go out from it and what landed comes in. What it returns lets go. */
  attach(grid: GridLink): () => void {
    this.detach();
    this.grid = grid;
    const off = grid.onMutation((mutation) => {
      if (BOOKKEEPING.has(mutation.id)) return;
      if (this.state.view?.store === "package" && !isContent(mutation)) {
        if (!this.state.dropped) this.set({ dropped: true });
        return;
      }
      this.queue.push(mutation);
      this.set({ tick: this.state.tick + 1 });
      if (this.queue.length >= EDIT_MAX) this.flush();
      else this.wait();
    });
    this.offGrid = () => {
      off();
      if (this.grid === grid) this.grid = null;
    };
    this.lay();
    if (this.behind) this.run(() => this.catchUp());
    return () => {
      this.flush();
      this.detach();
    };
  }

  private detach(): void {
    this.offGrid?.();
    this.offGrid = null;
    this.grid = null;
    this.laid = new Map();
  }

  private wait(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), EDIT_WAIT);
  }

  /** Sends what has gathered now. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.length > 0) this.run(() => this.send());
  }

  /**
   * After a save that failed. An opened Excel file takes cell contents only
   * and refuses the rest (formatting, a row inserted) for good, so its grid
   * holds an edit the file does not: it is loaded again and the edits that
   * wait are dropped. Elsewhere the edits go again, or with none waiting the
   * view is read again to see whether the host's save still fails.
   */
  retry(): void {
    this.set({ sendError: null, dropped: false });
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

  private async send(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, EDIT_MAX);
    try {
      for (let tries = 0; ; tries++) {
        const answer = await this.host.edit(this.rev, batch);
        if (!answer.conflict) {
          this.mine.add(answer.rev);
          this.rev = Math.max(this.rev, answer.rev);
          break;
        }
        if (tries + 1 >= CONFLICT_TRIES) throw new Error("Others kept changing the sheet; your edits did not save");
        await this.catchUp();
      }
      if (this.state.sendError) this.set({ sendError: null });
    } catch (error) {
      // An opened Excel file refuses a batch for good: it is not sent again, and the edits after it go on. Reload makes the grid the file again.
      if (this.state.view?.store !== "package") {
        this.queue.unshift(...batch);
        this.set({ sendError: message(error, "The host did not answer") });
        return;
      }
      this.set({ sendError: message(error, "The host did not answer") });
    }
    if (this.queue.length > 0) await this.send();
  }

  /** Brings in what landed after the revision the grid stands at, but not the ops this canvas sent. */
  private async catchUp(): Promise<void> {
    const grid = this.grid;
    if (!grid) {
      this.behind = true;
      return;
    }
    this.behind = false;
    const answer = await this.host.since(this.rev);
    if ("reload" in answer) {
      // What waits goes first: the host moves an edit through what it missed.
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      await this.send();
      await this.load(answer.rev);
      return;
    }
    for (const op of answer.ops) {
      if (op.rev <= this.rev) continue;
      if (!this.mine.has(op.rev)) grid.apply(op.mutations.map((m) => inUnit(m, grid.unitId)));
      this.rev = op.rev;
    }
    this.rev = Math.max(this.rev, answer.rev);
    this.set({ tick: this.state.tick + 1 });
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
}

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
