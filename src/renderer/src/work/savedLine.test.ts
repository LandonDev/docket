import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudBack, CopyBack, FileBytes, FileSaved, WordBack } from "@shared/contract-work-files";
import type { SheetMutationJson, SheetView } from "@shared/contract-work-sheets";
import type { SavedLine } from "./canvas/kind";
import { FileSession } from "./files/fileSession";
import { cloudLine, copyLine, savedWords } from "./files/fileText";
import { wordLine } from "./files/wordSave";
import type { SheetHost } from "./sheets/host";
import { savedLine } from "./sheets/model";
import { EDIT_WAIT, SheetSync } from "./sheets/sync";
import { savingNow, SEND_SHOWN_MS } from "./canvas/calm";
import { DeckStore } from "./slides/deck";
import { insertText } from "./slides/edit/model";
import { HandSession, TYPING_SAVE_MS, unsavedOf } from "./slides/edit/session";
import { deckView, fakeDeckHost, slide, textShape } from "./slides/testkit";

vi.mock("./canvas/frame", () => ({ sayError: () => undefined }));

function held<T>() {
  let answer!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { answer = resolve; });
  return { promise, answer };
}

afterEach(() => vi.useRealTimers());

describe("the save line waits for the newest edit", () => {
  it("waits for both text file writes", async () => {
    vi.useFakeTimers();
    const a = held<FileSaved>();
    const b = held<FileSaved>();
    const writes: string[] = [];
    const lines: string[] = [];
    const file = new FileSession({
      async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
        if (method === "work.files.read") {
          const read: FileBytes = { data: "", end: true, version: "initial", changed: 1 };
          return read as T;
        }
        expect(method).toBe("work.files.write");
        writes.push(String(params.text));
        return (writes.length === 1 ? a.promise : b.promise) as Promise<T>;
      },
      saved: (line: SavedLine | null) => { if (line) lines.push(savedWords(line, null)); },
    }, { workspaceId: "job", itemId: "file", source: { at: "file", host: "box", path: "/work/notes.txt" }, name: "notes.txt" });

    await file.load();
    const start = lines.length;
    file.edit("A");
    const first = file.flush();
    expect(writes).toEqual(["A"]);
    file.edit("AB");
    const last = file.flush();
    a.answer({ version: "a", changed: 2 });
    await first;
    expect(writes).toEqual(["A", "AB"]);
    // Until the newest write is answered the line keeps the read's own time (calm.ts) or says Saving…, never a's.
    const opened = lines[start - 1];
    expect(lines.slice(start).every((line) => line.startsWith("Saving") || line === opened)).toBe(true);
    b.answer({ version: "b", changed: 3 });
    await last;
    expect(lines.at(-1)).toMatch(/^Saved\b/);
  });

  it("waits for both workbook receipts", async () => {
    vi.useFakeTimers();
    const a = held<{ rev: number }>();
    const b = held<{ rev: number }>();
    const view: SheetView = { name: "Budget", itemId: "sheet", sessionId: "thread", store: "tcsheet", rev: 0, shared: false, mode: "writes", suggestions: [] };
    const edit = vi.fn<SheetHost["edit"]>().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const unused = () => { throw new Error("Unexpected sheet request"); };
    const host: SheetHost = {
      open: async () => view,
      load: async () => ({ data: "", size: 0, rev: 0, format: "snapshot" }),
      edit, since: unused, review: unused, mode: unused, undo: unused, exportAs: unused,
      imported: unused, switchApp: unused, onPush: () => () => undefined,
    };
    const sync = new SheetSync(host, async () => ({ workbook: { id: "book" } }));
    let mutate!: (mutation: SheetMutationJson) => void;
    await sync.open();
    const detach = sync.attach({
      unitId: "book",
      apply: vi.fn(),
      onMutation: (listener) => { mutate = listener; return () => undefined; },
      read: () => null,
      formula: () => null,
      undo: vi.fn(),
    });
    const type = (v: string) => mutate({ id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "s1", cellValue: { 0: { 0: { v } } } } });
    const line = () => {
      const { view, sendError, saving, savedAt } = sync.get();
      return savedWords(savedLine(view!, sendError, saving, savedAt), null);
    };
    const lines: string[] = [];
    const off = sync.subscribe(() => lines.push(line()));
    type("A");
    sync.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(edit).toHaveBeenCalledTimes(1);
    type("AB");
    sync.flush();
    a.answer({ rev: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[1][1][0].params).toMatchObject({ cellValue: { 0: { 0: { v: "AB" } } } });
    expect(line()).toMatch(/^Saving\b/);
    expect(lines.some((word) => /^Saved\b/.test(word))).toBe(false);
    b.answer({ rev: 2 });
    expect(await sync.flushed()).toBe(true);
    expect(line()).toMatch(/^Saved\b/);
    off();
    detach();
  });

  it("keeps a sheet's Saved line through a quick cell, says Saving… only once a send is out 600 ms, and names the receipt's time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 25, 14, 0));
    const view: SheetView = { name: "Budget", itemId: "sheet", sessionId: "thread", store: "tcsheet", rev: 0, shared: false, mode: "writes", suggestions: [] };
    let rev = 0;
    let wait = 200;
    const receipts: number[] = [];
    const edit = vi.fn<SheetHost["edit"]>(async () => {
      await new Promise((resolve) => setTimeout(resolve, wait));
      receipts.push(Date.now());
      return { rev: ++rev };
    });
    const unused = () => { throw new Error("Unexpected sheet request"); };
    const host: SheetHost = {
      open: async () => view,
      load: async () => ({ data: "", size: 0, rev: 0, format: "snapshot" }),
      edit, since: unused, review: unused, mode: unused, undo: unused, exportAs: unused,
      imported: unused, switchApp: unused, onPush: () => () => undefined,
    };
    const sync = new SheetSync(host, async () => ({ workbook: { id: "book" } }));
    let mutate!: (mutation: SheetMutationJson) => void;
    await sync.open();
    const detach = sync.attach({ unitId: "book", apply: vi.fn(), onMutation: (listener) => { mutate = listener; return () => undefined; }, read: () => null, formula: () => null, undo: vi.fn() });
    const type = (v: string) => mutate({ id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "s1", cellValue: { 0: { 0: { v } } } } });
    // The line as SheetBody draws it: the calm rule over the sync's facts, read on every change and every 50 ms.
    const line = () => {
      const { view: v, sendError, saving, savedAt, editedAt, sentAt } = sync.get();
      const calm = savingNow({ edited: editedAt, pause: EDIT_WAIT, sent: sentAt }, Date.now()).saving && saving;
      return savedLine(v!, sendError, calm, savedAt);
    };
    const seen: Array<ReturnType<typeof line>> = [];
    const off = sync.subscribe(() => seen.push(line()));
    const watch = async (ms: number) => {
      for (let t = 0; t < ms; t += 50) {
        await vi.advanceTimersByTimeAsync(50);
        seen.push(line());
      }
    };
    // A sheet just opened says no save line until one is made (council R2-D1): the run starts from a saved file.
    expect(line()).toBeNull();
    type("0");
    await watch(EDIT_WAIT + wait + 100);
    expect(line()).toEqual({ state: "saved", at: receipts.at(-1) });
    seen.length = 0;
    // Four cells, each answered in 200 ms: never Saving…, and each Saved names a receipt (the first save's until the next).
    for (const v of ["10", "20", "30", "=A1+A2"]) {
      type(v);
      await watch(EDIT_WAIT + wait + 100);
    }
    expect(seen.every((l) => l?.state === "saved")).toBe(true);
    expect(receipts).toHaveLength(5);
    for (const l of seen) if (l?.at) expect(receipts).toContain(l.at);
    // A slow link: Saving… once the send has been out 600 ms, then Saved with the receipt's time, never later.
    wait = 1500;
    seen.length = 0;
    type("40");
    await watch(EDIT_WAIT + SEND_SHOWN_MS - 100);
    expect(seen.every((l) => l?.state === "saved")).toBe(true);
    await watch(200);
    expect(line()?.state).toBe("saving");
    await watch(1000);
    expect(line()).toEqual({ state: "saved", at: receipts.at(-1) });
    expect(line()!.at!).toBeLessThanOrEqual(Date.now());
    off();
    detach();
  });

  it("says a sheet's failed send at once, inside the 600 ms", async () => {
    vi.useFakeTimers();
    const view: SheetView = { name: "Budget", itemId: "sheet", sessionId: "thread", store: "tcsheet", rev: 0, shared: false, mode: "writes", suggestions: [] };
    const edit = vi.fn<SheetHost["edit"]>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error("the disk is full");
    });
    const unused = () => { throw new Error("Unexpected sheet request"); };
    const host: SheetHost = {
      open: async () => view,
      load: async () => ({ data: "", size: 0, rev: 0, format: "snapshot" }),
      edit, since: unused, review: unused, mode: unused, undo: unused, exportAs: unused,
      imported: unused, switchApp: unused, onPush: () => () => undefined,
    };
    const sync = new SheetSync(host, async () => ({ workbook: { id: "book" } }));
    let mutate!: (mutation: SheetMutationJson) => void;
    await sync.open();
    const detach = sync.attach({ unitId: "book", apply: vi.fn(), onMutation: (listener) => { mutate = listener; return () => undefined; }, read: () => null, formula: () => null, undo: vi.fn() });
    mutate({ id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "s1", cellValue: { 0: { 0: { v: "1" } } } } });
    await vi.advanceTimersByTimeAsync(EDIT_WAIT + 150);
    const { view: v, sendError, saving, savedAt } = sync.get();
    expect(sendError).toBe("the disk is full");
    expect(savedLine(v!, sendError, saving, savedAt)?.state).not.toBe("saved");
    detach();
  });

  it("keeps a deck's Saved line while he types inside the box's pause and a short send, then says Saving…", async () => {
    vi.useFakeTimers();
    const a = held<void>();
    const shape = textShape(2, [{ level: 0, align: "left", list: "none", runs: [{ text: "Title", size: 40 }] }]);
    const page = slide(3, { shapes: [shape] });
    const view = deckView({ slides: [page], hand: { undo: false, redo: false } });
    const host = fakeDeckHost(view);
    const edit = host.edit.bind(host);
    const store = new DeckStore();
    store.view(view);
    const session = new HandSession(host, store);
    const type = (text: string) => {
      const { model, sel: { to } } = session.get().box!;
      const next = insertText(model, { from: to, to }, text);
      session.typed(next.model, { from: next.at, to: next.at });
    };
    const line = () => session.saved(() => undefined, undefined, savingNow(unsavedOf(session.get()), Date.now()).saving);
    const state = () => savedWords(line()!, null);
    expect(session.open(page, shape, "end")).toBe(true);
    // A deck just opened says no save line until one is made (council R2-D4): the run starts from a saved deck.
    expect(line()).toBeNull();
    type("Z");
    await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS + 100);
    await vi.waitFor(() => expect(session.get().savedAt).not.toBeNull());
    expect(state()).toMatch(/^Saved\b/);
    vi.spyOn(host, "edit").mockImplementationOnce(async (ops) => { await a.promise; return edit(ops); });
    type("A");
    await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS - 100);
    type("B");
    // Each word moves the pause on: nothing has gone, and nothing is said.
    await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS - 100);
    expect(state()).toMatch(/^Saved\b/);
    // The pause ends and the words go: Saved stays while the send is out under 600 ms.
    await vi.advanceTimersByTimeAsync(200);
    expect(session.get().busy).toBe(1);
    expect(state()).toMatch(/^Saved\b/);
    await vi.advanceTimersByTimeAsync(SEND_SHOWN_MS);
    expect(state()).toBe("Saving…");
    a.answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.saved(() => undefined, undefined, false)).toEqual({ state: "saved", at: session.get().savedAt });
    expect(session.get().savedAt).toBeLessThanOrEqual(Date.now());
  });

  it("waits for both deck writes while the text box stays open", async () => {
    vi.useFakeTimers();
    const a = held<void>();
    const b = held<void>();
    const shape = textShape(2, [{ level: 0, align: "left", list: "none", runs: [{ text: "Title", size: 40 }] }]);
    const page = slide(3, { shapes: [shape] });
    const view = deckView({ slides: [page], hand: { undo: false, redo: false } });
    const host = fakeDeckHost(view);
    const edit = host.edit.bind(host);
    const writes = vi.spyOn(host, "edit").mockImplementationOnce(async (ops) => { await a.promise; return edit(ops); })
      .mockImplementationOnce(async (ops) => { await b.promise; return edit(ops); });
    const store = new DeckStore();
    store.view(view);
    const session = new HandSession(host, store);
    const type = (text: string) => {
      const { model, sel: { to } } = session.get().box!;
      const next = insertText(model, { from: to, to }, text);
      session.typed(next.model, { from: next.at, to: next.at });
    };
    const line = () => savedWords(session.saved(() => undefined), null);
    expect(session.open(page, shape, "end")).toBe(true);
    const lines: string[] = [];
    const off = session.subscribe(() => lines.push(line()));
    type("A");
    await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
    expect(writes).toHaveBeenCalledTimes(1);
    type("B");
    a.answer();
    await vi.advanceTimersByTimeAsync(TYPING_SAVE_MS);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(writes.mock.calls[1][0]).toMatchObject([{ op: "runs", paragraphs: [{ runs: [{ text: "TitleAB" }] }] }]);
    expect(line()).toMatch(/^Saving\b/);
    expect(lines.some((word) => /^Saved\b/.test(word))).toBe(false);
    b.answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(line()).toMatch(/^Saved\b/);
    off();
  });

  // The lines a Files tab lays over a kind's own (FileTabView.tsx): a Word file's (wordSave.ts `wordLine`) and the
  // upload's (fileText.ts `cloudLine`). Each reads facts the host sends with the tab, so each step is the tab as the
  // host would send it: an older save's time and an older upload's receipt must not stand for the newest edit.
  it("a Word file's line and its upload line wait for the newest save", () => {
    const T1 = Date.UTC(2026, 10, 24, 15, 0);
    const T2 = T1 + 60_000;
    const now = T2 + 1_000;
    const said = (word: WordBack, cloud?: CloudBack) => cloudLine(wordLine(word, "Teams", "MacBook", now), cloud, "Teams", "MacBook", now);
    // A saved, uploaded; he types B: the file holds A alone, whatever OneDrive said of A.
    expect(said({ since: false, auto: true, at: T1 }, { is: "uploaded", at: T1 }).words).toMatch(/^In Teams/);
    const typing = said({ since: true, auto: true, at: T1 }, { is: "uploaded", at: T1 });
    expect(typing.state).toBe("saving");
    expect(typing.words).not.toMatch(/^(Saved|In Teams)/);
    // B written on the Mac, not yet uploaded: saved there, not in Teams.
    const written = said({ since: false, auto: true, at: T2 }, { is: "uploading", at: T2 });
    expect(written).toMatchObject({ state: "saving", words: "Saved, uploading to Teams…" });
    expect(said({ since: false, auto: true, at: T2 }, { is: "uploaded", at: T2 }).words).toMatch(/^In Teams/);
    // Saved by his press alone: edits after the last save say so, and never read as saved or uploaded.
    const asked = said({ since: true, auto: false, at: T1 }, { is: "uploaded", at: T1 });
    expect(asked.state).toBe("copy");
    expect(asked.words).toMatch(/^Changes since/);
  });

  it("a copy's line and its upload line wait for the write the file holds", () => {
    const T1 = Date.UTC(2026, 10, 24, 15, 0);
    const now = T1 + 61_000;
    const said = (back: CopyBack, cloud?: CloudBack) => cloudLine(copyLine({ state: "saved", words: "Saved" }, back, "MacBook", now), cloud, "Teams", "MacBook", now);
    // Two writes, the file holds the first: saving, whatever OneDrive said of the first.
    const behind = said({ is: "ok", at: T1, writes: 2, held: 1 }, { is: "uploaded", at: T1 });
    expect(behind).toMatchObject({ state: "saving", words: "Saving to MacBook…" });
    expect(said({ is: "ok", at: T1, writes: 2, held: 2 }, { is: "uploading", at: T1 })).toMatchObject({ state: "saving", words: "Saved, uploading to Teams…" });
    expect(said({ is: "ok", at: T1, writes: 2, held: 2 }, { is: "uploaded", at: T1 }).words).toMatch(/^In Teams/);
  });
});
