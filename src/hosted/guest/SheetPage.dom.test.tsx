// @vitest-environment jsdom
/** The hosted sheet: a refused guest edit says "Edit not saved" with the service's reason while the sheet reloads; the next edit it takes clears it. */
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

vi.mock("work-kit/sheet", () => ({ SheetCanvas: ({ onReady }: { onReady?: (h: unknown) => void }) => (onReady?.(grid.handle), <div data-grid="" />) }));
const grid = vi.hoisted(() => ({ handle: null as unknown, emit: null as ((m: unknown) => void) | null }));
const { SheetPage, refusedWords } = await import("./SheetPage");

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

  it("says the service's reasons in plain words", () => {
    expect(refusedWords("the sheet changed under that edit: reload and make it again")).toBe("Someone changed the sheet first. Type it again");
    expect(refusedWords("a guest cannot insert row")).toBe("Guests can change values and formats only");
    expect(refusedWords("ops is 1 to 500 mutations")).toBeNull();
  });

  it("says an edit was not saved when the line drops before the sheet answered it", async () => {
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
    expect(line.textContent).toContain("Edit not saved");
    expect(line.textContent).toContain("The connection dropped before the sheet took it");
    vi.useRealTimers();
    grid.handle = null;
  });
});
