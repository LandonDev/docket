import { describe, expect, it } from "vitest";
import type { SheetMutationJson, SheetView } from "@shared/contract-work-sheets";
import { savingNow } from "../canvas/calm";
import { LOAD_MAX, type LoadAnswer, type SheetHost, type SheetPushed, type SinceAnswer } from "./host";
import { EDIT_WAIT, SheetSync, type GridLink, type Workbook } from "./sync";

/**
 * When a sheet's line says Saving… (canvas/calm.ts, decision 5): his edits go to be sent once the sheet's 150 ms pause
 * ends, so from then they are on their way, even while the host still answers a catch-up ahead of them.
 */

const view = (rev: number): SheetView => ({ itemId: "s1", sessionId: "t1", name: "Budget.xlsx", store: "tcsheet", rev, shared: false, mode: "writes", suggestions: [] });
const text = JSON.stringify({ id: "book", sheetOrder: ["a"], sheets: { a: { name: "Budget", cellData: {} } } } satisfies Workbook);
const decode = async (bytes: Uint8Array) => ({ workbook: JSON.parse(new TextDecoder().decode(bytes)) as Workbook });
const cell = (v: number): SheetMutationJson => ({ id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "a", cellValue: { 0: { 0: { v } } } } });
const settle = async (until: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !until(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(until()).toBe(true);
};

describe("a sheet's edits after its pause", () => {
  it("are on their way from the pause's end, so the line keeps its Saved while a catch-up ahead of them is answered", async () => {
    const state = { rev: 3, edits: 0 };
    let answer!: () => void;
    const held = new Promise<void>((r) => (answer = r));
    let sinces = 0;
    const piece = (rev: number, offset: number, length: number): LoadAnswer => ({ data: btoa(text.slice(offset, offset + length)), size: text.length, rev, format: "snapshot" });
    const host = {
      open: async (first?: boolean) => (first ? { ...view(state.rev), first: piece(state.rev, 0, LOAD_MAX) } : view(state.rev)),
      load: async (rev: number, offset: number, length: number) => piece(rev, offset, length),
      // Someone else's op landed before his: the grid catches up after the answer, and that catch-up is slow.
      since: async (): Promise<SinceAnswer> => (++sinces, await held, { rev: state.rev, ops: [] }),
      edit: async () => (state.edits++, (state.rev += 2), { rev: state.rev }),
      onPush: (_: (push: SheetPushed) => void) => () => undefined,
    } as unknown as SheetHost;
    const sync = new SheetSync(host, decode);
    const stop = sync.start();
    await settle(() => !!sync.state.book);
    let hear: ((m: SheetMutationJson) => void) | null = null;
    const link: GridLink = { unitId: "book", apply: () => undefined, onMutation: (l) => ((hear = l), () => (hear = null)), read: () => null, formula: () => null, undo: () => undefined };
    const off = sync.attach(link);
    hear!(cell(10));
    await settle(() => sinces === 1);
    hear!(cell(20));
    await new Promise((r) => setTimeout(r, EDIT_WAIT + 5));
    const { editedAt, sentAt } = sync.state;
    expect(sentAt).not.toBeNull();
    expect(savingNow({ edited: editedAt, pause: EDIT_WAIT, sent: sentAt }, Date.now()).saving).toBe(false);
    answer();
    await settle(() => state.edits === 2);
    off();
    stop();
  });
});
