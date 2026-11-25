// @vitest-environment jsdom
/** The desktop grid on a live sheet: it says its selection when it changed, hears everyone else's, draws them, and takes its own away when it closes. */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridSelection } from "work-kit/sheet";
import type { SheetPerson } from "@shared/contract-work-sheets";
import type { SheetHost, SheetPushed } from "./host";
import { facesOf, SAY_AGAIN_MS, SAY_EVERY_MS, useSheetPresence } from "./presence";

const range = { startRow: 2, endRow: 2, startColumn: 1, endColumn: 3 };
const dana: SheetPerson = { id: "p1", name: "Dana Lee", hue: 2, sheet: "s1", range };
const pick = (row: number): GridSelection => ({ sheet: "s1", range: { ...range, startRow: row, endRow: row, rangeType: 0 }, row, column: 1, reference: "B3", text: "" }) as never;

function fakeHost(people: SheetPerson[] = [dana]) {
  const said: unknown[] = [];
  const listeners = new Set<(push: SheetPushed) => void>();
  const host = {
    presence: async (s: unknown) => (said.push(s), { people }),
    onPush: (fn: (push: SheetPushed) => void) => (listeners.add(fn), () => listeners.delete(fn)),
  } as unknown as SheetHost;
  return { host, said, push: (p: SheetPushed) => listeners.forEach((fn) => fn(p)), listening: () => listeners.size };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("the desktop grid on a live sheet", () => {
  it("reads who is there as it opens, draws them on the grid and their faces in the bar, and hears who comes and goes", async () => {
    const f = fakeHost();
    const shell = { presence: vi.fn() };
    const { result, unmount } = renderHook(() => useSheetPresence(f.host, true, shell));
    await settle();
    expect(f.said).toEqual([{}]);
    expect(result.current.presence).toEqual([{ id: "p1", name: "Dana Lee", hue: 2, range: { sheet: "s1", ...range } }]);
    expect(shell.presence).toHaveBeenLastCalledWith([{ id: "p1", name: "Dana Lee", hue: 2 }]);
    await act(async () => f.push({ rev: 0, presence: [] }));
    expect(result.current.presence).toEqual([]);
    expect(shell.presence).toHaveBeenLastCalledWith([]);
    // A push of a revision alone says nothing of who is here.
    await act(async () => f.push({ rev: 0, presence: [dana] }));
    await act(async () => f.push({ rev: 7 }));
    expect(result.current.presence).toHaveLength(1);
    unmount();
    // Its own selection leaves the sheet with the canvas, and it hears no more.
    expect(f.said.at(-1)).toEqual({ range: null });
    expect(f.listening()).toBe(0);
    expect(shell.presence).toHaveBeenLastCalledWith([]);
  });

  it("says its selection when it changed, four times a second at most, and again every ten minutes so an open grid stays on the sheet", async () => {
    const f = fakeHost();
    const { result } = renderHook(() => useSheetPresence(f.host, true, { presence: () => {} }));
    await settle();
    for (const row of [1, 2, 3, 4, 5]) act(() => result.current.onSelection(pick(row)));
    expect(f.said).toHaveLength(1);
    await settle(SAY_EVERY_MS);
    // Five moves in one beat: only where it ended up.
    expect(f.said.slice(1)).toEqual([{ sheet: "s1", range: { ...range, startRow: 5, endRow: 5 } }]);
    act(() => result.current.onSelection(pick(5)));
    await settle(SAY_EVERY_MS * 4);
    expect(f.said).toHaveLength(2);
    await settle(SAY_AGAIN_MS);
    expect(f.said).toHaveLength(3);
    expect(f.said[2]).toEqual(f.said[1]);
    act(() => result.current.onSelection(null));
    await settle(SAY_EVERY_MS);
    expect(f.said.at(-1)).toEqual({ range: null });
  });

  it("a sheet no service holds live, or a host that says no presence, is asked nothing", async () => {
    const f = fakeHost();
    const off = renderHook(() => useSheetPresence(f.host, false, { presence: () => {} }));
    act(() => off.result.current.onSelection(pick(1)));
    await settle(SAY_EVERY_MS * 2);
    expect(f.said).toEqual([]);
    const none = renderHook(() => useSheetPresence({ onPush: () => () => {} } as unknown as SheetHost, true, { presence: () => {} }));
    act(() => none.result.current.onSelection(pick(1)));
    await settle(SAY_EVERY_MS * 2);
    expect(none.result.current.presence).toEqual([]);
  });

  it("one face a person, whichever of their windows holds a selection, in a hue of the eight", () => {
    expect(facesOf([dana, { ...dana, id: "p2", sheet: "s2" }, { ...dana, id: "p3", name: "Sam Ito", hue: 11 }])).toEqual([
      { id: "p2", name: "Dana Lee", hue: 2 },
      { id: "p3", name: "Sam Ito", hue: 3 },
    ]);
  });
});
