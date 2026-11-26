import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The saved layout at boot (lib/sessionStore.ts): the read's socket deadline starts only once main has answered
 * the port, and a read that failed holds the slot's saves, so a slow server boot never costs him his tabs.
 */
type Listener = () => void;
function fakeLink(saved: unknown) {
  const opens = new Set<Listener>();
  const link = {
    connected: false,
    asked: [] as string[],
    request: async (method: string) => {
      link.asked.push(method);
      return method === "workspace.getSnapshot" ? saved : null;
    },
    onOpen: (fn: Listener) => (opens.add(fn), () => void opens.delete(fn)),
    open() {
      link.connected = true;
      for (const fn of [...opens]) fn();
    },
  };
  return link;
}

const SAVED = { tabs: ["t1", "t2"], activeTabId: "t2" };

async function boot(link: ReturnType<typeof fakeLink>) {
  let answerPort!: (port: number) => void;
  const port = new Promise<number>((resolve) => (answerPort = resolve));
  const asks = { port: 0 };
  vi.stubGlobal("window", { api: { getServerPort: () => (asks.port++, port), win: { slot: "main" } } });
  vi.resetModules();
  const native = await import("./native");
  native.bindServer({ linkOf: () => link });
  const store = await import("./sessionStore");
  return { store, answerPort, asks };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the saved layout at boot", () => {
  it("a server that takes 20 s to answer the port leaves the saved layout untouched and restores it", async () => {
    const link = fakeLink(SAVED);
    const { store, answerPort, asks } = await boot(link);
    const read = store.loadWorkspaceSnapshot();
    await vi.advanceTimersByTimeAsync(20_000);
    // nothing asked, no deadline run out, while main has not answered the port
    expect(link.asked).toEqual([]);
    answerPort(4321);
    await vi.advanceTimersByTimeAsync(0);
    link.open();
    await expect(read).resolves.toEqual(SAVED);
    expect(link.asked).toEqual(["workspace.getSnapshot"]);
    expect(store.workspaceSnapshotReadFailed()).toBe(false);
    await store.saveWorkspaceSnapshot(SAVED);
    expect(link.asked).toEqual(["workspace.getSnapshot", "workspace.setSnapshot"]);
    expect(asks.port).toBe(1);
  });

  it("a read that fails is not an empty slot: the slot's saves are held, its layout never written over", async () => {
    const link = fakeLink(SAVED);
    const { store, answerPort } = await boot(link);
    const read = store.loadWorkspaceSnapshot();
    const failed = expect(read).rejects.toThrow("server not connected");
    answerPort(4321);
    // the socket never opens: the read's own deadline runs out
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(store.workspaceSnapshotReadFailed()).toBe(true);
    link.open();
    await store.saveWorkspaceSnapshot({ tabs: [], activeTabId: null });
    expect(link.asked).toEqual([]);
  });
});
