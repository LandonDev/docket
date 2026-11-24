import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryBranch } from "@shared/contract-work-history";

/*
 * The document canvas's own logic, without an editor on screen: pending
 * branches as the editor's review, the socket relayed over the host link,
 * the comment threads adapter, and presence in the pane's palette.
 */

const link = {
  request: vi.fn<(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<unknown>>(),
  onPush: vi.fn(() => () => undefined),
};
vi.mock("../../lib/connection", () => ({ registry: { linkOf: () => link } }));
const said = vi.fn();
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ message: said }) }));

const { changeId, decided, reviewOf } = await import("./review");
const { NOT_SENT, NOT_TAKEN, docHost, frameHead, relaySocket, relayTiming, servedBy, storedAll } = await import("./host");
const { docThreads } = await import("./threads");
const { presenceOf, undoWritten, writtenLine, CHANGED_SINCE, UNDO_ELSEWHERE } = await import("./DocumentCanvas");

afterEach(() => {
  link.request.mockReset();
});

const branch = (rows: HistoryBranch["diff"]["rows"], lines: HistoryBranch["diff"]["lines"] = []): HistoryBranch => ({
  id: "b1",
  baseVersionId: "v1",
  authors: ["agent:env_box:t1"],
  label: "Agent",
  at: 1,
  editedAt: 1,
  diff: { stats: { same: 0, added: 0, removed: 0, changed: 0, moved: 0 }, rows, lines },
});
const block = (id: string, text: string) => ({ id, type: "paragraph", props: {}, text, runs: [{ text }], depth: 0, parent: null, index: 0 });

describe("suggestions as the editor's review", () => {
  it("cuts a changed line into its pieces, each its own change Accept names by piece", () => {
    const { changes, groups } = reviewOf(
      [
        branch([
          {
            kind: "changed",
            id: "p1",
            left: block("p1", "Setup at 8:00 in the north hall"),
            right: block("p1", "Setup at 7:30 in the south hall"),
            inline: [
              { op: "=", text: "Setup at " },
              { op: "-", text: "8:00" },
              { op: "+", text: "7:30" },
              { op: "=", text: " in the " },
              { op: "-", text: "north" },
              { op: "+", text: "south" },
              { op: "=", text: " hall" },
            ],
          },
        ]),
      ],
      { "agent:env_box:t1": "Northside PT kickoff" },
    );
    expect(groups).toEqual([{ id: "b1", label: "Northside PT kickoff", by: "agent:env_box:t1" }]);
    expect(changes.map((c) => c.id)).toEqual([changeId("b1", "p1#0"), changeId("b1", "p1#1")]);
    expect(changes[1]!.marks).toEqual([
      { tone: "del", block: "p1", from: 21, to: 26 },
      { tone: "add", block: "p1", at: 26, text: "south" },
    ]);
    expect(decided(changes[1]!)).toEqual({ branchId: "b1", which: "p1#1" });
  });

  it("a block whose style or spacing changed is one change that says so in words; a change of words alone says nothing", () => {
    const heading = { ...block("h", "Run of show"), type: "heading", props: { level: 1 } };
    const spaced = { ...block("s", "Doors at nine"), props: { para: JSON.stringify({ lineSpacing: 2 }) } };
    const { changes } = reviewOf(
      [
        branch([
          { kind: "changed", id: "h", left: heading, right: block("h", "Run of show"), inline: [{ op: "=", text: "Run of show" }], typeChange: ["heading", "paragraph"] },
          { kind: "changed", id: "s", left: block("s", "Doors at nine"), right: spaced, inline: [{ op: "=", text: "Doors at nine" }], props: { para: ["", spaced.props.para] } },
          { kind: "changed", id: "w", left: block("w", "8:00"), right: block("w", "7:30"), inline: [{ op: "-", text: "8:00" }, { op: "+", text: "7:30" }] },
        ] as HistoryBranch["diff"]["rows"]),
      ],
      {},
    );
    expect(changes.map((c) => [decided(c).which, c.words])).toEqual([
      ["h", ["Heading 1 becomes Normal text"]],
      ["s", ["Line spacing set to 2"]],
      ["w#0", undefined],
    ]);
    // The restyled block is tinted whole: its words did not change.
    expect(changes[0]!.marks).toEqual([{ tone: "add", block: "h" }]);
  });

  it("a block put in follows the live block before it; one taken out, moved, or a table's cells are one change each", () => {
    const { changes } = reviewOf(
      [
        branch(
          [
            { kind: "added", id: "n", right: block("n", "New line") },
            { kind: "removed", id: "r", left: block("r", "Old line") },
            { kind: "changed", id: "t", cells: [[null, [{ op: "-", text: "Seats" }, { op: "+", text: "Chairs" }]]] },
          ],
          [
            { id: "a", left: block("a", "A"), right: block("a", "A"), row: null },
            { id: "n", left: null, right: block("n", "New line"), row: 0 },
            { id: "r", left: block("r", "Old line"), right: null, row: 1 },
          ],
        ),
      ],
      {},
    );
    expect(changes.map((c) => [decided(c).which, c.marks])).toEqual([
      ["n", [{ tone: "add", after: "a", text: "New line" }]],
      ["r", [{ tone: "del", block: "r" }]],
      [
        "t",
        [
          { tone: "del", block: "t", from: 0, to: 5, cell: [0, 1] },
          { tone: "add", block: "t", at: 5, text: "Chairs", cell: [0, 1] },
        ],
      ],
    ]);
  });
});

