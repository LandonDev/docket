// @vitest-environment jsdom
/** The hosted sheet: a refused guest edit says "Edit not saved" with the service's reason while the sheet reloads, one whose answer never came "Edit not confirmed"; the next edit it takes clears it, and a Retry after the page could not be reached keeps it. */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";


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
}
vi.stubGlobal("WebSocket", FakeSocket);

vi.mock("work-kit/sheet", async (original) => ({
  readObjectsResource: (await original<typeof import("work-kit/sheet")>()).readObjectsResource,
  SheetCanvas: ({ onReady, readOnly, filter, dataChrome, objects, media }: { onReady?: (h: unknown) => void; readOnly?: boolean; filter?: boolean; dataChrome?: boolean; objects?: unknown; media?: (part: string) => Promise<Blob> }) => {
    grid.objects = objects;
    grid.media = media ?? null;
    // as the real canvas: the handle is given once the grid is up, not while it renders
    useEffect(() => onReady?.(grid.handle), []);
    return <div data-grid="" data-readonly={String(!!readOnly)} data-filter={String(filter)} data-chrome={String(!!dataChrome)} />;
  },
  SheetToolbar: ({ sheet, controls, editorKeys }: { sheet: unknown; controls?: readonly string[]; editorKeys?: boolean }) => <div data-row="" data-controls={(controls ?? []).join(" ")} data-keys={String(!!editorKeys)} data-sheet={String(sheet === grid.handle)} />,
}));
const grid = vi.hoisted(() => ({ handle: null as unknown, emit: null as ((m: unknown) => void) | null, objects: undefined as unknown, media: null as ((part: string) => Promise<Blob>) | null }));
const { SheetPage, plainCells, refusedWords } = await import("./SheetPage");
const { OpenFailed } = await import("./session");

afterEach(cleanup);

