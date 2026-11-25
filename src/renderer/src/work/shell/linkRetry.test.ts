/** Council round 12, the walk: Retry on "<host> is not connected" settles once the link has answered, never before. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";
import { retryLink } from "./linkRetry";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function link(start: string) {
  const at = { transport: start };
  const listeners = new Set<() => void>();
  vi.spyOn(registry, "statusOf").mockImplementation(() => at as never);
  vi.spyOn(registry, "subscribe").mockImplementation((fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  });
  const retry = vi.spyOn(registry, "retry").mockImplementation(() => {});
  return {
    retry,
    to(transport: string) {
      at.transport = transport;
      for (const fn of listeners) fn();
    },
  };
}

const settled = async (p: Promise<void>): Promise<boolean> => {
  let done = false;
  void p.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

describe("retryLink", () => {
  it("asks the link to try now and settles once it has tried and answered, open or not", async () => {
    const box = link("offline");
    const p = retryLink("env_box");
    expect(box.retry).toHaveBeenCalledWith("env_box");
    box.to("connecting");
    expect(await settled(p)).toBe(false);
    box.to("offline");
    expect(await settled(p)).toBe(true);
  });

  it("settles at once on a link that is open", async () => {
    link("open");
    expect(await settled(retryLink("env_box"))).toBe(true);
  });

  it("settles after a quiet spell when the link never starts trying, and by its limit whatever it does", async () => {
    vi.useFakeTimers();
    link("offline");
    const quiet = retryLink("env_box", 20_000, 2_000);
    vi.advanceTimersByTime(2_000);
    expect(await settled(quiet)).toBe(true);
    const box = link("offline");
    const long = retryLink("env_box", 20_000, 2_000);
    box.to("connecting");
    vi.advanceTimersByTime(19_000);
    expect(await settled(long)).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(await settled(long)).toBe(true);
  });
});
