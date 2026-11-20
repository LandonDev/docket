import { describe, expect, it, vi } from "vitest";

/** The Work add menu's Retry: it asks the host's LifeOS status afresh, where a second watch would start nothing. */

const lifeos = vi.hoisted(() => ({ refresh: vi.fn(async (_env: string) => undefined), watch: vi.fn() }));
vi.mock("./lifeos", async (original) => ({ ...(await original<object>()), refreshLifeos: lifeos.refresh, watchLifeos: lifeos.watch }));

const { retryLifeos } = await import("./WorkRailHost");

describe("the add menu's Retry", () => {
  it("asks the host's status now, never only a watch the rail already has", async () => {
    const fail = vi.fn();
    retryLifeos("env_box", fail);
    await Promise.resolve();
    expect(lifeos.refresh).toHaveBeenCalledWith("env_box");
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

  it("asks nothing with no home host", () => {
    lifeos.refresh.mockClear();
    retryLifeos(null, vi.fn());
    expect(lifeos.refresh).not.toHaveBeenCalled();
  });
});
