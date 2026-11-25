import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SheetMutationJson, SheetView } from "@shared/contract-work-sheets";
import { DraftStore } from "../../../../main/drafts";
import { DraftJournal, type DraftsPort } from "../canvas/drafts";
import { LOAD_MAX, type LoadAnswer, type SheetHost, type SheetPushed, type SinceAnswer } from "./host";
import { SheetSync, type GridLink, type Workbook } from "./sync";

/**
 * A sheet's edits the host never answered survive a crash (docs/agents/work-files.md "Drafts survive a crash"): kept by
 * the file's revision in the store main writes (here on a scratch folder; a new store on it is the app started again),
 * offered as the sheet opens, sent by Restore as a live edit, and never laid over a file that changed since.
 */

const view = (rev: number): SheetView => ({ itemId: "s1", sessionId: "t1", name: "Budget.xlsx", store: "tcsheet", rev, shared: false, mode: "writes", suggestions: [] });
const BOOK: Workbook = { id: "book", sheetOrder: ["a"], sheets: { a: { name: "Budget", cellData: { 0: { 0: { v: 412 } } } } as never } };
const text = JSON.stringify(BOOK);
const decode = async (bytes: Uint8Array) => ({ workbook: JSON.parse(new TextDecoder().decode(bytes)) as Workbook });
const cell = (v: number): SheetMutationJson => ({ id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "a", cellValue: { 0: { 0: { v } } } } });

function standIn() {
  const state = { rev: 3, down: false, gen: undefined as string | undefined, edits: [] as { baseRev: number; mutations: SheetMutationJson[]; gen?: string }[] };
  const piece = (rev: number, offset: number, length: number): LoadAnswer => ({ data: btoa(text.slice(offset, offset + length)), size: text.length, rev, format: "snapshot", ...(state.gen ? { gen: state.gen } : {}) });
  const host: SheetHost = {
    open: async (first) => (first ? { ...view(state.rev), first: piece(state.rev, 0, LOAD_MAX) } : view(state.rev)),
    load: async (rev, offset, length) => piece(rev, offset, length),
    since: async (): Promise<SinceAnswer> => ({ rev: state.rev, ops: [] }),
    edit: async (baseRev, mutations, gen) => {
      if (state.down) throw new Error("not connected");
      // (the host's `csvMoved`: an edit made on another cache of a shared .csv is a conflict, whatever its revision)
      if (baseRev !== state.rev || (gen !== undefined && gen !== state.gen)) return { rev: state.rev, conflict: true };
      state.edits.push({ baseRev, mutations, ...(gen ? { gen } : {}) });
      return { rev: ++state.rev };
    },
    review: async () => view(state.rev),
    mode: async () => view(state.rev),
    undo: async () => view(state.rev),
    exportAs: async () => ({ path: "" }),
    imported: async () => ({}),
    switchApp: async () => undefined,
    onPush: (_: (push: SheetPushed) => void) => () => undefined,
  } as SheetHost;
  return { host, state };
}

function grid() {
  let hear: ((m: SheetMutationJson) => void) | null = null;
  const applied: SheetMutationJson[] = [];
  const link: GridLink = { unitId: "book", apply: (m) => void applied.push(...m), onMutation: (l) => ((hear = l), () => (hear = null)), read: () => null, formula: () => null, undo: () => undefined };
  return { link, applied, type: (m: SheetMutationJson) => hear?.(m) };
}

const settle = async (until: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 500 && !(await until()); i++) await new Promise((r) => setTimeout(r, 2));
  expect(await until()).toBe(true);
};

const dirs: string[] = [];
const stores: DraftStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.settled()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const place = { workspaceId: "w1", holder: "box", file: '{"at":"file","host":"box","path":"/w/Budget.tcsheet"}' };
function store(dir = (dirs.push(mkdtempSync(join(tmpdir(), "tc-drafts-"))), join(dirs.at(-1)!, "drafts")), window = 1) {
  const s = new DraftStore(dir);
  stores.push(s);
  const port: DraftsPort = { put: (d) => s.put(d, window), drop: (k) => s.drop(k), release: (k) => s.release(k), list: (k) => s.list(k) };
  return { s, dir, journal: new DraftJournal(port, { ...place, name: "Budget.tcsheet" }, () => new Date(2026, 10, 23, 14, 30).getTime()), kept: async () => (s.releaseOwner(window), s.list(place)) };
}

async function opened(host: SheetHost, journal: DraftJournal) {
  const sync = new SheetSync(host, decode);
  sync.journalTo(journal);
  const stop = sync.start();
  await settle(() => !!sync.state.book);
  const g = grid();
  const off = sync.attach(g.link);
  return { sync, g, stop: () => (off(), stop()) };
}

