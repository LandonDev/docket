import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A relayed socket whose frames the host pushes (perf M11): they come as `work.docs.frames` on the window's own
 * socket, in order, with no `work.docs.recv`; one seen already is dropped, a gap or the link closing closes the socket
 * (the provider then makes another and syncs again); a host that answers no `push` is read by `recv` as before.
 */

type Push = { push: string; socket?: string; seq?: number; frames?: string[]; closed?: { code: number; reason: string } };
const pushes = new Set<(push: Push) => void>();
const closes = new Set<() => void>();
const link = {
  request: vi.fn<(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<unknown>>(),
  onPush: (listener: (push: Push) => void) => (pushes.add(listener), () => void pushes.delete(listener)),
  onClose: (listener: () => void) => (closes.add(listener), () => void closes.delete(listener)),
};
vi.mock("../../lib/connection", () => ({ registry: { linkOf: () => link } }));

const { relaySocket } = await import("./host");

const FILE = { at: "file", host: "box", path: "/Cosmic/Plan.tcdoc" } as const;
const b64 = (text: string): string => btoa(text);
const push = (p: Omit<Push, "push">): void => {
  for (const listener of [...pushes]) listener({ push: "work.docs.frames", ...p });
};

afterEach(() => {
  link.request.mockReset();
  pushes.clear();
  closes.clear();
});

async function opened(answer: Record<string, unknown>) {
  link.request.mockImplementation(async (method) => (method === "work.docs.connect" ? answer : method === "work.docs.recv" ? new Promise(() => undefined) : { ok: true }));
  const Socket = relaySocket("box", FILE);
  const ws = new Socket("ws://x/w/doc/file%3A1?schema=1");
  const heard: string[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  ws.addEventListener("message", (e) => void heard.push(new TextDecoder().decode((e as MessageEvent).data as ArrayBuffer)));
  ws.addEventListener("close", (e) => void closed.push({ code: (e as CloseEvent).code, reason: (e as CloseEvent).reason }));
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  return { ws, heard, closed };
}

const methods = (): string[] => link.request.mock.calls.map(([m]) => m);

describe("a document's frames pushed to the window", () => {
  it("asks for pushes, and a frame from the service reaches the editor with no work.docs.recv", async () => {
    const { heard } = await opened({ socket: "s1", push: true });
    expect(link.request.mock.calls[0]).toEqual(["work.docs.connect", { source: FILE, schema: 1, push: true }]);
    push({ socket: "s1", seq: 1, frames: [b64("hello")] });
    push({ socket: "other", seq: 1, frames: [b64("not mine")] });
    expect(heard).toEqual(["hello"]);
    expect(methods()).not.toContain("work.docs.recv");
  });

  it("takes them in order, none twice, and closes on a gap so the editor syncs on a new socket", async () => {
    const { heard, closed } = await opened({ socket: "s1", push: true });
    push({ socket: "s1", seq: 1, frames: [b64("one")] });
    push({ socket: "s1", seq: 2, frames: [b64("two"), b64("three")] });
    push({ socket: "s1", seq: 2, frames: [b64("two"), b64("three")] });
    push({ socket: "s1", seq: 4, frames: [b64("five")] });
    push({ socket: "s1", seq: 5, frames: [b64("six")] });
    expect(heard).toEqual(["one", "two", "three"]);
    expect(closed).toEqual([{ code: 1006, reason: "Frames from the host were lost" }]);
    expect(link.request.mock.calls.find(([m]) => m === "work.docs.close")?.[1]).toEqual({ socket: "s1" });
    expect(pushes.size).toBe(0);
  });

  it("closes as the host says in its last push, and when the link to the host closes", async () => {
    const a = await opened({ socket: "s1", push: true });
    push({ socket: "s1", seq: 1, frames: [], closed: { code: 4403, reason: "stop" } });
    expect(a.closed).toEqual([{ code: 4403, reason: "stop" }]);
    const b = await opened({ socket: "s2", push: true });
    for (const close of [...closes]) close();
    expect(b.closed).toEqual([{ code: 1006, reason: "The connection to the host closed" }]);
    expect(closes.size).toBe(0);
  });

  it("reads by work.docs.recv where the host answers no push, as a host a release behind does", async () => {
    await opened({ socket: "s1" });
    await vi.waitFor(() => expect(methods()).toContain("work.docs.recv"));
    expect(pushes.size).toBe(0);
  });
});
