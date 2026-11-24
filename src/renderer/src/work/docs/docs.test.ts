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
const { NOT_SENT, docHost, relaySocket, servedBy, storedAll } = await import("./host");
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

  it("a close sends what waits behind a send in flight before the host's socket closes; the flush asks the host to store after the last frame", async () => {
    const calls: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    link.request.mockImplementation(async (method, params) => {
      if (method === "work.docs.connect") return { socket: "s".repeat(24) };
      if (method === "work.docs.recv") return new Promise(() => undefined);
      if (method === "work.docs.send") {
        calls.push(`send ${(params.frames as string[]).map((f) => atob(f)).join(",")}${params.stored ? " stored" : ""}`);
        if (calls.length === 1) await held;
        return { ok: true };
      }
      calls.push(method);
      return { ok: true };
    });
    const Socket = relaySocket("env_box", { at: "lifeos", table: "docs", id: "d1" });
    const ws = new Socket("ws://x/w/doc/d1");
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    ws.send(new TextEncoder().encode("a"));
    ws.send(new TextEncoder().encode("b"));
    ws.send(new TextEncoder().encode("c"));
    const flushed = storedAll(Socket);
    release();
    await flushed;
    expect(calls).toEqual(["send a", "send b,c", "send  stored"]);
    // Typed, then closed at once: the frames go up, then the close.
    calls.length = 0;
    let again: () => void = () => undefined;
    const second = new Promise<void>((resolve) => (again = resolve));
    link.request.mockImplementation(async (method, params) => {
      if (method === "work.docs.send") {
        calls.push(`send ${(params.frames as string[]).map((f) => atob(f)).join(",")}`);
        if (calls.length === 1) await second;
        return { ok: true };
      }
      calls.push(method);
      return { ok: true };
    });
    ws.send(new TextEncoder().encode("d"));
    ws.send(new TextEncoder().encode("e"));
    ws.close();
    expect(ws.readyState).toBe(3);
    again();
    await vi.waitFor(() => expect(calls).toEqual(["send d", "send e", "work.docs.close"]));
    // A closed socket has nothing left to store.
    await storedAll(Socket);
    expect(calls).toHaveLength(3);
  });

  it("the flush fails when a send fails or nothing is connected, and passes again once a later store is confirmed", async () => {
    let refuse = true;
    link.request.mockImplementation(async (method, params) => {
      if (method === "work.docs.connect") return { socket: "s".repeat(24) };
      if (method === "work.docs.recv") return new Promise(() => undefined);
      if (method === "work.docs.send" && refuse && (params.frames as string[]).length) throw new Error("host offline");
      return { ok: true };
    });
    const Socket = relaySocket("env_box", { at: "lifeos", table: "docs", id: "d1" });
    const ws = new Socket("ws://x/w/doc/d1");
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    ws.send(new TextEncoder().encode("a"));
    // The send fails, the socket closes, and what it carried never reached the host: the flush says so.
    await expect(storedAll(Socket)).rejects.toThrow("host offline");
    expect(ws.readyState).toBe(3);
    await expect(storedAll(Socket)).rejects.toThrow("host offline");
    // The provider's next socket, not connected yet: still not stored.
    refuse = false;
    let connect: (v: { socket: string }) => void = () => undefined;
    link.request.mockImplementation(async (method) => {
      if (method === "work.docs.connect") return new Promise((resolve) => (connect = resolve));
      if (method === "work.docs.recv") return new Promise(() => undefined);
      return { ok: true };
    });
    const again = new Socket("ws://x/w/doc/d1");
    await expect(storedAll(Socket)).rejects.toThrow(NOT_SENT);
    connect({ socket: "t".repeat(24) });
    await new Promise((resolve) => again.addEventListener("open", resolve));
    // Connected and stored: the loss is behind it.
    await expect(storedAll(Socket)).resolves.toBeUndefined();
    await expect(storedAll(Socket)).resolves.toBeUndefined();
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
