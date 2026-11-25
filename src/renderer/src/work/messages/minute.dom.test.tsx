// @vitest-environment jsdom
/**
 * Messages over a long day (perf pass M12): a chat row is handed its time in words, so the minute's tick draws again
 * only the rows whose words change; a conversation's blocks that say what they said stay the same objects.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useSyncExternalStore } from "react";

/** A chat row reads its second line once a draw: the count of draws by the row's id. */
const draws = vi.hoisted(() => new Map<string, number>());
vi.mock("./model", async (original) => {
  const real = await original<typeof import("./model")>();
  return {
    ...real,
    rowLine: (row: { _id: string }) => {
      draws.set(row._id, (draws.get(row._id) ?? 0) + 1);
      return real.rowLine(row as never);
    },
  };
});
vi.mock("../shell/open", () => ({ openConnections: () => {} }));

const { MessagesDataProvider } = await import("./data");
const { MessagesScreen } = await import("./MessagesView");
const { CHATS, fixtureData, JOB, NOW } = await import("./fixtures");
const { blocksOf, rowTime } = await import("./model");
const { keepBlocks } = await import("./Conversation");
const { resetPages } = await import("./page");

beforeAll(() => {
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  resetPages();
  draws.clear();
});

/** The window's minute, moved by hand. */
let now = NOW;
const heard = new Set<() => void>();
const useNow = (): number => useSyncExternalStore((fn) => (heard.add(fn), () => void heard.delete(fn)), () => now);
const tick = (ms: number): void =>
  act(() => {
    now += ms;
    for (const fn of heard) fn();
  });

describe("Messages and the minute", () => {
  it("a minute's tick draws only the chat rows whose time words change", () => {
    now = NOW;
    const data = { ...fixtureData(), useNow };
    render(
      <MessagesDataProvider value={data}>
        <MessagesScreen workspaceId="ws" job={JOB} narrow={false} />
      </MessagesDataProvider>,
    );
    const before = new Map(draws);
    const changing = CHATS.filter((c) => before.has(c._id) && rowTime(c.lastAt, now) !== rowTime(c.lastAt, now + 60_000)).map((c) => c._id);
    tick(60_000);
    const drawn = [...draws].filter(([id, n]) => n !== before.get(id)).map(([id]) => id);
    expect(drawn.sort()).toEqual(changing.sort());
    expect(before.size).toBeGreaterThan(drawn.length);
  });

  it("a conversation's blocks that say what they said stay the same objects; the same array when nothing moved", async () => {
    const { MESSAGES } = await import("./fixtures");
    const rows = [...MESSAGES.c_dana!].reverse();
    const first = blocksOf(rows, null, NOW);
    const kept = keepBlocks([], first);
    // A minute later the day words stand: nothing moved.
    expect(keepBlocks(kept, blocksOf(rows, null, NOW + 60_000))).toBe(kept);
    // Midnight's day words change: those blocks are new, and only those.
    const later = keepBlocks(kept, blocksOf(rows, null, NOW + 3 * 86_400_000));
    expect(later.filter((b, i) => b !== kept[i]).every((b) => b.day !== null)).toBe(true);
  });
});
