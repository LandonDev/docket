import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAND_BACK_AFTER_MS, holdDrive } from "./driveHold";

/** His drive lasts while a place of his shows the computer: the last to go hands it back, after a moment. */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the places that hold his drive", () => {
  it("hand it back once the last one goes and none comes back within the moment", async () => {
    const back = vi.fn(async () => undefined);
    const page = holdDrive("box\nvm:windows", back);
    const full = holdDrive("box\nvm:windows", back);
    page(true);
    vi.advanceTimersByTime(HAND_BACK_AFTER_MS * 2);
    expect(back).not.toHaveBeenCalled();
    full(true);
    vi.advanceTimersByTime(HAND_BACK_AFTER_MS - 1);
    expect(back).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("keep it when another place takes over within the moment (the page giving way to the full window)", () => {
    const back = vi.fn(async () => undefined);
    holdDrive("box\nvm:windows", back)(true);
    vi.advanceTimersByTime(HAND_BACK_AFTER_MS / 2);
    const full = holdDrive("box\nvm:windows", back);
    vi.advanceTimersByTime(HAND_BACK_AFTER_MS * 2);
    expect(back).not.toHaveBeenCalled();
    full(true);
    vi.advanceTimersByTime(HAND_BACK_AFTER_MS);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("let go without handing back when he handed back himself, and count each place once", () => {
    const back = vi.fn(async () => undefined);
    const release = holdDrive("box\nbrowser:t1", back);
    release(false);
    release(true);
    vi.advanceTimersByTime(HAND_BACK_AFTER_MS * 2);
    expect(back).not.toHaveBeenCalled();
    // another computer's places are their own
    holdDrive("box\nvm:windows", back);
    holdDrive("box\nbrowser:t2", back)(true);
    vi.advanceTimersByTime(HAND_BACK_AFTER_MS);
    expect(back).toHaveBeenCalledTimes(1);
  });
});
