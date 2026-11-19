// @vitest-environment jsdom
/** The hosted sheet: a refused guest edit says "Edit not saved" with the service's reason while the sheet reloads; the next edit it takes clears it. */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("work-kit/sheet", () => ({ SheetCanvas: () => <div data-grid="" /> }));

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

const { SheetPage } = await import("./SheetPage");

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
    expect(line.textContent).toContain("A guest cannot change a formula");
    await act(async () => FakeSocket.last!.say({ t: "ack", id: 2, rev: 3 }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
