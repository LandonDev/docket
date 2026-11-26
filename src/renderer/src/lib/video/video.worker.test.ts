import { afterEach, expect, it, vi } from "vitest";
import { VIDEO_CLOSE } from "@server/shared/contract-video";
import type { FromWorker, ToWorker } from "./messages";
import type { PlayerEvents } from "./player";

const players = vi.hoisted(() => [] as { frames: number; events: PlayerEvents; ping: ReturnType<typeof vi.fn> }[]);
vi.mock("./player", () => ({
  StreamPlayer: class {
    frames = 0;
    ping = vi.fn();

    constructor(_url: string, _deps: unknown, readonly events: PlayerEvents) {
      players.push(this);
    }

    check() {}
    close() {}
    timing() {
      return { drawMs: 7, roundTripMs: 24, captureMs: 6 };
    }
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  players.length = 0;
});

it("reports drawn frames per second through idle periods and tracks slow closes across reopens", async () => {
  vi.useFakeTimers();
  const posted: FromWorker[] = [];
  const scope = { postMessage: (message: FromWorker) => posted.push(message), onmessage: null as ((event: { data: ToWorker }) => void) | null };
  vi.stubGlobal("self", scope);
  await import("./video.worker");
  const open = () => scope.onmessage?.({ data: { t: "open", stream: 1, url: "ws://example.test/video/1", drive: true } });
  open();
  players[0].frames = 48;
  await vi.advanceTimersByTimeAsync(1000);
  expect(posted.at(-1)).toMatchObject({ t: "reading", reading: { fps: 48, drawMs: 7, captureMs: 6, roundTripMs: 24, link: "good" } });
  expect(players[0].ping).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(posted.at(-1)).toMatchObject({ t: "reading", reading: { fps: 0 } });
  players[0].events.closed(VIDEO_CLOSE.slow);
  expect(posted.at(-1)).toMatchObject({ t: "closed", link: "good" });
  open();
  players[1].events.closed(VIDEO_CLOSE.slow);
  expect(posted.at(-1)).toMatchObject({ t: "closed", link: "poor" });
  open();
  await vi.advanceTimersByTimeAsync(5000);
  expect(posted.at(-1)).toMatchObject({ t: "reading", reading: { link: "good" } });
});

it("runs no interval without a player: the counts and readings start with the first and stop with the last", async () => {
  vi.useFakeTimers();
  const scope = { postMessage: () => {}, onmessage: null as ((event: { data: ToWorker }) => void) | null };
  vi.stubGlobal("self", scope);
  await import("./video.worker");
  expect(vi.getTimerCount()).toBe(0);
  const open = (stream: number) => scope.onmessage?.({ data: { t: "open", stream, url: `ws://example.test/video/${stream}`, drive: true } });
  open(1);
  open(2);
  expect(vi.getTimerCount()).toBe(2);
  scope.onmessage?.({ data: { t: "close", stream: 1 } });
  expect(vi.getTimerCount()).toBe(2);
  players[1].events.closed(VIDEO_CLOSE.slow);
  expect(vi.getTimerCount()).toBe(0);
  open(3);
  expect(vi.getTimerCount()).toBe(2);
  scope.onmessage?.({ data: { t: "close", stream: 3 } });
  expect(vi.getTimerCount()).toBe(0);
});
