import { afterEach, expect, it, vi } from "vitest";
import {
  beginRevealNavigation, cancelRevealReads, mayMarkRevealRead, onRevealReadChange, prepareRevealReads, REVEAL_READ_LIMIT_MS,
} from "./revealRead";

function inputTarget() {
  const target = new EventTarget();
  const on = vi.spyOn(target, "addEventListener");
  return {
    target,
    press() {
      const keydown = on.mock.calls.find(([kind]) => kind === "keydown")?.[1] as EventListener;
      keydown({ isTrusted: true } as Event);
    },
  };
}

afterEach(() => vi.useRealTimers());

it("waits for trusted local input after completed navigation", () => {
  const { target, press } = inputTarget();
  const states: boolean[] = [];
  const off = onRevealReadChange(() => states.push(mayMarkRevealRead()));
  prepareRevealReads(target, "1");
  const finish = beginRevealNavigation(target, "1");
  target.dispatchEvent(new Event("focus"));
  target.dispatchEvent(new Event("pointerdown"));
  press();
  cancelRevealReads("1");
  expect(mayMarkRevealRead()).toBe(false);
  finish();
  finish();
  cancelRevealReads("1");
  expect(mayMarkRevealRead()).toBe(false);
  press();
  expect(states).toEqual([false, true]);
  off();
});

it("releases a refused prepare immediately and keeps another reveal's hold", () => {
  const { target } = inputTarget();
  prepareRevealReads(target, "refused");
  cancelRevealReads("refused");
  expect(mayMarkRevealRead()).toBe(true);

  const current = inputTarget();
  prepareRevealReads(current.target, "refused");
  beginRevealNavigation(current.target, "shown")();
  cancelRevealReads("refused");
  expect(mayMarkRevealRead()).toBe(false);
  current.press();
  expect(mayMarkRevealRead()).toBe(true);
});

it("releases a rejected opener without waiting for input", () => {
  const { target } = inputTarget();
  const finish = beginRevealNavigation(target, "rejected");
  finish(false);
  expect(mayMarkRevealRead()).toBe(true);
  finish();
  expect(mayMarkRevealRead()).toBe(true);
});

it.each(["prepare", "opener"])("releases a stalled %s after ten seconds even without local input", (stage) => {
  vi.useFakeTimers();
  const { target } = inputTarget();
  prepareRevealReads(target, "stalled");
  const finish = stage === "opener" ? beginRevealNavigation(target, "stalled") : undefined;
  vi.advanceTimersByTime(REVEAL_READ_LIMIT_MS - 1);
  expect(mayMarkRevealRead()).toBe(false);
  vi.advanceTimersByTime(1);
  expect(mayMarkRevealRead()).toBe(true);
  finish?.();
  expect(mayMarkRevealRead()).toBe(true);
});