describe("a sheet's edits the host never answered", () => {
  it("are kept on this computer by the file's revision while they wait, and go once the host has them", async () => {
    const { host, state } = standIn();
    const d = store();
    const { sync, g } = await opened(host, d.journal);
    state.down = true;
    g.type(cell(42));
    sync.flush();
    await settle(async () => (await d.kept()).length === 1);
    const [kept] = await d.kept();
    expect(kept).toMatchObject({ base: "3", body: { kind: "sheet", mutations: [cell(42)] } });
    state.down = false;
    sync.retry();
    await settle(() => state.edits.length === 1);
    await d.s.settled();
    expect(await d.kept()).toEqual([]);
  });

  it("are offered after the app went with no word, and Restore sends them by the revision they were made on", async () => {
    const { host, state } = standIn();
    const before = store();
    const first = await opened(host, before.journal);
    state.down = true;
    first.g.type(cell(42));
    first.sync.flush();
    await settle(async () => (await before.kept()).length === 1);
    await before.s.settled();
    // Killed: the app starts again on the same folder, the host as it was.
    state.down = false;
    const after = store(before.dir, 2);
    const { sync } = await opened(host, after.journal);
    await settle(() => !!sync.state.offer);
    expect(sync.state.offer).toEqual({ at: new Date(2026, 10, 23, 14, 30).getTime(), same: true, cells: ["Budget!A1\t42"] });
    await sync.restoreDraft();
    expect(state.edits).toEqual([{ baseRev: 3, mutations: [cell(42)] }]);
    expect(sync.state.offer).toBeNull();
    await after.s.settled();
    expect(await after.kept()).toEqual([]);
  });

  it("are never laid over a file that changed since: the offer is Copy, Restore sends nothing, and Discard lets them go", async () => {
    const { host, state } = standIn();
    const before = store();
    const first = await opened(host, before.journal);
    state.down = true;
    first.g.type(cell(42));
    first.sync.flush();
    await settle(async () => (await before.kept()).length === 1);
    await before.s.settled();
    state.down = false;
    state.rev = 7;
    const after = store(before.dir, 2);
    const { sync } = await opened(host, after.journal);
    await settle(() => !!sync.state.offer);
    expect(sync.state.offer?.same).toBe(false);
    await sync.restoreDraft();
    expect(state.edits).toEqual([]);
    sync.discardDraft();
    expect(sync.state.offer).toBeNull();
    await after.s.settled();
    expect(await after.kept()).toEqual([]);
  });

  describe("on a shared .csv, whose new cache starts again at a revision the draft may share", () => {
    async function keptOn(gen: string) {
      const { host, state } = standIn();
      state.gen = gen;
      const before = store();
      const first = await opened(host, before.journal);
      state.down = true;
      first.g.type(cell(42));
      first.sync.flush();
      await settle(async () => (await before.kept()).length === 1);
      await before.s.settled();
      state.down = false;
      return { host, state, before };
    }

    it("are kept by the cache they were made on, and Restore names it", async () => {
      const { host, state, before } = await keptOn("g1");
      expect((await before.kept())[0]).toMatchObject({ base: "3@g1" });
      const after = store(before.dir, 2);
      const { sync } = await opened(host, after.journal);
      await settle(() => !!sync.state.offer);
      expect(sync.state.offer?.same).toBe(true);
      await sync.restoreDraft();
      expect(state.edits).toEqual([{ baseRev: 3, mutations: [cell(42)], gen: "g1" }]);
    });

    it("are offered as Copy over a new cache at the same revision, and Restore sends nothing", async () => {
      const { host, state, before } = await keptOn("g1");
      // A co-author's change: a new cache, at revision 3 again.
      state.gen = "g2";
      const after = store(before.dir, 2);
      const { sync } = await opened(host, after.journal);
      await settle(() => !!sync.state.offer);
      expect(sync.state.offer).toMatchObject({ same: false, cells: ["Budget!A1\t42"] });
      await sync.restoreDraft();
      expect(state.edits).toEqual([]);
      expect(sync.state.offer?.cells).toEqual(["Budget!A1\t42"]);
    });

    it("turn to Copy, his values kept, when the cache moves between the offer and his Restore", async () => {
      const { host, state, before } = await keptOn("g1");
      const after = store(before.dir, 2);
      const { sync } = await opened(host, after.journal);
      await settle(() => !!sync.state.offer);
      expect(sync.state.offer?.same).toBe(true);
      state.gen = "g2";
      await sync.restoreDraft();
      expect(state.edits).toEqual([]);
      expect(sync.state.offer).toMatchObject({ same: false, cells: ["Budget!A1\t42"] });
    });

    it("made with no cache named (an older window) are Copy, never Restore", async () => {
      const { host, state, before } = await keptOn("g1");
      const [kept] = await before.kept();
      await before.s.put({ ...kept, base: "3" } as never, 1);
      await before.s.drop({ ...kept } as never);
      await before.s.settled();
      const after = store(before.dir, 2);
      const { sync } = await opened(host, after.journal);
      await settle(() => !!sync.state.offer);
      expect(sync.state.offer?.same).toBe(false);
      await sync.restoreDraft();
      expect(state.edits).toEqual([]);
    });
  });
});
