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

const { asUpdate, docHost } = await import("./host");

afterEach(() => link.request.mockReset());

/** Hocuspocus frames: the address ("d1"), the type, then a step or a flag. */
const frame = (type: number, next: number, ...rest: number[]) => new Uint8Array([2, 100, 49, type, next, ...rest]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const bytesOf = (f: string) => [...atob(f)].map((c) => c.charCodeAt(0));

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
    const draft = [b64(frame(0, 2, 42))];
    // A socket that has not sent its own state takes no draft yet.
    expect(host.replay!(draft)).toBe(false);
    ws.send(frame(0, 1, 1));
    expect(host.replay!(draft)).toBe(true);
    await settle();
    expect(h.sent).toContainEqual([...frame(0, 2, 42)]);
    expect(heard).toContainEqual([...frame(0, 2, 42)]);
  });

  it("reads a frame as an update only when it carries SyncStep2 or an Update", () => {
    expect([...asUpdate(frame(4, 1, 5, 6))!]).toEqual([...frame(0, 2, 5, 6)]);
    expect(asUpdate(frame(0, 0, 5))).toBeNull(); // SyncStep1 asks; it carries none of his
    expect(asUpdate(frame(1, 3))).toBeNull();
    expect(asUpdate(frame(8, 1))).toBeNull();
  });
});
