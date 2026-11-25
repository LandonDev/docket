// @vitest-environment jsdom
/** The hosted sheet on work-kit's session: the grid stays editable while the line is down under one line that says where the edits wait, what the sheet refused or could not keep is said once, everyone else's selection is drawn under the service's name, and an Edit link's unsent edits are kept on the device. */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  sent: string[] = [];
  constructor() {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  say(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  frames(t: string): Record<string, unknown>[] {
    return this.sent.map((m) => JSON.parse(m) as Record<string, unknown>).filter((m) => m.t === t);
  }
}
vi.stubGlobal("WebSocket", FakeSocket);

vi.mock("work-kit/sheet", async (original) => ({
  readObjectsResource: (await original<typeof import("work-kit/sheet")>()).readObjectsResource,
  SheetCanvas: ({ onReady, onSelection, readOnly, filter, dataChrome, objects, media, presence }: { onReady?: (h: unknown) => void; onSelection?: (s: unknown) => void; readOnly?: boolean; filter?: boolean; dataChrome?: boolean; objects?: unknown; media?: (part: string) => Promise<Blob>; presence?: unknown[] }) => {
    grid.objects = objects;
    grid.media = media ?? null;
    grid.presence = presence ?? [];
    grid.select = onSelection ?? null;
    // as the real canvas: the handle is given once the grid is up, not while it renders
    useEffect(() => {
      grid.mounts++;
      onReady?.(grid.handle);
    }, []);
    return <div data-grid="" data-readonly={String(!!readOnly)} data-filter={String(filter)} data-chrome={String(!!dataChrome)} />;
  },
  SheetToolbar: ({ sheet, controls, editorKeys }: { sheet: unknown; controls?: readonly string[]; editorKeys?: boolean }) => <div data-row="" data-controls={(controls ?? []).join(" ")} data-keys={String(!!editorKeys)} data-sheet={String(sheet === grid.handle)} />,
}));
const grid = vi.hoisted(() => ({ handle: null as unknown, emit: null as ((m: unknown) => void) | null, objects: undefined as unknown, media: null as ((part: string) => Promise<Blob>) | null, presence: [] as unknown[], select: null as ((s: unknown) => void) | null, mounts: 0 }));
// The device's queue, as a test sets it: held by this tab or not, and what it kept.
const device = vi.hoisted(() => ({ held: false, kept: null as unknown, old: 0, saves: [] as unknown[], stopped: 0, flushed: 0 }));
vi.mock("./sheetQueue", () => ({
  claimQueue: async () => ({ held: device.held, release: () => {} }),
  sheetQueue: () => ({ load: async () => ({ saved: device.kept, old: device.old }), save: (s: unknown) => device.saves.push(s), flush: () => device.flushed++, stop: () => device.stopped++ }),
}));
const { SheetPage, plainCells, refusedWords, droppedWords, SHEET_OFFLINE_WORDS } = await import("./SheetPage");
const { OpenFailed } = await import("./session");
const { OFFLINE_AFTER_MS, RETRY } = await import("./sheetLine");

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Object.assign(device, { held: false, kept: null, old: 0, saves: [], stopped: 0, flushed: 0 });
  Object.assign(grid, { handle: handleOf(), emit: null, presence: [], select: null, mounts: 0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  grid.handle = null;
});

/** A grid as far as the page uses it: it hands its mutations over, and keeps what is laid on it. */
function handleOf(laid: unknown[] = []) {
  return { onMutation: (fn: (m: unknown) => void) => void (grid.emit = fn), apply: (m: unknown) => laid.push(m), api: { getActiveWorkbook: () => null } };
}
const session = { mode: { kind: "guest", id: "L1" }, token: async () => ({ token: "t" }), refresh: async () => ({ token: "t2", role: "edit" }), socketUrl: () => "wss://example/sheet" } as never;
const opened = { role: "edit", me: "guest:L1" } as never;
const STATE = { t: "state", rev: 1, mark: "m1", snapshot: { id: "u1" } };
const cell = (row: number, cellData: unknown = { v: "x", t: 1 }) => ({ id: "sheet.mutation.set-range-values", params: { unitId: "u1", subUnitId: "s1", cellValue: { [row]: { 0: cellData } } } });
const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
/** The page up on its first socket, with its sheet. */
async function up(props: Partial<Parameters<typeof SheetPage>[0]> = {}) {
  const view = render(<SheetPage session={session} opened={opened} onGone={() => {}} onDown={() => {}} {...props} />);
  await flush();
  await act(async () => FakeSocket.last!.say(STATE));
  await flush();
  return view;
}
/** One edit made on the grid, and its batch gone. */
async function edit(row: number, cellData?: unknown) {
  await act(async () => grid.emit!(cell(row, cellData)));
  await pass(200);
}

describe("the hosted sheet", () => {
  it("says Edit not saved with the reason when the service refuses an edit, takes the sheet as it stands, and keeps the line until an edit is taken", async () => {
    await up();
    expect(screen.queryByRole("alert")).toBeNull();
    await edit(2);
    const socket = FakeSocket.last!;
    expect(socket.frames("ops")[0]).toMatchObject({ id: 1, baseRev: 1, mutations: [cell(2)] });
    await act(async () => socket.say({ t: "refused", id: 1, reason: "a guest cannot insert sheet" }));
    const line = screen.getByRole("alert");
    expect(line.textContent).toContain("Edit not saved");
    // The service's words become his.
    expect(line.textContent).toContain("Guests can change values and formats only");
    expect(line.textContent).not.toContain("a guest cannot");
    // The grid held an edit the sheet does not: it asks for the sheet again on the same socket, and is rebuilt from it.
    expect(socket.frames("hello").at(-1)).toMatchObject({ snapshot: true });
    await act(async () => socket.say({ ...STATE, ops: [] }));
    await flush();
    expect(grid.mounts).toBe(2);
    expect(screen.getByRole("alert")).toBeTruthy();
    await edit(3);
    await act(async () => socket.say({ t: "ops", rev: 2, by: "guest:L1", mutations: [cell(3)], own: 2 }));
    await act(async () => socket.say({ t: "ack", id: 2, rev: 2 }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("draws the format row for an Edit link once the grid is up, with the controls a guest may use and no Data menu; a View link gets none", async () => {
    grid.handle = handleOf();
    try {
      const { container, unmount } = render(<SheetPage session={session} opened={opened} onGone={() => {}} onDown={() => {}} />);
      await flush();
      // no row while the sheet loads
      expect(container.querySelector("[data-row]")).toBeNull();
      await act(async () => FakeSocket.last!.say(STATE));
      await flush();
      const row = container.querySelector<HTMLElement>("[data-row]")!;
      expect(row.dataset.controls).toBe("undo style font size bold italic underline colour fill align vertical wrap merge borders number");
      for (const data of ["sort", "filter", "validation", "conditional", "names"]) expect(row.dataset.controls!.split(" ")).not.toContain(data);
      expect(row.dataset).toMatchObject({ keys: "true", sheet: "true" });
      // a guest changes no filter, so the grid offers none of its buttons or menus
      expect(container.querySelector<HTMLElement>("[data-grid]")!.dataset.filter).toBe("false");
      // a list's drop-down and a refused value are drawn in the kit's own chrome
      expect(container.querySelector<HTMLElement>("[data-grid]")!.dataset.chrome).toBe("true");
      // over the grid, as in the owner's canvas
      expect(row.compareDocumentPosition(container.querySelector("[data-grid]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      unmount();

      const view = render(<SheetPage session={session} opened={{ role: "view", me: "guest:1" } as never} onGone={() => {}} onDown={() => {}} />);
      await flush();
      await act(async () => FakeSocket.last!.say(STATE));
      await flush();
      expect(view.container.querySelector("[data-row]")).toBeNull();
      expect(view.container.querySelector<HTMLElement>("[data-grid]")!.dataset.readonly).toBe("true");
    } finally {
      grid.handle = null;
    }
  });

  it("draws the sheet's charts and pictures for a guest to see, and lays a list from the sheet on them, never on the cells", async () => {
    const anchor = { kind: "oneCell", from: { column: 1, row: 1, columnOffset: 0, rowOffset: 0 }, width: 100, height: 100 };
    const chart = { id: "chart-1", sheet: "Data", anchor, kind: "column", grouping: "clustered", groups: [], legend: null, axes: {}, series: [{ kind: "column", group: 0, values: { ref: "Data!$B$2:$B$4" } }], flags: {} };
    const picture = { id: "picture-1", sheet: "Data", anchor, part: "media:p1", contentType: "image/png" };
    const applied: unknown[] = [];
    const objectChanges: unknown[] = [];
    grid.handle = {
      ...handleOf(),
      apply: (m: unknown) => applied.push(m),
      store: { get: () => ({ sheets: [{ id: "s1", name: "Data" }] }) },
      objects: { list: () => ({ charts: [chart], pictures: [], warnings: [] }), apply: (c: unknown) => objectChanges.push(c) },
    };
    try {
      render(<SheetPage session={session} opened={opened} onGone={() => {}} onDown={() => {}} />);
      await flush();
      const snapshot = { id: "u1", resources: [{ name: "TEMPCODE_SHEET_OBJECTS", data: JSON.stringify({ v: 1, charts: [chart], pictures: [picture] }) }, { name: "TEMPCODE_SHEET_MEDIA", data: JSON.stringify({ "media:p1": { type: "image/png", data: btoa("\x89PNG") } }) }] };
      await act(async () => FakeSocket.last!.say({ ...STATE, snapshot }));
      await flush();
      expect(grid.objects).toMatchObject({ charts: [chart], pictures: [picture] });
      expect((await grid.media!("media:p1")).type).toBe("image/png");
      // the owner moves the chart: the guest's grid takes the list on its objects
      const moved = { ...chart, anchor: { ...anchor, from: { ...anchor.from, row: 6 } } };
      await act(async () => FakeSocket.last!.say({ t: "ops", rev: 2, by: "owner", mutations: [{ id: "tempcode.sheet.rules", params: { unitId: "u1", kind: "charts", subUnitId: "s1", list: [moved] } }] }));
      expect(objectChanges).toEqual([[{ kind: "set", object: { chart: moved } }]]);
      expect(applied).toEqual([]);
    } finally {
      grid.handle = null;
    }
  });

  it("says the service's reasons in plain words", () => {
    expect(refusedWords("the sheet changed under that edit: reload and make it again")).toBe("Someone changed the sheet first. Type it again");
    expect(refusedWords("a guest cannot insert row")).toBe("Guests can change values and formats only");
    expect(refusedWords("ops is 1 to 500 mutations")).toBeNull();
    // the host's caps on what one press of a guest's changes
    for (const cap of ["insert at most 1000 rows or columns at once", "a number format is laid on at most 200,000 cells at once", "at most 10,000 rows or columns are sized at once", "a merge covers at most 200,000 cells", "a sheet has at most 1,048,576 rows and 16,384 columns"]) expect(refusedWords(cap), cap).toBe("That is too much to change at once. Do it in smaller parts");
    expect(refusedWords("that range runs past the end of the sheet")).toBe("That reaches past the end of the sheet");
    expect(refusedWords("a formula is at most 8,192 characters")).toBe("That formula is too long");
    expect(refusedWords("a cell holds at most 32,767 characters")).toBe("That is too much text for one cell");
    expect(refusedWords("a guest sends at most 2 MiB at once")).toBe("That is too much to change at once. Do it in smaller parts");
    expect(refusedWords("too many edits at once: wait a minute")).toBe("Too many edits at once. Wait a minute, then make it again");
  });

  it("sends a filled formula with each cell's own text: the service keeps no shared formula's id", () => {
    const fill = { id: "sheet.mutation.set-range-values", params: { unitId: "u", subUnitId: "s1", cellValue: { 2: { 1: { f: "=A3*2", si: "x1" } }, 3: { 1: { si: "x1" } }, 4: { 1: { si: "x1", s: { bl: 1 } } }, 5: { 1: { v: 7 } } } } };
    const formula = (sheet: string, row: number, col: number): string | null => (sheet === "s1" && col === 1 && row < 5 ? `=A${row + 1}*2` : null);
    expect(plainCells(fill as never, formula).params.cellValue).toEqual({ 2: { 1: { f: "=A3*2", si: "x1" } }, 3: { 1: { f: "=A4*2" } }, 4: { 1: { f: "=A5*2", s: { bl: 1 } } }, 5: { 1: { v: 7 } } });
    // a grid that cannot say the formula leaves the cell as it was sent
    expect(plainCells(fill as never, () => null).params.cellValue).toEqual(fill.params.cellValue);
  });

  it("stays editable while the line is down, under one line that says the edits are kept in this tab, and sends them when the sheet is back", async () => {
    await up();
    const first = FakeSocket.last!;
    await act(async () => first.drop());
    // A restart's blink says nothing.
    expect(document.querySelector("[data-sheet-offline]")).toBeNull();
    await pass(OFFLINE_AFTER_MS);
    expect(document.querySelector("[data-sheet-offline]")!.textContent).toBe(SHEET_OFFLINE_WORDS.tab);
    expect(document.querySelector("[data-grid]")!.getAttribute("data-readonly")).toBe("false");
    expect(screen.queryByRole("alert")).toBeNull();
    await edit(4);
    await pass(RETRY.fastMs);
    const back = FakeSocket.last!;
    expect(back).not.toBe(first);
    expect(back.frames("hello")[0]).toMatchObject({ since: 1, snapshot: false });
    await act(async () => back.say({ t: "state", rev: 1, mark: "m1", ops: [] }));
    await pass(200);
    expect(document.querySelector("[data-sheet-offline]")).toBeNull();
    expect(back.frames("ops")[0]).toMatchObject({ baseRev: 1, mutations: [cell(4)] });
    // The same grid all along: nothing was reloaded under his hands.
    expect(grid.mounts).toBe(1);
  });

  it("an Edit link whose tab holds the device's queue says so, writes its unsent edits there, and a reload sends what was kept", async () => {
    device.held = true;
    device.kept = { cid: "client-kept", rev: 1, mark: "m1", n: 4, inflight: null, pending: [{ mutations: [cell(9)], edits: 1 }] };
    const laid: unknown[] = [];
    grid.handle = handleOf(laid);
    const view = render(<SheetPage session={session} opened={opened} onGone={() => {}} onDown={() => {}} />);
    await flush();
    const socket = FakeSocket.last!;
    // The kept client id, and where the kept edits stood: the sheet answers what they missed.
    expect(socket.frames("hello")[0]).toMatchObject({ cid: "client-kept", since: 1, snapshot: true });
    await act(async () => socket.say({ ...STATE, ops: [] }));
    await pass(200);
    // What was typed before the reload is on the new grid and on its way.
    expect(laid).toContainEqual([cell(9)]);
    expect(socket.frames("ops")[0]).toMatchObject({ id: 5, baseRev: 1, mutations: [cell(9)] });
    expect(device.saves.length).toBeGreaterThan(0);
    await act(async () => socket.drop());
    await pass(OFFLINE_AFTER_MS);
    expect(document.querySelector("[data-sheet-offline]")!.textContent).toBe(SHEET_OFFLINE_WORDS.device);
    view.unmount();
    expect(device.flushed).toBeGreaterThan(0);
  });

  it("a reader keeps nothing and is told changes will show; edits over a day old are said once as not kept", async () => {
    const view = await up({ opened: { role: "view", me: "guest:L1" } as never });
    await act(async () => FakeSocket.last!.drop());
    await pass(OFFLINE_AFTER_MS);
    expect(document.querySelector("[data-sheet-offline]")!.textContent).toBe(SHEET_OFFLINE_WORDS.reader);
    expect(device.saves).toEqual([]);
    view.unmount();
    device.held = true;
    device.old = 3;
    await up();
    expect(document.querySelector("[data-sheet-dropped]")!.textContent).toBe("3 edits made offline were over a day old and were not kept.");
  });

  it("says once what it could not keep on its way back, in one sentence", async () => {
    await up();
    await act(async () => FakeSocket.last!.drop());
    for (const row of [1, 2, 3]) await edit(row);
    await pass(RETRY.fastMs);
    // The sheet moved too far on to say what the edits missed: they cannot be moved onto it.
    await act(async () => FakeSocket.last!.say({ t: "state", rev: 900, mark: "m1", snapshot: { id: "u1" } }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("3 edits made offline could not be kept. The sheet changed under them.");
    expect(droppedWords(1, "changed", false)).toBe("1 edit could not be kept. The sheet changed under it.");
    expect(droppedWords(2, "unknown", true)).toBe("2 edits made offline could not be confirmed. Check the sheet.");
    expect(droppedWords(1, "old", true)).toBe("1 edit made offline was over a day old and was not kept.");
  });

  it("sends a guest's write cut as the service cuts it, with the grid's own type, and makes the grid hold it as sent", async () => {
    const laid: unknown[] = [];
    grid.handle = { ...handleOf(laid), api: { getActiveWorkbook: () => ({ getSheetBySheetId: () => ({ getRange: () => ({ getFormula: () => "" }), getSheet: () => ({ getCellRaw: () => ({ t: 2 }) }) }) }) } };
    await up();
    // Rich text as the grid's editor hands it back, with a key no guest may send; and a bare value.
    await act(async () => grid.emit!({ id: "sheet.mutation.set-range-values", params: { unitId: "u1", subUnitId: "s1", cellValue: { 2: { 0: { p: { body: { dataStream: "hello\r\n" } }, custom: { x: 1 } }, 1: { v: 6 } } } } }));
    await pass(200);
    const sent = FakeSocket.last!.frames("ops")[0] as { mutations: { params: { cellValue: unknown } }[] };
    expect(sent.mutations[0]!.params.cellValue).toEqual({ 2: { 0: { v: "hello", t: 1 }, 1: { v: 6, t: 2 } } });
    // Only the cell the cut changed is laid again, with what was dropped cleared.
    expect(laid).toEqual([[expect.objectContaining({ params: expect.objectContaining({ cellValue: { 2: { 0: { p: null, custom: null, v: "hello", t: 1 } } } }) })]]);
    // Another workbook's mutation (the cell editor's own document) is not the sheet's.
    await act(async () => grid.emit!({ id: "sheet.mutation.set-range-values", params: { unitId: "editor", subUnitId: "s1", cellValue: {} } }));
    await pass(200);
    expect(FakeSocket.last!.frames("ops")).toHaveLength(1);
  });

  it("draws everyone else's selection under the service's name and hue, hands their faces to the page's line, and says its own", async () => {
    const onPeople = vi.fn();
    await up({ onPeople });
    const range = { startRow: 3, endRow: 4, startColumn: 1, endColumn: 2 };
    await act(async () => FakeSocket.last!.say({ t: "presence", id: "p1", name: "Landon Hale", hue: 2, sheet: "s1", range }));
    await act(async () => FakeSocket.last!.say({ t: "presence", id: "p2", name: "Landon Hale", hue: 2, sheet: "s2", range }));
    expect(grid.presence).toEqual([
      { id: "p1", name: "Landon Hale", hue: 2, range: { sheet: "s1", ...range } },
      { id: "p2", name: "Landon Hale", hue: 2, range: { sheet: "s2", ...range } },
    ]);
    // One face a person, whichever of their windows holds a selection.
    expect(onPeople).toHaveBeenLastCalledWith([{ id: "p2", name: "Landon Hale", color: "var(--presence-2)" }]);
    await act(async () => FakeSocket.last!.say({ t: "left", id: "p1" }));
    await act(async () => FakeSocket.last!.say({ t: "left", id: "p2" }));
    expect(grid.presence).toEqual([]);
    expect(onPeople).toHaveBeenLastCalledWith([]);
    await act(async () => grid.select!({ sheet: "s1", range: { ...range, rangeType: 0 }, row: 3, column: 1, reference: "B4:C5", text: "" }));
    await pass(300);
    expect(FakeSocket.last!.frames("presence")).toEqual([{ t: "presence", sheet: "s1", range }]);
  });

  it("a link the service says is over ends the page and writes nothing more to the device; a page that never got its sheet is handed back as out of reach", async () => {
    device.held = true;
    const onGone = vi.fn();
    let over = false;
    const s = { mode: { kind: "guest", id: "L1" }, token: async () => ({ token: "t" }), refresh: async () => (over ? Promise.reject(new OpenFailed("gone")) : { token: "t2", role: "edit" }), socketUrl: () => "wss://example/sheet" } as never;
    const view = await up({ session: s, onGone });
    over = true;
    await act(async () => FakeSocket.last!.drop(4403));
    await flush();
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(device.stopped).toBe(1);
    view.unmount();

    const onDown = vi.fn();
    const never = { mode: { kind: "guest", id: "L1" }, token: async () => Promise.reject(new OpenFailed("starting")), refresh: async () => Promise.reject(new OpenFailed("starting")), socketUrl: () => "wss://example/sheet" } as never;
    render(<SheetPage session={never} opened={opened} onGone={onGone} onDown={onDown} />);
    await pass(3 * 60_000);
    expect(onDown).toHaveBeenCalledTimes(1);
    expect(onGone).toHaveBeenCalledTimes(1);
  });
});

describe("the unreachable screen", () => {
  it("says the page cannot be reached, with Retry, and claims nothing of what was written", async () => {
    const { Ended } = await import("./GuestApp");
    render(<Ended why="down" owner={false} retry={() => {}} />);
    expect(screen.getByText("This page cannot be reached right now")).toBeTruthy();
    expect(screen.getByText("Try again in a minute.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/not saved|not be confirmed|Nothing you wrote is lost/)).toBeNull();
  });
});
