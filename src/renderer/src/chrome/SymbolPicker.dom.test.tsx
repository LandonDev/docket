// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Go to Symbol's list: the arrows move the highlight, and a row the list
 * scrolls under a still pointer never takes it back (usePointerHighlight);
 * the highlight follows the pointer only once it moves.
 */

const symbols = Array.from({ length: 6 }, (_, i) => ({
  name: `symbol${i}`,
  kind: 11,
  uri: `file:///srv/app/src/file${i}.ts`,
  range: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: 2 },
}));

const answer = vi.hoisted(() => ({ next: null as null | (() => Promise<unknown>) }));
vi.mock("../surfaces/monaco/lsp/providers", () => ({
  workspaceSymbols: () => (answer.next ? answer.next() : Promise.resolve(symbols)),
}));

import { SymbolPicker } from "./SymbolPicker";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

const selected = () => screen.getAllByRole("option").findIndex((row) => row.getAttribute("aria-selected") === "true");

async function mount() {
  vi.useFakeTimers();
  await act(async () => {
    render(<SymbolPicker projectId="p1" onOpen={vi.fn()} onClose={vi.fn()} />);
  });
  const field = screen.getByRole("textbox", { name: "Go to symbol" });
  fireEvent.change(field, { target: { value: "sym" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  vi.useRealTimers();
  await act(async () => {});
  return field;
}

describe("SymbolPicker", () => {
  it("keeps the keyboard's row when the list slides under a still pointer", async () => {
    const field = await mount();
    const list = screen.getByRole("listbox", { name: "Symbols" });
    const rows = () => screen.getAllByRole("option");
    // The pointer moves onto row 2: it takes the highlight.
    fireEvent.mouseMove(list, { clientX: 20, clientY: 70 });
    fireEvent.mouseEnter(rows()[2]);
    expect(selected()).toBe(2);
    // Two arrows down; the list scrolls and row 2 meets the still pointer again.
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(selected()).toBe(4);
    fireEvent.mouseEnter(rows()[2]);
    expect(selected()).toBe(4);
    // A move at the same point is no move.
    fireEvent.mouseMove(list, { clientX: 20, clientY: 70 });
    fireEvent.mouseEnter(rows()[2]);
    expect(selected()).toBe(4);
    // A real move does: the browser sends the row's enter first, then the move over it.
    fireEvent.mouseEnter(rows()[1]);
    expect(selected()).toBe(4);
    fireEvent.mouseMove(rows()[1], { clientX: 22, clientY: 74 });
    expect(selected()).toBe(1);
    // Once armed, the next row the pointer enters takes the highlight.
    fireEvent.mouseEnter(rows()[3]);
    fireEvent.mouseMove(rows()[3], { clientX: 22, clientY: 90 });
    expect(selected()).toBe(3);
  });

  it("names the highlighted row to a reader: the field is the list's combobox", async () => {
    const field = await mount();
    const list = screen.getByRole("listbox", { name: "Symbols" });
    expect(field.getAttribute("role")).toBe("combobox");
    expect(field.getAttribute("aria-controls")).toBe(list.id);
    const rows = screen.getAllByRole("option");
    expect(field.getAttribute("aria-activedescendant")).toBe(rows[0].id);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.getAttribute("aria-activedescendant")).toBe(rows[1].id);
  });

  it("draws its rows in a menu row's box and its empty line as one muted row", async () => {
    await mount();
    const row = screen.getAllByRole("option")[0];
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-7", "gap-2", "px-3", "text-[13px]", "rounded-xl"]));
    cleanup();
    await act(async () => {
      render(<SymbolPicker projectId={null} onOpen={vi.fn()} onClose={vi.fn()} />);
    });
    const note = screen.getByText("Open a project to search symbols");
    expect(note.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-7", "px-3", "text-[13px]", "text-muted-foreground"]));
  });

  it("says a missing or failed language server as such, never as no match", async () => {
    answer.next = () => Promise.reject(Object.assign(new Error("no language server"), { symbolSearch: "none" }));
    await mount();
    expect(screen.getByText("No language server is running for this project")).toBeTruthy();
    cleanup();
    answer.next = () => Promise.reject(new Error("boom"));
    await mount();
    expect(screen.getByText("Couldn't search symbols")).toBeTruthy();
    expect(screen.queryByText("No matching symbols")).toBeNull();
    answer.next = null;
  });

  it("marks the typed words in a symbol's name, its container 4px after it", async () => {
    answer.next = () => Promise.resolve([{ ...symbols[0], containerName: "Rail" }]);
    await mount();
    const row = screen.getAllByRole("option")[0];
    expect(row.querySelector("mark")?.textContent).toBe("sym");
    expect(row.querySelector(".ms-1")?.textContent).toBe("Rail");
    expect(row.querySelector(".w-24")).toBeTruthy();
    answer.next = null;
  });

  // Council round 4 (S F9.1): the last query's rows stayed live while a new search ran, and Enter opened one.
  it("drops the last query's rows the moment the words change, says Searching…, and Enter opens nothing until the answer lands", async () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    await act(async () => {
      render(<SymbolPicker projectId="p1" onOpen={onOpen} onClose={vi.fn()} />);
    });
    const field = screen.getByRole("textbox", { name: "Go to symbol" });
    fireEvent.change(field, { target: { value: "sym" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getAllByRole("option").length).toBe(6);
    let land: (rows: unknown) => void = () => {};
    answer.next = () => new Promise((resolve) => { land = resolve; });
    fireEvent.change(field, { target: { value: "other" } });
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(screen.getByText("Searching…")).toBeTruthy();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByText("Searching…")).toBeTruthy();
    await act(async () => {
      land([{ ...symbols[3], name: "otherThing" }]);
    });
    expect(screen.getAllByRole("option").length).toBe(1);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("/srv/app/src/file3.ts", { line: 4, column: 1 });
    vi.useRealTimers();
    answer.next = null;
  });
});
