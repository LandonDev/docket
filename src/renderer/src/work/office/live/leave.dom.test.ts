// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const confirmAction = vi.fn(async (_request: unknown) => true);
vi.mock("../../../chrome/ConfirmDialog", () => ({ confirmAction: (request: unknown) => confirmAction(request) }));

const { leaveForSwitch, leaveLive } = await import("./leave");

/** A layer whose guest Word holds while saving (`holding`): `leave` asks, as the real one does past its wait. */
const holding = (stays = true) => ({ leave: vi.fn(async (_key: string, ask: () => Promise<boolean>) => (stays ? ask() : true)) });

describe("leaving a live file", () => {
  afterEach(() => confirmAction.mockReset().mockResolvedValue(true));

  it("asks Switch Anyway on a switch, names the mode, and answers forced when he lets Word go", async () => {
    const layer = holding();
    expect(await leaveForSwitch("a", "Plan.docx", "word", layer as never)).toBe("forced");
    expect(confirmAction).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Plan.docx is still saving", action: "Switch Anyway", body: expect.stringContaining("it stays in Word for the web") }),
    );
  });

  it("stays when he keeps Word open, and answers plainly gone when Word let go on its own", async () => {
    confirmAction.mockResolvedValueOnce(false);
    expect(await leaveForSwitch("a", "Plan.docx", "word", holding() as never)).toBe(false);
    expect(await leaveForSwitch("a", "Plan.docx", "word", holding(false) as never)).toBe(true);
  });

  it("asks Close Anyway on a close", async () => {
    expect(await leaveLive("a", "Plan.docx", holding() as never)).toBe(true);
    expect(confirmAction).toHaveBeenCalledWith(expect.objectContaining({ action: "Close Anyway" }));
  });
});