describe("the relayed socket", () => {
  it("opens once the host made its socket, sends frames in order, hands down what the host received, and closes when the host says", async () => {
    let recvs = 0;
    const sent: string[][] = [];
    link.request.mockImplementation(async (method, params) => {
      if (method === "work.docs.connect") return { socket: "s".repeat(24) };
      if (method === "work.docs.send") return void sent.push(params.frames as string[]);
      if (method === "work.docs.recv") {
        recvs += 1;
        return recvs === 1 ? { frames: [btoa("\u0001\u0002")] } : { frames: [], closed: { code: 4403, reason: "revoked" } };
      }
      return { ok: true };
    });
    const Socket = relaySocket("env_box", { at: "lifeos", table: "docs", id: "d1" });
    const ws = new Socket("ws://x/w/doc/d1");
    const events: string[] = [];
    const got: number[][] = [];
    ws.addEventListener("open", () => {
      events.push("open");
      ws.send(new Uint8Array([7, 8]));
      ws.send(new Uint8Array([9]));
    });
    ws.addEventListener("message", (e) => got.push([...new Uint8Array((e as MessageEvent).data as ArrayBuffer)]));
    const closed = new Promise<{ code: number }>((resolve) => ws.addEventListener("close", (e) => resolve(e as unknown as { code: number })));
    const done = await closed;
    expect(events).toEqual(["open"]);
    expect(got).toEqual([[1, 2]]);
    expect(done.code).toBe(4403);
    expect(sent.flat().map((f) => [...atob(f)].map((c) => c.charCodeAt(0)))).toEqual([[7, 8], [9]]);
    expect(ws.readyState).toBe(3);
    // The long ask is given time past the host's 20 s wait.
    expect(link.request.mock.calls.find(([m]) => m === "work.docs.recv")?.[2]).toEqual({ timeoutMs: 45_000 });
  });

  /** Hocuspocus frames as the provider and the service write them: the address, the type, then a step or a flag. */
  const frame = (type: number, next: number, ...rest: number[]) => new Uint8Array([2, 100, 49, type, next, ...rest]);
  const state = () => frame(0, 1, 0); // sync step 2: the window's state the host lacked
  const update = (n: number) => frame(0, 2, n); // an update
  const applied = (yes = true) => btoa(String.fromCharCode(...frame(8, yes ? 1 : 0)));
  const label = (f: string) => {
    const b = [...atob(f)].map((c) => c.charCodeAt(0));
    return b[3] === 0 ? (b[4] === 1 ? "state" : `update ${b[5]}`) : String.fromCharCode(...b);
  };
  /** A host that hands down what the test gives it, when it gives it. */
  const fakeHost = () => {
    const inbox: string[] = [];
    let wake: () => void = () => undefined;
    const calls: string[] = [];
    let hold: Promise<void> | null = null;
    link.request.mockImplementation(async (method, params) => {
      if (method === "work.docs.connect") return { socket: "s".repeat(24) };
      if (method === "work.docs.recv") {
        while (!inbox.length) await new Promise<void>((resolve) => (wake = resolve));
        return { frames: inbox.splice(0) };
      }
      if (method === "work.docs.send") {
        if (params.stored) calls.push("stored");
        else {
          calls.push(...(params.frames as string[]).map(label));
          if (hold) await hold;
        }
        return { ok: true };
      }
      calls.push(method);
      return { ok: true };
    });
    return {
      calls,
      down: (...frames: string[]) => {
        inbox.push(...frames);
        wake();
      },
      hold: (until: Promise<void> | null) => void (hold = until),
    };
  };
  const opened = async (Socket: new (url: string) => WebSocket) => {
    const ws = new Socket("ws://x/w/doc/d1");
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return ws;
  };

  it("the flush asks the host to store only once the service has applied every update the socket sent, its own state first", async () => {
    const h = fakeHost();
    const Socket = relaySocket("env_box", { at: "lifeos", table: "docs", id: "d1" });
    const ws = await opened(Socket);
    let done = false;
    const flushed = storedAll(Socket).then(() => void (done = true));
    // A new socket that has not sent its own state: nothing it holds is known to be there.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    ws.send(state());
    ws.send(update(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    // The first applied, the second not yet.
    h.down(applied());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    h.down(applied());
    await flushed;
    expect(h.calls).toEqual(["state", "update 1", "stored"]);
  });

  it("a close sends what waits behind a send in flight before the host's socket closes", async () => {
    const h = fakeHost();
    const Socket = relaySocket("env_box", { at: "lifeos", table: "docs", id: "d1" });
    const ws = await opened(Socket);
    let release: () => void = () => undefined;
    h.hold(new Promise<void>((resolve) => (release = resolve)));
    ws.send(update(1));
    ws.send(update(2));
    ws.send(update(3));
    ws.close();
    expect(ws.readyState).toBe(3);
    release();
    await vi.waitFor(() => expect(h.calls).toEqual(["update 1", "update 2", "update 3", "work.docs.close"]));
  });

  it("the flush fails when a send fails, when the host refuses an update, or when the socket never sends its state; a later confirmed store passes", async () => {
    relayTiming.syncWaitMs = 150;
    try {
      let refuse = true;
      link.request.mockImplementation(async (method, params) => {
        if (method === "work.docs.connect") return { socket: "s".repeat(24) };
        if (method === "work.docs.recv") return new Promise(() => undefined);
        if (method === "work.docs.send" && refuse && (params.frames as string[]).length) throw new Error("host offline");
        return { ok: true };
      });
      const Socket = relaySocket("env_box", { at: "lifeos", table: "docs", id: "d1" });
      const ws = await opened(Socket);
      ws.send(update(1));
      // The send fails, the socket closes, and what it carried never reached the host: the flush says so.
      await expect(storedAll(Socket)).rejects.toThrow("host offline");
      expect(ws.readyState).toBe(3);
      await expect(storedAll(Socket)).rejects.toThrow("host offline");
      // The provider's next socket: open, but its own state never goes up in time.
      refuse = false;
      const h = fakeHost();
      const again = await opened(Socket);
      await expect(storedAll(Socket)).rejects.toThrow(NOT_SENT);
      // It sends its state and hears it applied: the loss is behind it.
      again.send(state());
      h.down(applied());
      await expect(storedAll(Socket)).resolves.toBeUndefined();
      expect(h.calls.filter((c) => c === "stored")).toHaveLength(1);
      // An update the host refused (a read-only view): not stored.
      again.send(update(2));
      h.down(applied(false));
      await expect(storedAll(Socket)).rejects.toThrow(NOT_TAKEN);
    } finally {
      relayTiming.syncWaitMs = 6000;
    }
  });

  it("a socket the host dropped is waited out: the flush stores through the provider's next socket once it has caught up", async () => {
    relayTiming.syncWaitMs = 400;
    try {
      const inbox: { frames: string[]; closed?: { code: number; reason: string } }[] = [];
      let wake: () => void = () => undefined;
      const calls: string[] = [];
      let n = 0;
      link.request.mockImplementation(async (method, params) => {
        if (method === "work.docs.connect") return { socket: `s${++n}`.padEnd(24, "x") };
        if (method === "work.docs.recv") {
          while (!inbox.length) await new Promise<void>((resolve) => (wake = resolve));
          return inbox.shift();
        }
        if (method === "work.docs.send") calls.push(params.stored ? `stored ${String(params.socket).slice(0, 2)}` : "frames");
        return { ok: true };
      });
      const down = (got: { frames: string[]; closed?: { code: number; reason: string } }) => {
        inbox.push(got);
        wake();
      };
      const Socket = relaySocket("env_box", { at: "lifeos", table: "docs", id: "d1" });
      const first = await opened(Socket);
      first.send(state());
      down({ frames: [applied()] });
      await storedAll(Socket);
      expect(calls.filter((c) => c.startsWith("stored"))).toEqual(["stored s1"]);
      // The host drops it; he types, and closes before the provider has made its next socket.
      down({ frames: [], closed: { code: 1006, reason: "gone" } });
      await vi.waitFor(() => expect(first.readyState).toBe(3));
      const flushed = storedAll(Socket);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls.filter((c) => c.startsWith("stored"))).toEqual(["stored s1"]);
      // The provider's next socket sends the window's state, the edit among it, and hears it applied.
      const next = await opened(Socket);
      next.send(state());
      down({ frames: [applied()] });
      await flushed;
      expect(calls.filter((c) => c.startsWith("stored"))).toEqual(["stored s1", "stored s2"]);
      // Dropped, with no next socket in time: not stored.
      down({ frames: [], closed: { code: 1006, reason: "gone" } });
      await vi.waitFor(() => expect(next.readyState).toBe(3));
      await expect(storedAll(Socket)).rejects.toThrow(NOT_SENT);
    } finally {
      relayTiming.syncWaitMs = 6000;
    }
  });

  it("an update sent while the host stores is applied and stored in its turn before the flush passes", async () => {
    const h = fakeHost();
    const Socket = relaySocket("env_box", { at: "lifeos", table: "docs", id: "d1" });
    const ws = await opened(Socket);
    ws.send(state());
    h.down(applied());
    // The store is on its way when he types once more.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const base = link.request.getMockImplementation()!;
    link.request.mockImplementation(async (method, params, opts) => {
      const got = await base(method, params, opts);
      if (method === "work.docs.send" && params.stored && h.calls.filter((c) => c === "stored").length === 1) await held;
      return got;
    });
    let done = false;
    const flushed = storedAll(Socket).then(() => void (done = true));
    await vi.waitFor(() => expect(h.calls).toContain("stored"));
    ws.send(update(5));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    h.down(applied());
    await flushed;
    expect(h.calls).toEqual(["state", "stored", "update 5", "stored"]);
  });

  it("reads a frame's head as Hocuspocus writes it, and nothing from bytes that are not one", () => {
    expect(frameHead(state())).toEqual({ type: 0, step: 1, value: null });
    expect(frameHead(frame(8, 1))).toEqual({ type: 8, step: null, value: 1 });
    expect(frameHead(new Uint8Array([97]))).toBeNull();
    expect(frameHead(new Uint8Array([]))).toBeNull();
  });

  it("a document another host serves names that host", () => {
    expect(servedBy(new Error("served elsewhere: env_box"))).toBe("env_box");
    expect(servedBy(new Error("not found"))).toBeNull();
  });
});

describe("Undo of an agent's write", () => {
  const source = { at: "file", host: "env_box", path: "/w/Plan.tcdoc" } as const;
  const written = { text: "Wrote 1 section", at: 1, versionId: "v-before", after: "v-after" };

  it("asks the host alone, naming the write its line shows: the window compares nothing and restores nothing itself", async () => {
    said.mockReset();
    link.request.mockImplementation(async () => ({ ok: true }));
    const undo = vi.fn(async (_after: string) => "undone" as const);
    await writtenLine({ env: "env_box", undo }, source, written).undo!();
    expect(undo).toHaveBeenCalledWith("v-after");
    expect(link.request.mock.calls.map(([m]) => m).filter((m) => m === "work.history.compare" || m === "work.history.restore")).toEqual([]);
    expect(said).not.toHaveBeenCalled();
  });

  it("says why when the host restored nothing: the document changed since, or the host cannot undo it there", async () => {
    said.mockReset();
    link.request.mockImplementation(async () => ({ ok: true }));
    await undoWritten({ env: "env_box", undo: async () => "changed" }, source, "v-after");
    expect(said).toHaveBeenLastCalledWith(CHANGED_SINCE);
    await undoWritten({ env: "env_box", undo: async () => "unknown" }, source, "v-after");
    expect(said).toHaveBeenLastCalledWith(UNDO_ELSEWHERE);
  });

  it("offers no Undo on a line that names no version after the write", () => {
    const { after: _after, ...older } = written;
    const line = writtenLine({ env: "env_box", undo: async () => "undone" }, source, older);
    expect(line.undo).toBeUndefined();
    expect(line.text).toMatch(/^Wrote 1 section, /);
  });

  it("the host's undo is the dismiss with undo and the write's after, and reads what the host did", async () => {
    link.request.mockImplementation(async (method, params) => (method === "work.docs.dismiss" && params.undo ? { ok: true, undone: true } : { ok: true }));
    expect(await docHost("env_box", source).undo("v-after")).toBe("undone");
    expect(link.request).toHaveBeenLastCalledWith("work.docs.dismiss", { source, undo: true, after: "v-after" }, undefined);
    link.request.mockImplementation(async () => ({ ok: true, undone: false }));
    expect(await docHost("env_box", source).undo("v-after")).toBe("changed");
    // A host a release behind drops the field and answers no `undone`.
    link.request.mockImplementation(async () => ({ ok: true }));
    expect(await docHost("env_box", source).undo("v-after")).toBe("unknown");
  });
});

describe("the threads adapter", () => {
  it("reads once asked, again after a write and on the host's word", async () => {
    const rows = [{ thread: { publicId: "t1", resolved: false, resolvedAt: null, resolvedByMemberId: null, createdAt: 1, updatedAt: 1, deletedAt: null }, comments: [] }];
    const host = {
      threads: vi.fn(async () => ({ rows, names: { owner: "Landon" } })),
      thread: vi.fn(async () => ({ ok: true })),
    };
    const t = docThreads(host as never, "d1");
    const seen = vi.fn();
    t.adapter.subscribe("d1", seen);
    await vi.waitFor(() => expect(t.adapter.rows("d1")).toEqual(rows));
    expect(t.names()).toEqual({ owner: "Landon" });
    expect(t.adapter.rows("other")).toBeNull();
    await t.adapter.writes("d1").setResolved({ threadPublicId: "t1", resolved: true });
    expect(host.thread).toHaveBeenCalledWith({ op: "resolve", threadId: "t1", resolved: true });
    await vi.waitFor(() => expect(host.threads).toHaveBeenCalledTimes(2));
    t.refresh();
    await vi.waitFor(() => expect(host.threads).toHaveBeenCalledTimes(3));
    expect(seen).toHaveBeenCalled();
  });
});

describe("presence", () => {
  it("takes the pane's hue for the editor's caret colour", () => {
    const palette = ["#3b82f6", "#8b5cf6"];
    expect(presenceOf([{ id: "a", name: "Dana", avatarUrl: null, color: "#8B5CF6" }, { id: "b", name: "Sam", avatarUrl: "x.png", color: "#000000" }], palette)).toEqual([
      { id: "a", name: "Dana", hue: 2 },
      { id: "b", name: "Sam", image: "x.png" },
    ]);
  });
});
