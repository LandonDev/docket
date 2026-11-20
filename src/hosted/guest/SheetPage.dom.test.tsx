// @vitest-environment jsdom
/** The hosted sheet: a refused guest edit says "Edit not saved" with the service's reason while the sheet reloads, one whose answer never came "Edit not confirmed"; the next edit it takes clears it, and a Retry after the page could not be reached keeps it. */
import { act, cleanup, render, screen } from "@testing-library/react";
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

vi.mock("work-kit/sheet", () => ({
  SheetCanvas: ({ onReady, readOnly }: { onReady?: (h: unknown) => void; readOnly?: boolean }) => (onReady?.(grid.handle), <div data-grid="" data-readonly={String(!!readOnly)} />),
}));
const grid = vi.hoisted(() => ({ handle: null as unknown, emit: null as ((m: unknown) => void) | null }));
const { SheetPage, refusedWords } = await import("./SheetPage");
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

  it("says the service's reasons in plain words", () => {
    expect(refusedWords("the sheet changed under that edit: reload and make it again")).toBe("Someone changed the sheet first. Type it again");
    expect(refusedWords("a guest cannot insert row")).toBe("Guests can change values and formats only");
    expect(refusedWords("ops is 1 to 500 mutations")).toBeNull();
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
