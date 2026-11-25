import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A document's updates the service never said it applied survive a crash (docs/agents/work-files.md "Drafts survive a
 * crash"): kept as their socket sends them, let go once applied, and sent again up an open socket by Restore, which
 * also hands them to the editor's provider as the service's.
 */

const link = {
  request: vi.fn<(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<unknown>>(),
  onPush: vi.fn(() => () => undefined),
  onClose: vi.fn(() => () => undefined),
};
vi.mock("../../lib/connection", () => ({ registry: { linkOf: () => link } }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ message: vi.fn() }) }));

const Y = await import("yjs");
const { asUpdate, docHost, draftFits, draftWords, syncPayload } = await import("./host");

afterEach(() => link.request.mockReset());

/** Hocuspocus frames: the address ("d1"), the type, then a step or a flag. */
const frame = (type: number, next: number, ...rest: number[]) => new Uint8Array([2, 100, 49, type, next, ...rest]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const bytesOf = (f: string) => [...atob(f)].map((c) => c.charCodeAt(0));
/** A Sync frame of "d1" carrying `payload` as its step's bytes (a state vector for step 0, an update for 2). */
const sync = (step: number, payload: Uint8Array) => new Uint8Array([2, 100, 49, 0, step, ...lengthOf(payload.length), ...payload]);
function lengthOf(n: number): number[] {
  const out: number[] = [];
  for (; n >= 0x80; n = Math.floor(n / 0x80)) out.push((n & 0x7f) | 0x80);
  return [...out, n];
}
/** The document as the service holds it, a window's draft typed on it, and the same words typed on a document made again. */
function documents() {
  const served = new Y.Doc();
  served.getText("t").insert(0, "Budget for the spring LAN");
  const window = new Y.Doc();
  Y.applyUpdate(window, Y.encodeStateAsUpdate(served));
  const before = Y.encodeStateVector(window);
  window.getText("t").insert(6, " and staffing");
  const draft = [b64(sync(2, Y.encodeStateAsUpdate(window, before)))];
  // Remade: the same words written again from nothing (a Word file imported again), none of the old text's ids.
  const remade = new Y.Doc();
  remade.getText("t").insert(0, "Budget for the spring LAN");
  return { served, draft, remade };
}

function fakeHost() {
  const inbox: string[] = [];
  let wake: () => void = () => undefined;
  const sent: number[][] = [];
  link.request.mockImplementation(async (method, params) => {
    if (method === "work.docs.connect") return { socket: "s".repeat(24) };
    if (method === "work.docs.recv") {
      while (!inbox.length) await new Promise<void>((resolve) => (wake = resolve));
      return { frames: inbox.splice(0) };
    }
    if (method === "work.docs.send") sent.push(...((params.frames as string[]) ?? []).map(bytesOf));
    return { ok: true };
  });
  return { sent, down: (...frames: string[]) => (inbox.push(...frames), wake()) };
}

async function opened() {
  const h = fakeHost();
  const host = docHost("env_box", { at: "file", host: "env_box", path: "/w/Plan.tcdoc" });
  const kept: (string[] | null)[] = [];
  host.keepDrafts!({ keep: (frames) => void kept.push([...frames]), clear: () => void kept.push(null) });
  const ws = new host.socket("ws://x/w/doc/d1");
  const heard: number[][] = [];
  ws.addEventListener("message", (e) => heard.push([...new Uint8Array((e as MessageEvent).data as ArrayBuffer)]));
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  return { h, host, ws, kept, heard };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("a document's updates the service has not applied", () => {
  it("are kept on this computer as Update frames as they go up, and let go once the service applied every one", async () => {
    const { h, ws, kept } = await opened();
    ws.send(frame(4, 1, 7)); // its state, as a SyncReply carrying SyncStep2
    ws.send(frame(0, 2, 9)); // an update
    ws.send(frame(1, 0)); // awareness: not his edit
    expect(kept.at(-1)!.map(bytesOf)).toEqual([[...frame(0, 2, 7)], [...frame(0, 2, 9)]]);
    await settle();
    h.down(b64(frame(8, 1)), b64(frame(8, 1)));
    await settle();
    expect(kept.at(-1)).toBeNull();
  });

  it("are sent up the open socket again by Restore and handed to the editor as the service's; with no socket ready, nothing", async () => {
    const { h, host, ws, heard } = await opened();
    const { served, draft } = documents();
    // A socket that has not sent its own state, or not heard what the service holds, takes no draft yet.
    expect(host.replay!(draft)).toBe("later");
    ws.send(frame(0, 1, 1));
    expect(host.replay!(draft)).toBe("later");
    h.down(b64(sync(0, Y.encodeStateVector(served))));
    await settle();
    expect(host.replay!(draft)).toBe("sent");
    await settle();
    expect(h.sent).toContainEqual(bytesOf(draft[0]!));
    expect(heard).toContainEqual(bytesOf(draft[0]!));
  });

  it("sends nothing of a draft made on a document made again since, which Yjs would hold unseen", async () => {
    const { h, host, ws, heard } = await opened();
    const { draft, remade } = documents();
    ws.send(frame(0, 1, 1));
    h.down(b64(sync(0, Y.encodeStateVector(remade))));
    await settle();
    const before = h.sent.length;
    expect(host.replay!(draft)).toBe("changed");
    await settle();
    expect(h.sent).toHaveLength(before);
    expect(heard).not.toContainEqual(bytesOf(draft[0]!));
  });

  it("judges a draft by what the service holds: it fits the document it was typed on, not one made again, and its words can be copied out", () => {
    const { served, draft, remade } = documents();
    expect(draftFits(draft, Y.decodeStateVector(Y.encodeStateVector(served)))).toBe(true);
    // Yjs agrees: on the remade document the draft's words never show, held as pending structs.
    const onRemade = new Y.Doc();
    Y.applyUpdate(onRemade, Y.encodeStateAsUpdate(remade));
    Y.applyUpdate(onRemade, syncPayload(new Uint8Array(bytesOf(draft[0]!)))!.payload);
    expect(onRemade.getText("t").toString()).toBe("Budget for the spring LAN");
    expect(onRemade.store.pendingStructs).not.toBeNull();
    expect(draftFits(draft, Y.decodeStateVector(Y.encodeStateVector(remade)))).toBe(false);
    expect(draftWords(draft)).toBe(" and staffing");
  });

  it("reads a frame as an update only when it carries SyncStep2 or an Update", () => {
    expect([...asUpdate(frame(4, 1, 5, 6))!]).toEqual([...frame(0, 2, 5, 6)]);
    expect(asUpdate(frame(0, 0, 5))).toBeNull(); // SyncStep1 asks; it carries none of his
    expect(asUpdate(frame(1, 3))).toBeNull();
    expect(asUpdate(frame(8, 1))).toBeNull();
  });
});
