import { describe, expect, it, vi } from "vitest";

/** The Work add menu's Retry: it asks the host's LifeOS status afresh and the session after it (`reopenLifeos`), where a second watch would start nothing. */

const lifeos = vi.hoisted(() => ({ refresh: vi.fn(async (_env: string, _sector: string | null) => undefined), watch: vi.fn() }));
vi.mock("./lifeos", async (original) => ({ ...(await original<object>()), reopenLifeos: lifeos.refresh, watchLifeos: lifeos.watch }));

const { retryLifeos } = await import("./WorkRailHost");

describe("the add menu's Retry", () => {
  it("asks the host's status now, never only a watch the rail already has", async () => {
    const fail = vi.fn();
    retryLifeos("env_box", fail);
    await Promise.resolve();
    expect(lifeos.refresh).toHaveBeenCalledWith("env_box", null);
    expect(lifeos.watch).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("says a status that did not come once, through the menu's error toast", async () => {
    const error = new Error("The host is not connected");
    lifeos.refresh.mockRejectedValueOnce(error);
    const fail = vi.fn();
    retryLifeos("env_box", fail);
    await vi.waitFor(() => expect(fail).toHaveBeenCalledWith(error));
  });

  it("says a Retry the host does not answer by the line alone, never a toast beside it (council round 9)", async () => {
    // The state before the press said something else (LifeOS did not answer): the Retry's own error decides.
    const { TimeoutError } = await import("../../lib/connection");
    lifeos.refresh.mockRejectedValueOnce(new TimeoutError("work.lifeos.status", 30_000));
    const fail = vi.fn();
    retryLifeos("env_box", fail);
    await new Promise((r) => setTimeout(r, 0));
    expect(fail).not.toHaveBeenCalled();
  });

  it("asks nothing with no home host", () => {
    lifeos.refresh.mockClear();
    retryLifeos(null, vi.fn());
    expect(lifeos.refresh).not.toHaveBeenCalled();
  });
});