const session = { token: async () => ({ token: "t" }), socketUrl: () => "wss://example/sheet" } as never;
const opened = { role: "edit", me: "guest:1" } as never;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe("the hosted sheet", () => {
  it("says Edit not saved with the reason when the service refuses an edit, until an edit is taken", async () => {
    render(<SheetPage session={session} opened={opened} onGone={() => {}} onDown={() => {}} />);
    await flush();
    await act(async () => FakeSocket.last!.say({ t: "state", rev: 1, snapshot: { id: "u1" } }));
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => FakeSocket.last!.say({ t: "refused", id: 1, reason: "A guest cannot change a formula" }));
    const line = screen.getByRole("alert");
    expect(line.textContent).toContain("Edit not saved");
    // The service's words become his.
    expect(line.textContent).toContain("Guests can change values and formats only");
    expect(line.textContent).not.toContain("A guest cannot");
    await act(async () => FakeSocket.last!.say({ t: "ack", id: 2, rev: 3 }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("after the service says the token ran out, it asks for a new one rather than trusting this browser's clock", async () => {
    const asked: string[] = [];
    const s = { token: async () => (asked.push("token"), { token: "old" }), refresh: async () => (asked.push("refresh"), { token: "new" }), socketUrl: () => "wss://example/sheet" } as never;
    render(<SheetPage session={s} opened={opened} onGone={() => {}} onDown={() => {}} />);
    await flush();
    await act(async () => FakeSocket.last!.say({ t: "state", rev: 1, snapshot: { id: "u1" } }));
    const first = FakeSocket.last!;
    await act(async () => first.onclose?.({ code: 4401 }));
    await flush();
    await flush();
    expect(asked).toEqual(["token", "refresh"]);
    expect(FakeSocket.last).not.toBe(first);
    await flush();
    expect(FakeSocket.last!.sent[0]).toContain('"token":"new"');
  });

  it("draws the format row for an Edit link once the grid is up, with the controls a guest may use and no Data menu; a View link gets none", async () => {
    grid.handle = { onMutation: () => () => {} };
    try {
      const { container, unmount } = render(<SheetPage session={session} opened={opened} onGone={() => {}} onDown={() => {}} />);
      await flush();
      // no row while the sheet loads
      expect(container.querySelector("[data-row]")).toBeNull();
      await act(async () => FakeSocket.last!.say({ t: "state", rev: 1, snapshot: { id: "u1" } }));
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
      await act(async () => FakeSocket.last!.say({ t: "state", rev: 1, snapshot: { id: "u1" } }));
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
      onMutation: () => () => {},
      apply: (m: unknown) => applied.push(m),
      store: { get: () => ({ sheets: [{ id: "s1", name: "Data" }] }) },
      objects: { list: () => ({ charts: [chart], pictures: [], warnings: [] }), apply: (c: unknown) => objectChanges.push(c) },
    };
    try {
      render(<SheetPage session={session} opened={opened} onGone={() => {}} onDown={() => {}} />);
      await flush();
      const snapshot = { id: "u1", resources: [{ name: "TEMPCODE_SHEET_OBJECTS", data: JSON.stringify({ v: 1, charts: [chart], pictures: [picture] }) }, { name: "TEMPCODE_SHEET_MEDIA", data: JSON.stringify({ "media:p1": { type: "image/png", data: btoa("\x89PNG") } }) }] };
      await act(async () => FakeSocket.last!.say({ t: "state", rev: 1, snapshot }));
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
  });

  it("sends a filled formula with each cell's own text: the service keeps no shared formula's id", () => {
    const fill = { id: "sheet.mutation.set-range-values", params: { unitId: "u", subUnitId: "s1", cellValue: { 2: { 1: { f: "=A3*2", si: "x1" } }, 3: { 1: { si: "x1" } }, 4: { 1: { si: "x1", s: { bl: 1 } } }, 5: { 1: { v: 7 } } } } };
    const formula = (sheet: string, row: number, col: number): string | null => (sheet === "s1" && col === 1 && row < 5 ? `=A${row + 1}*2` : null);
    expect(plainCells(fill as never, formula).params.cellValue).toEqual({ 2: { 1: { f: "=A3*2", si: "x1" } }, 3: { 1: { f: "=A4*2" } }, 4: { 1: { f: "=A5*2", s: { bl: 1 } } }, 5: { 1: { v: 7 } } });
    // a grid that cannot say the formula leaves the cell as it was sent
    expect(plainCells(fill as never, () => null).params.cellValue).toEqual(fill.params.cellValue);
  });

  it("says an edit could not be confirmed, and to check the cell, when the line drops before the sheet answered it", async () => {
    grid.handle = { onMutation: (fn: (m: unknown) => void) => void (grid.emit = fn), apply: () => {} };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SheetPage session={session} opened={opened} onGone={() => {}} onDown={() => {}} />);
    await flush();
    await act(async () => FakeSocket.last!.say({ t: "state", rev: 1, snapshot: { id: "u1" } }));
    const socket = FakeSocket.last!;
    await act(async () => grid.emit!({ id: "sheet.mutation.set-range-values", params: { unitId: "u1", subUnitId: "s1", cellValue: {} } }));
    await act(async () => void vi.advanceTimersByTime(200));
    expect(socket.sent.some((m) => m.includes('"t":"ops"'))).toBe(true);
    await act(async () => socket.onclose?.({ code: 1006 }));
    const line = screen.getByRole("alert");
    expect(line.textContent).toContain("Edit not confirmed");
    expect(line.textContent).toContain("The connection dropped before the sheet answered. Check the cell");
    expect(line.textContent).not.toContain("not saved");
    vi.useRealTimers();
    grid.handle = null;
  });

  it("while the line is down, keeps the grid read only under Reconnecting, says an edit that slips in was not saved, and is editable again once the sheet is back", async () => {
    grid.handle = { onMutation: (fn: (m: unknown) => void) => void (grid.emit = fn), apply: () => {} };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SheetPage session={session} opened={opened} onGone={() => {}} onDown={() => {}} />);
    await flush();
    await act(async () => FakeSocket.last!.say({ t: "state", rev: 1, snapshot: { id: "u1" } }));
    const first = FakeSocket.last!;
    first.readyState = 3;
    await act(async () => first.onclose?.({ code: 1006 }));
    expect(document.querySelector("[data-sheet-offline]")!.textContent).toContain("Reconnecting");
    expect(document.querySelector("[data-grid]")!.getAttribute("data-readonly")).toBe("true");
    await act(async () => grid.emit!({ id: "sheet.mutation.set-range-values", params: { unitId: "u1", subUnitId: "s1", cellValue: {} } }));
    // It never left the page: plainly not saved, nothing to check.
    const alert = screen.getByRole("alert").textContent!;
    expect(alert).toContain("Edit not saved");
    expect(alert).toContain("The sheet was offline");
    expect(alert).not.toMatch(/check the cell/i);
    expect(first.sent.some((m) => m.includes('"t":"ops"'))).toBe(false);
    // Back: a fresh state, the grid editable again; the unsaved line stays until an edit is taken.
    await act(async () => void vi.advanceTimersByTime(2000));
    await flush();
    await act(async () => FakeSocket.last!.say({ t: "state", rev: 2, snapshot: { id: "u1" } }));
    expect(screen.queryByText("Reconnecting")).toBeNull();
    expect(document.querySelector("[data-grid]")!.getAttribute("data-readonly")).toBe("false");
    expect(screen.getByRole("alert")).toBeTruthy();
    vi.useRealTimers();
    grid.handle = null;
  });

  it("keeps a token refresh that failed in passing on the reconnect path, then the unavailable screen; only a link the service says is over ends the page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let fail: Error | null = new OpenFailed("down");
      const flaky = { token: async () => (fail ? Promise.reject(fail) : { token: "t" }), socketUrl: () => "wss://example/sheet" } as never;
      const onGone = vi.fn();
      const onDown = vi.fn();
      const view = render(<SheetPage session={flaky} opened={opened} onGone={onGone} onDown={onDown} />);
      await flush();
      expect(onGone).not.toHaveBeenCalled();
      // The service comes back: the next try opens the sheet.
      fail = null;
      const before = FakeSocket.last;
      await act(async () => void vi.advanceTimersByTime(1000));
      await flush();
      expect(FakeSocket.last).not.toBe(before);
      await act(async () => FakeSocket.last!.say({ t: "state", rev: 1, snapshot: { id: "u1" } }));
      expect(onGone).not.toHaveBeenCalled();
      view.unmount();

      // Down for good: after five tries the page cannot be reached, never "ended".
      fail = new Error("network");
      render(<SheetPage session={flaky} opened={opened} onGone={onGone} onDown={onDown} />);
      for (let i = 0; i < 6; i++) {
        await flush();
        await act(async () => void vi.advanceTimersByTime(9000));
      }
      expect(onDown).toHaveBeenCalledOnce();
      // Nothing was typed: no refusal to hand over.
      expect(onDown).toHaveBeenCalledWith(null);
      expect(onGone).not.toHaveBeenCalled();
      cleanup();

      // A link that has ended or been revoked: the ended screen at once.
      fail = new OpenFailed("gone");
      render(<SheetPage session={flaky} opened={opened} onGone={onGone} onDown={onDown} />);
      await flush();
      expect(onGone).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says an edit still waiting to go when the line drops was not saved, not that it could not be confirmed", async () => {
    grid.handle = { onMutation: (fn: (m: unknown) => void) => void (grid.emit = fn), apply: () => {} };
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      render(<SheetPage session={session} opened={opened} onGone={() => {}} onDown={() => {}} />);
      await act(async () => void (await Promise.resolve()));
      await act(async () => void vi.advanceTimersByTime(0));
      await act(async () => FakeSocket.last!.say({ t: "state", rev: 1, snapshot: { id: "u1" } }));
      const socket = FakeSocket.last!;
      // Typed, and the line drops before the batch goes.
      await act(async () => grid.emit!({ id: "sheet.mutation.set-range-values", params: { unitId: "u1", subUnitId: "s1", cellValue: {} } }));
      expect(socket.sent.some((m) => m.includes('"t":"ops"'))).toBe(false);
      await act(async () => socket.onclose?.({ code: 1006 }));
      const alert = screen.getByRole("alert").textContent!;
      expect(alert).toContain("Edit not saved");
      expect(alert).toContain("The connection dropped before it was sent");
      expect(alert).not.toContain("not confirmed");
    } finally {
      vi.useRealTimers();
      grid.handle = null;
    }
  });

  it("hands over the unconfirmed edit when the tries run out after the line dropped under it", async () => {
    grid.handle = { onMutation: (fn: (m: unknown) => void) => void (grid.emit = fn), apply: () => {} };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let fail: Error | null = null;
      const flaky = { token: async () => (fail ? Promise.reject(fail) : { token: "t" }), socketUrl: () => "wss://example/sheet" } as never;
      const onDown = vi.fn();
      render(<SheetPage session={flaky} opened={opened} onGone={() => {}} onDown={onDown} />);
      await flush();
      await act(async () => FakeSocket.last!.say({ t: "state", rev: 1, snapshot: { id: "u1" } }));
      // An edit goes out, and the line drops before the sheet answers it.
      await act(async () => grid.emit!({ id: "sheet.mutation.set-range-values", params: { unitId: "u1", subUnitId: "s1", cellValue: {} } }));
      await act(async () => void vi.advanceTimersByTime(1000));
      fail = new Error("network");
      const sock = FakeSocket.last!;
      sock.readyState = 3;
      await act(async () => sock.onclose?.({ code: 1006 }));
      for (let i = 0; i < 6; i++) {
        await flush();
        await act(async () => void vi.advanceTimersByTime(9000));
      }
      expect(onDown).toHaveBeenCalledWith(expect.objectContaining({ unconfirmed: true }));
    } finally {
      vi.useRealTimers();
      grid.handle = null;
    }
  });
});

