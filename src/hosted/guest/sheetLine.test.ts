/** A hosted sheet's line: it keeps trying for good once it has its sheet, sends what was typed meanwhile when it is back, and ends only at the service's word. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "work-kit/sheet/collab";
import { OpenFailed, STARTING_FOR_MS } from "./session";
import { OFFLINE_AFTER_MS, openSheetLine, RETRY, SELECTION_EVERY_MS, type LineStatus, type SheetLineOptions, type SheetPerson } from "./sheetLine";

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
const last = (): FakeSocket => FakeSocket.all.at(-1)!;
const setCell = (row: number, v: unknown) => ({ id: "sheet.mutation.set-range-values", params: { unitId: "u1", subUnitId: "s1", cellValue: { [row]: { 0: { v, t: 1 } } } } });
const tick = async (ms = 0): Promise<void> => void (await vi.advanceTimersByTimeAsync(ms));

function open(over: Partial<SheetLineOptions> = {}) {
  const seen = { laid: [] as unknown[], built: [] as unknown[], status: [] as LineStatus[], said: [] as [SessionEvent, boolean][], people: [] as SheetPerson[][], gone: 0, down: 0, reopened: 0, tokens: [] as string[] };
  let visible = true;
  let back: (() => void) | null = null;
  const line = openSheetLine({
    session: { token: async () => (seen.tokens.push("token"), { token: "t1", expiresAt: 0 }), refresh: async () => (seen.tokens.push("refresh"), { token: "t2", role: "edit" }) as never, socketUrl: () => "wss://example/g/ws/L1" },
    opened: { role: "edit", me: "guest:L1" } as never,
    cid: "client-0001",
    lay: (m) => seen.laid.push(m),
    rebuild: (s) => {
      seen.built.push(s);
      queueMicrotask(() => line.ready());
    },
    status: (s) => seen.status.push(s),
    said: (e, returning) => seen.said.push([e, returning]),
    people: (p) => seen.people.push(p),
    gone: () => seen.gone++,
    reopen: () => seen.reopened++,
    down: () => seen.down++,
    Socket: FakeSocket as never,
    visible: () => visible,
    onVisible: (fn) => {
      back = fn;
      return () => (back = null);
    },
    ...over,
  });
  return { line, seen, hide: () => (visible = false), show: () => ((visible = true), back?.()) };
}

/** A line with its sheet: the first socket opened and answered. */
async function up(over: Partial<SheetLineOptions> = {}) {
  const got = open(over);
  await tick();
  last().open();
  last().say({ t: "state", rev: 4, mark: "m1", snapshot: JSON.stringify({ id: "u1" }) });
  await tick();
  return got;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
});
afterEach(() => vi.useRealTimers());

