import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SheetMutationJson, SheetView } from "@shared/contract-work-sheets";
import { DraftStore } from "../../../../main/drafts";
import { DraftJournal, type DraftsPort } from "../canvas/drafts";
import { LOAD_MAX, type LoadAnswer, type SheetHost, type SinceAnswer } from "./host";
import { resetSheetSyncs, SheetSync, type GridLink, type Workbook } from "./sync";

/**
 * A conflict keeps his cells (the audit's B7): two windows on one shared .csv, a row inserted outside TempCode, only the
 * second window reloaded. The first window's edit names the cache it drew and is refused; what he typed is set aside as
 * a sheet draft, where he typed it and over what, offered to copy on the next open, never laid at its old address.
 */

const view = (rev: number): SheetView => ({ itemId: "s1", sessionId: "t1", name: "List.csv", store: "csv", rev, shared: true, mode: "suggests", suggestions: [] });
const BOOK: Workbook = { id: "book", sheetOrder: ["a"], sheets: { a: { name: "List", cellData: { 0: { 0: { v: "name" } } } } as never } };
const text = JSON.stringify(BOOK);

/** The host of one item seen by the first window: the file's cache moves on from `g1` while it holds it. */
function movedHost() {
  const state = { gen: "g1", rev: 0 };
  const asked: { method: string; gen?: string }[] = [];
  const piece = (rev: number): LoadAnswer => ({ data: btoa(text), size: text.length, rev, format: "snapshot", gen: state.gen });
  const host: SheetHost = {
    open: async (first) => (first ? { ...view(state.rev), first: piece(state.rev) } : view(state.rev)),
    load: async (rev, offset, length) => ({ ...piece(rev), data: btoa(text.slice(offset, offset + Math.min(length, LOAD_MAX))) }),
    since: async (_rev, gen): Promise<SinceAnswer> => (asked.push({ method: "since", gen }), gen === state.gen ? { rev: state.rev, ops: [] } : { rev: state.rev, reload: true }),
    edit: async (_baseRev, _m, gen) => (asked.push({ method: "edit", gen }), gen === state.gen ? { rev: ++state.rev } : { conflict: true, rev: state.rev }),
    review: async () => view(state.rev),
    mode: async () => view(state.rev),
    undo: async () => view(state.rev),
    exportAs: async () => ({ path: "" }),
    imported: async () => ({}),
    switchApp: async () => undefined,
    onPush: () => () => undefined,
  };
  return { host, state, asked };
}

const decode = async (bytes: Uint8Array) => ({ workbook: JSON.parse(new TextDecoder().decode(bytes)) as Workbook });
const settle = async (until: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 500 && !(await until()); i++) await new Promise((r) => setTimeout(r, 2));
  expect(await until()).toBe(true);
};
const typed = (row: number, col: number, v: string): SheetMutationJson => ({ id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "a", cellValue: { [row]: { [col]: { v } } } } });

const dirs: string[] = [];
const stores: DraftStore[] = [];
afterEach(async () => {
  resetSheetSyncs();
  await Promise.all(stores.splice(0).map((s) => s.settled()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const place = { workspaceId: "w1", holder: "box", file: '{"at":"file","host":"box","path":"/w/List.csv"}' };
function store(dir = (dirs.push(mkdtempSync(join(tmpdir(), "tc-drafts-"))), join(dirs.at(-1)!, "drafts")), window = 1) {
  const s = new DraftStore(dir);
  stores.push(s);
  const port: DraftsPort = { put: (d) => s.put(d, window), drop: (k) => s.drop(k), release: (k) => s.release(k), list: (k) => s.list(k) };
  return { s, dir, journal: new DraftJournal(port, { ...place, name: "List.csv" }, () => 1_700_000_000_000) };
}

async function opened(host: SheetHost, journal: DraftJournal) {
  const sync = new SheetSync(host, decode);
  sync.journalTo(journal);
  const stop = sync.start();
  await settle(() => !!sync.state.book);
  let say: (m: SheetMutationJson) => void = () => undefined;
  const link: GridLink = { unitId: "book", apply: () => undefined, onMutation: (l) => ((say = l), () => undefined), read: () => null, formula: () => null, undo: () => undefined };
  const off = sync.attach(link);
  return { sync, type: (m: SheetMutationJson) => say(m), stop: () => (off(), stop()) };
}

describe("a conflict on a sheet whose file moved on", () => {
  it("refuses the stale edit by the cache it was made on and sets his cell aside, offered to copy on the next open", async () => {
    const { host, state, asked } = movedHost();
    const first = store();
    const { sync, type, stop } = await opened(host, first.journal);
    // A row was inserted outside TempCode and the second window read the file again: the cache is another now.
    state.gen = "g2";
    type(typed(2, 1, "mine"));
    sync.flush();
    await settle(() => !!sync.state.stopped);
    expect(asked[0]).toEqual({ method: "edit", gen: "g1" });
    expect(asked).toContainEqual({ method: "since", gen: "g1" });
    expect(sync.state.stopped?.why).toContain("B3 mine");
    await first.s.settled();
    expect(await first.s.list(place)).toMatchObject([{ base: "0@g1 refused", body: { kind: "sheet", mutations: [typed(2, 1, "mine")] } }]);
    // Drawn again from the file as it is, the next edit names the new cache and lands; the cell set aside stays.
    await settle(() => !sync.state.reloading && !!sync.state.book && sync.rev === 0 && !sync.state.saving);
    type(typed(3, 1, "again"));
    sync.flush();
    await settle(() => asked.filter((a) => a.method === "edit").length === 2 && !sync.state.saving);
    expect(asked.filter((a) => a.method === "edit")[1]).toEqual({ method: "edit", gen: "g2" });
    stop();
    await first.s.settled();
    expect((await first.s.list(place)).map((d) => d.base)).toEqual(["0@g1 refused"]);
    // The next open offers it to copy, never Restore over the file it no longer names.
    const after = store(first.dir, 2);
    const again = await opened(host, after.journal);
    await settle(() => !!again.sync.state.offer);
    expect(again.sync.state.offer).toMatchObject({ same: false, cells: ["List!B3\tmine"] });
    again.stop();
  });
});
