import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileBytes, FileSaved } from "@shared/contract-work-files";
import type { SheetMutationJson, SheetView } from "@shared/contract-work-sheets";
import type { SavedLine } from "./canvas/kind";
import { FileSession } from "./files/fileSession";
import { savedWords } from "./files/fileText";
import type { SheetHost } from "./sheets/host";
import { savedLine } from "./sheets/model";
import { SheetSync } from "./sheets/sync";
import { DeckStore } from "./slides/deck";
import { insertText } from "./slides/edit/model";
import { HandSession, TYPING_SAVE_MS } from "./slides/edit/session";
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
    expect(lines.slice(start).every((line) => line.startsWith("Saving"))).toBe(true);
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
});
