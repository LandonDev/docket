import { afterEach, describe, expect, it } from "vitest";
import type { SheetMutationJson, SheetView } from "@shared/contract-work-sheets";
import { itemsGone } from "../canvas/gone";
import { LOAD_MAX, type LoadAnswer, type SheetHost, type SheetOp, type SheetPushed, type SinceAnswer } from "./host";
import { KEPT_BOOKS, keptBookCount, LOAD_AT_ONCE, resetSheetSyncs, sheetSyncCount, SheetSync, syncOf, type GridLink, type Workbook } from "./sync";

/**
 * A sheet's tab shown again costs nothing but the ask of what landed since: the book it read stays kept (the two most
 * recently left), a copy of it is drawn, and it goes with its item. A book comes in its first piece with the view, the
 * rest a few at a time, with what has come said.
 */

const view = (rev: number): SheetView => ({ itemId: "s1", sessionId: "t1", name: "Budget.xlsx", store: "tcsheet", rev, shared: false, mode: "writes", suggestions: [] });
const encode = (text: string): string => btoa(text);

/** A host that counts what it is asked, holding one book as JSON text and an op log. */
function countingHost(book: Workbook, options: { pad?: number } = {}) {
  const text = JSON.stringify({ ...book, pad: "x".repeat(options.pad ?? 0) });
  const calls: string[] = [];
  let inFlight = 0;
  let most = 0;
  const listeners = new Set<(push: SheetPushed) => void>();
  const piece = (rev: number, offset: number, length: number): LoadAnswer => ({ data: encode(text.slice(offset, offset + length)), size: text.length, rev, format: "snapshot" });
  const state = { rev: 3, ops: [] as SheetOp[], reload: false };
  const host: SheetHost & { calls: string[]; most(): number; state: typeof state; push(p: SheetPushed): void } = {
    calls,
    state,
    most: () => most,
    push: (p) => listeners.forEach((l) => l(p)),
    async open(first) {
      calls.push(first ? "open+first" : "open");
      return first ? { ...view(state.rev), first: piece(state.rev, 0, LOAD_MAX) } : view(state.rev);
    },
    async load(rev, offset, length) {
      calls.push("load");
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return piece(rev, offset, length);
    },
    async since(rev): Promise<SinceAnswer> {
      calls.push("since");
      return state.reload ? { rev: state.rev, reload: true } : { rev: state.rev, ops: state.ops.filter((op) => op.rev > rev) };
    },
    edit: async () => ({ rev: ++state.rev }),
    review: async () => view(state.rev),
    mode: async () => view(state.rev),
    undo: async () => view(state.rev),
    exportAs: async () => ({ path: "" }),
    imported: async () => ({}),
    switchApp: async () => undefined,
    onPush(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return host;
}

const decode = async (bytes: Uint8Array) => ({ workbook: JSON.parse(new TextDecoder().decode(bytes)) as Workbook });
const BOOK: Workbook = { id: "book", sheetOrder: ["a"], sheets: { a: { name: "Budget", cellData: { 0: { 0: { v: 412 } } } } as never } };

function grid() {
  const applied: SheetMutationJson[] = [];
  const link: GridLink = { unitId: "book", apply: (m) => void applied.push(...m), onMutation: () => () => undefined, read: () => null, formula: () => null, undo: () => undefined };
  return { link, applied };
}

const settle = async (until: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !until(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(until()).toBe(true);
};

/** A body mounts (the sync starts and its grid attaches once the book is there) and answers its release. */
async function mount(sync: SheetSync): Promise<() => void> {
  const stop = sync.start();
  await settle(() => !!sync.state.book);
  const off = sync.attach(grid().link);
  return () => {
    off();
    stop();
  };
}

afterEach(resetSheetSyncs);

describe("a sheet's tab shown again", () => {
  it("draws the kept book and asks only what landed since: one open, no load, one since", async () => {
    const host = countingHost(BOOK);
    const sync = syncOf("local\ns1", () => new SheetSync(host, decode));
    const first = sync.state;
    (await mount(sync))();
    expect(first).not.toBe(sync.state);
    const key = sync.state.book?.key;
    const release = await mount(sync);
    await settle(() => host.calls.includes("since"));
    expect(host.calls).toEqual(["open+first", "since"]);
    expect(sync.state.book?.key).not.toBe(key);
    release();
  });

  it("draws a copy: what the last grid changed in its workbook is not in the next", async () => {
    const host = countingHost(BOOK);
    const sync = new SheetSync(host, decode);
    const release = await mount(sync);
    const drawn = sync.state.book!.workbook as unknown as { sheets: { a: { cellData: Record<number, Record<number, { v: unknown }>> } } };
    drawn.sheets.a.cellData[0]![0] = { v: "typed in the grid" };
    release();
    (await mount(sync))();
    expect((sync.state.book!.workbook as unknown as typeof drawn).sheets.a.cellData[0]![0]).toEqual({ v: 412 });
  });

  it("lays on the next grid what landed while it was not shown, his own edits among them", async () => {
    const host = countingHost(BOOK);
    const sync = new SheetSync(host, decode);
    (await mount(sync))();
    const op = { id: "sheet.mutation.set-range-values", params: { subUnitId: "a", cellValue: { 1: { 1: { v: "Dana" } } } } };
    host.state.ops.push({ rev: 4, by: "person:dana", mutations: [op] });
    host.state.rev = 4;
    host.push({ rev: 4 });
    const stop = sync.start();
    await settle(() => !!sync.state.book);
    const g = grid();
    const off = sync.attach(g.link);
    await settle(() => g.applied.length > 0);
    expect(g.applied[0]).toMatchObject({ params: { cellValue: { 1: { 1: { v: "Dana" } } } } });
    expect(sync.rev).toBe(4);
    off();
    stop();
  });

  it("reads the file again when the host says the ops since are not kept", async () => {
    const host = countingHost(BOOK);
    const sync = new SheetSync(host, decode);
    (await mount(sync))();
    host.state.reload = true;
    host.state.rev = 9;
    const release = await mount(sync);
    await settle(() => host.calls.includes("load"));
    await settle(() => sync.rev === 9);
    expect(host.calls).toEqual(["open+first", "since", "load"]);
    release();
  });

  it("keeps the books of the two tabs left last; an older one reads its file again", async () => {
    const hosts = [1, 2, 3].map(() => countingHost(BOOK));
    const made = hosts.map((h, i) => syncOf(`local\ns${i}`, () => new SheetSync(h, decode)));
    for (const sync of made) (await mount(sync))();
    expect(keptBookCount()).toBe(KEPT_BOOKS);
    expect(made[0]!.state.book).toBeNull();
    (await mount(made[0]!))();
    expect(hosts[0]!.calls.filter((c) => c.startsWith("open"))).toHaveLength(2);
    expect(made[2]!.state.book).not.toBeNull();
  });

  it("a book that comes after its tab stopped showing is not kept, and the next body reads the file again (sol S6)", async () => {
    const host = countingHost(BOOK);
    let answer!: () => void;
    const gate = new Promise<void>((r) => (answer = r));
    const open = host.open;
    host.open = async (first) => {
      await gate;
      return open(first);
    };
    const sync = syncOf("local\nlate", () => new SheetSync(host, decode));
    const stop = sync.start();
    stop();
    answer();
    await new Promise((r) => setTimeout(r, 10));
    expect(sync.state.book).toBeNull();
    expect(keptBookCount()).toBe(0);
    const again = sync.start();
    await settle(() => !!sync.state.book);
    expect(host.calls.filter((c) => c.startsWith("open"))).toHaveLength(2);
    again();
  });

  it("an earlier load that lands after a newer one leaves the newer book and its revision (sol S6)", async () => {
    const host = countingHost(BOOK);
    const gates: Array<() => void> = [];
    const open = host.open;
    host.open = async (first) => {
      await new Promise<void>((r) => gates.push(r));
      return open(first);
    };
    const sync = syncOf("local\\nraced", () => new SheetSync(host, decode));
    const first = sync.start();
    first();
    const again = sync.start();
    await settle(() => gates.length === 2);
    // The second open answers at revision 4 and its book lands first.
    host.state.rev = 4;
    gates[1]!();
    await settle(() => sync.rev === 4);
    const key = sync.state.book!.key;
    // The first open's answer (revision 3) comes last: it is dropped.
    host.state.rev = 3;
    gates[0]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(sync.rev).toBe(4);
    expect(sync.state.book!.key).toBe(key);
    again();
  });

  it("an open still out when he left lands nothing over the kept book drawn on his return (sol S6, round 3)", async () => {
    const host = countingHost(BOOK);
    const sync = syncOf("local\\nretried", () => new SheetSync(host, decode));
    (await mount(sync))();
    // A Retry pressed, then the tab left while its open is out.
    let answer!: () => void;
    const open = host.open;
    host.open = async (first) => {
      await new Promise<void>((r) => (answer = r));
      return open(first);
    };
    const stop = sync.start();
    void sync.open();
    stop();
    // Back: the kept book is drawn at once.
    const again = sync.start();
    await settle(() => !!sync.state.book);
    const key = sync.state.book!.key;
    // The Retry's open answers now, at a later revision: nothing of it lands.
    host.state.rev = 9;
    answer();
    await new Promise((r) => setTimeout(r, 20));
    expect(sync.state.book!.key).toBe(key);
    expect(sync.rev).toBe(3);
    again();
  });

  it("goes with its item: five sheets opened and closed hold nothing", async () => {
    for (let i = 0; i < 5; i++) {
      const sync = syncOf(`local\nsheet${i}`, () => new SheetSync(countingHost(BOOK), decode));
      (await mount(sync))();
    }
    expect(sheetSyncCount()).toBe(5);
    itemsGone(["sheet0", "sheet1", "sheet2", "sheet3", "sheet4"]);
    expect(sheetSyncCount()).toBe(0);
    expect(keptBookCount()).toBe(0);
  });

  it("an item closed while its body shows goes when the body lets it go", async () => {
    const sync = syncOf("local\nshown", () => new SheetSync(countingHost(BOOK), decode));
    const release = await mount(sync);
    itemsGone(["shown"]);
    expect(sheetSyncCount()).toBe(1);
    release();
    expect(sheetSyncCount()).toBe(0);
  });
});

describe("a book's pieces", () => {
  it("a book of 4 MB or less is one request: its piece comes with the view", async () => {
    const host = countingHost(BOOK, { pad: LOAD_MAX - 200 });
    const sync = new SheetSync(host, decode);
    sync.start();
    await settle(() => !!sync.state.book);
    expect(host.calls).toEqual(["open+first"]);
  });

  it("a bigger book's rest comes a few pieces at a time, each in its place, with what has come said", async () => {
    const host = countingHost(BOOK, { pad: LOAD_MAX * 5 });
    const sync = new SheetSync(host, decode);
    const seen: Array<{ at: number; size: number } | null> = [];
    sync.subscribe(() => seen.push(sync.state.loading));
    sync.start();
    await settle(() => !!sync.state.book);
    expect(host.calls.filter((c) => c === "load")).toHaveLength(5);
    expect(host.most()).toBeGreaterThan(1);
    expect(host.most()).toBeLessThanOrEqual(LOAD_AT_ONCE);
    expect((sync.state.book!.workbook as { pad?: string }).pad).toHaveLength(LOAD_MAX * 5);
    const said = seen.filter((s): s is { at: number; size: number } => !!s);
    expect(said[0]!.at).toBe(LOAD_MAX);
    expect(said.at(-1)!.at).toBe(said.at(-1)!.size);
    expect(sync.state.loading).toBeNull();
  });
});