describe("the unreachable screen", () => {
  it("keeps the warning that stood: not saved for an edit the item refused, not confirmed for one whose answer never came, and claims nothing with none", async () => {
    const { Ended } = await import("./GuestApp");
    const refused = render(<Ended why="down" left={{ why: "Guests can change values and formats only" }} owner={false} retry={() => {}} />);
    expect(screen.getByText("This page cannot be reached right now")).toBeTruthy();
    expect(screen.getByText(/Your last edit was not saved/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    refused.unmount();
    const unconfirmed = render(<Ended why="down" left={{ why: refusedWords("lost"), unconfirmed: true }} owner={false} retry={() => {}} />);
    expect(screen.getByText(/Your last edit could not be confirmed/)).toBeTruthy();
    expect(screen.getByText(/check the cell/)).toBeTruthy();
    expect(screen.queryByText(/not saved/)).toBeNull();
    unconfirmed.unmount();
    render(<Ended why="down" owner={false} retry={() => {}} />);
    expect(screen.getByText("Try again in a minute.")).toBeTruthy();
    expect(screen.queryByText(/Nothing you wrote is lost/)).toBeNull();
    expect(screen.queryByText(/not saved|not be confirmed/)).toBeNull();
  });

  it("brings the warning back onto the grid after Retry, until an edit is taken", async () => {
    grid.handle = { onMutation: (fn: (m: unknown) => void) => void (grid.emit = fn), apply: () => {} };
    const carried = { why: refusedWords("lost"), unconfirmed: true };
    render(<SheetPage session={session} opened={opened} onGone={() => {}} onDown={() => {}} carried={carried} />);
    await flush();
    await act(async () => FakeSocket.last!.say({ t: "state", rev: 1, snapshot: { id: "u1" } }));
    const line = screen.getByRole("alert");
    expect(line.textContent).toContain("Edit not confirmed");
    expect(line.textContent).toContain("Check the cell");
    // An edit the sheet takes clears it.
    await act(async () => FakeSocket.last!.say({ t: "ack", id: 1, rev: 2 }));
    expect(screen.queryByRole("alert")).toBeNull();
    grid.handle = null;
  });
});
