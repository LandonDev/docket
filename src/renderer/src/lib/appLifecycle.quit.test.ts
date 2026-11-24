import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Quit and window close send what a Files tab still holds (docs/agents/work-files.md "Quitting, or closing the
 * window"): a deck's typed words, a text file's waiting save, a sheet's waiting cells. Before, both persisted the
 * layout and the chat drafts alone, and those words were lost with the window.
 */
const calls = vi.hoisted(() => [] as string[]);
vi.mock("./native", () => ({
  invoke: async (command: string) => void calls.push(command),
  ask: async () => true,
  windowPersisted: () => void calls.push("persisted"),
}));
vi.mock("./sessionStore", async (original) => ({
  ...(await original<typeof import("./sessionStore")>()),
  saveWorkspaceSnapshot: async () => void calls.push("snapshot"),
}));

const { persistAndCloseWindow, persistQuitState } = await import("./appLifecycle");
const { QUIT_FLUSH_MS, registerFlush } = await import("../work/canvas/flush");

afterEach(() => {
  calls.length = 0;
  vi.useRealTimers();
});

describe("quit and window close send what the Files tabs hold", () => {
  it("waits for every item's send before the quit goes on", async () => {
    let land!: () => void;
    const off = registerFlush("deck", () => new Promise<void>((done) => (land = () => (calls.push("deck sent"), done()))));
    let ended = false;
    const quit = persistQuitState([], [], "", "/repo").then(() => void (ended = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(ended).toBe(false);
    land();
    await quit;
    expect(calls).toEqual(expect.arrayContaining(["deck sent", "snapshot"]));
    off();
  });

  it("closes the window only once the items' sends are in, and never waits on one past its limit", async () => {
    vi.useFakeTimers();
    const sent = vi.fn(async () => void calls.push("text sent"));
    const offText = registerFlush("text", sent);
    const offStuck = registerFlush("stuck", () => new Promise(() => undefined));
    const closed = persistAndCloseWindow([], [], "", "/repo");
    await vi.advanceTimersByTimeAsync(QUIT_FLUSH_MS - 1);
    expect(calls).not.toContain("destroy_window");
    await vi.advanceTimersByTimeAsync(1);
    await closed;
    expect(sent).toHaveBeenCalledOnce();
    expect(calls.indexOf("text sent")).toBeLessThan(calls.indexOf("destroy_window"));
    offText();
    offStuck();
  });

  it("fits inside the time main gives a window to persist on quit", () => {
    // src/main/windows.ts PERSIST_TIMEOUT_MS: 2 s for every window but the one asked first.
    expect(QUIT_FLUSH_MS).toBeLessThan(2000);
  });
});