describe("a hosted sheet's line", () => {
  it("says hello with its token and client id, builds the grid from the sheet, and sends an edit with the revision it was made on", async () => {
    const { line, seen } = await up();
    expect(last().sent[0]).toEqual({ t: "hello", token: "t1", cid: "client-0001", snapshot: true });
    expect(seen.built).toEqual([{ id: "u1" }]);
    expect(seen.status.at(-1)).toMatchObject({ offline: false, syncing: false });
    line.local(setCell(2, "a"));
    await tick(200);
    expect(last().sent.at(-1)).toMatchObject({ t: "ops", id: 1, baseRev: 4, mutations: [setCell(2, "a")] });
    expect(seen.status.at(-1)!.unsent).toBeGreaterThan(0);
    last().say({ t: "ops", rev: 5, by: "guest:L1", mutations: [setCell(2, "a")], own: 1 });
    last().say({ t: "ack", id: 1, rev: 5 });
    // Its own op is never laid again, and every edit is answered.
    expect(seen.laid).toEqual([]);
    expect(seen.status.at(-1)!.unsent).toBe(0);
    expect(seen.said.at(-1)![0]).toEqual({ kind: "settled" });
    line.stop();
  });

  it("lays everyone else's ops, and draws who is on the sheet until they leave or the line drops", async () => {
    const { line, seen } = await up();
    last().say({ t: "ops", rev: 5, by: "owner", mutations: [setCell(7, "theirs")] });
    expect(seen.laid).toEqual([[setCell(7, "theirs")]]);
    const dana = { id: "p1", name: "Dana Lee", hue: 3, sheet: "s1", range: { startRow: 1, endRow: 1, startColumn: 0, endColumn: 2 } };
    last().say({ t: "presence", ...dana });
    last().say({ t: "presence", id: "p2", name: "Landon Hale", hue: 1, sheet: "s1", range: dana.range });
    expect(seen.people.at(-1)).toEqual([dana, { ...dana, id: "p2", name: "Landon Hale", hue: 1 }]);
    last().say({ t: "left", id: "p2" });
    expect(seen.people.at(-1)).toEqual([dana]);
    last().drop();
    expect(seen.people.at(-1)).toEqual([]);
    line.stop();
  });

  it("keeps edits made while the line is down and sends them when the sheet is back, saying offline only after a moment", async () => {
    const { line, seen } = await up();
    const first = last();
    first.drop(1012);
    // A restart's blink says nothing.
    expect(seen.status.some((s) => s.offline)).toBe(false);
    line.local(setCell(3, "kept"));
    await tick(RETRY.fastMs);
    expect(FakeSocket.all).toHaveLength(2);
    // The host is not back yet: the socket never opens.
    last().drop();
    await tick(OFFLINE_AFTER_MS);
    expect(seen.status.at(-1)!.offline).toBe(true);
    await tick(RETRY.fastMs);
    last().open();
    expect(last().sent[0]).toEqual({ t: "hello", token: "t1", cid: "client-0001", since: 4, snapshot: false });
    last().say({ t: "state", rev: 4, mark: "m1", ops: [] });
    await tick(200);
    expect(seen.status.at(-1)!.offline).toBe(false);
    expect(last().sent.find((f) => f.t === "ops")).toMatchObject({ id: 1, baseRev: 4, mutations: [setCell(3, "kept")] });
    // The grid was never rebuilt: the page kept it through the drop.
    expect(seen.built).toHaveLength(1);
    line.stop();
  });

  it("tries every second for half a minute, then every five, for as long as it takes; never while the page is out of view", async () => {
    const { line, seen, hide, show } = await up();
    last().drop();
    // A try a second while the first half minute lasts: each one that fails is followed by the next.
    for (let i = 0; i < 30; i++) {
      const had = FakeSocket.all.length;
      await tick(RETRY.fastMs);
      expect(FakeSocket.all.length).toBe(had + 1);
      last().drop();
    }
    // Then one every five seconds.
    const slow = FakeSocket.all.length;
    await tick(RETRY.slowMs - 1);
    expect(FakeSocket.all.length).toBe(slow);
    await tick(1);
    expect(FakeSocket.all.length).toBe(slow + 1);
    // Ten minutes on it is still trying, and never handed back as out of reach.
    for (let i = 0; i < 120; i++) {
      last().drop();
      await tick(RETRY.slowMs);
    }
    expect(FakeSocket.all.length).toBe(slow + 121);
    expect(seen.down).toBe(0);
    hide();
    last().drop();
    const hidden = FakeSocket.all.length;
    await tick(60_000);
    expect(FakeSocket.all.length).toBe(hidden);
    show();
    await tick();
    expect(FakeSocket.all.length).toBe(hidden + 1);
    line.stop();
  });

  it("a page that never gets its sheet is handed back as out of reach after two minutes, a host that is starting included", async () => {
    const { seen } = open({ session: { token: async () => Promise.reject(new OpenFailed("starting")), refresh: async () => Promise.reject(new OpenFailed("starting")), socketUrl: () => "wss://x" } });
    await tick(STARTING_FOR_MS - 5000);
    expect(seen.down).toBe(0);
    await tick(10_000);
    expect(seen.down).toBe(1);
    expect(seen.gone).toBe(0);
  });

  it("ends only at the service's word: a revoked close asks once, and a link that is gone ends the page", async () => {
    let over = false;
    const session = { token: async () => ({ token: "t1", expiresAt: 0 }), refresh: async () => (over ? Promise.reject(new OpenFailed("gone")) : ({ token: "t2", role: "edit" } as never)), socketUrl: () => "wss://x" };
    const { line, seen } = await up({ session });
    // The owner gave the link a new token (a role kept): back at once on a fresh one.
    last().drop(4403);
    await tick();
    expect(seen.gone).toBe(0);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: "hello", token: "t2" });
    last().say({ t: "state", rev: 4, mark: "m1", ops: [] });
    over = true;
    last().drop(4403);
    await tick();
    expect(seen.gone).toBe(1);
    line.stop();
  });

  it("after the service says the token ran out, asks for a new one rather than trusting this browser's clock", async () => {
    const { line, seen } = await up();
    last().drop(4401);
    await tick();
    expect(seen.tokens).toEqual(["token", "refresh"]);
    last().open();
    expect(last().sent[0]).toMatchObject({ token: "t2" });
    line.stop();
  });

  it("says a refusal, and what it could not keep on its way back as made offline", async () => {
    const { line, seen } = await up();
    line.local(setCell(2, "no"));
    await tick(200);
    last().say({ t: "refused", id: 1, reason: "a guest cannot insert sheet" });
    expect(seen.said.at(-1)).toEqual([{ kind: "refused", edits: 1, reason: "a guest cannot insert sheet" }, false]);
    // The grid holds an edit the sheet does not: the sheet is asked for again on the same socket.
    expect(last().sent.at(-1)).toMatchObject({ t: "hello", cid: "client-0001", snapshot: true });
    last().say({ t: "state", rev: 4, mark: "m1", ops: [], snapshot: JSON.stringify({ id: "u1" }) });
    await tick();
    expect(seen.built).toHaveLength(2);
    // Offline, three edits; the sheet moved too far on to say what they missed.
    last().drop();
    for (const row of [1, 2, 3]) {
      line.local(setCell(row, "x"));
      await tick(200);
    }
    await tick(RETRY.fastMs);
    last().open();
    last().say({ t: "state", rev: 900, mark: "m1", snapshot: JSON.stringify({ id: "u1" }) });
    expect(seen.said.at(-1)).toEqual([{ kind: "dropped", edits: 3, why: "changed" }, true]);
    line.stop();
  });

  it("says its selection when it changed, four times a second at most, and again to a new socket", async () => {
    const { line } = await up();
    const range = { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 };
    const said = () => last().sent.filter((f) => f.t === "presence");
    line.select({ sheet: "s1", range });
    await tick();
    expect(said()).toEqual([{ t: "presence", sheet: "s1", range }]);
    // The same selection again says nothing.
    line.select({ sheet: "s1", range });
    await tick(SELECTION_EVERY_MS);
    expect(said()).toHaveLength(1);
    for (let i = 2; i < 12; i++) line.select({ sheet: "s1", range: { ...range, startRow: i, endRow: i } });
    await tick(SELECTION_EVERY_MS);
    // Ten moves in one beat: only where it ended up is said.
    expect(said()).toHaveLength(2);
    expect(said()[1]).toMatchObject({ range: { startRow: 11 } });
    line.select(null);
    await tick(SELECTION_EVERY_MS);
    expect(said()[2]).toEqual({ t: "presence", range: null });
    line.select({ sheet: "s1", range });
    await tick(SELECTION_EVERY_MS);
    last().drop();
    await tick(RETRY.fastMs);
    last().open();
    last().say({ t: "state", rev: 4, mark: "m1", ops: [] });
    expect(said()).toEqual([{ t: "presence", sheet: "s1", range }]);
    line.stop();
  });
});
