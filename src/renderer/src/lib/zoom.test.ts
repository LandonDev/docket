import { describe, expect, it, vi } from "vitest";
import { applyZoom, clampZoom, stepZoom, subscribeZoom } from "./zoom";

const sent = vi.hoisted(() => [] as unknown[]);
vi.mock("./native", () => ({ invoke: async (_: string, args: unknown) => void sent.push(args) }));

describe("zoom", () => {
  it("steps by a tenth and clamps to the range", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.2);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(2, 1)).toBe(2);
  });

  it("rounds away float drift", () => {
    expect(clampZoom(0.7 + 0.2)).toBe(0.9);
    expect(clampZoom(1.0000001)).toBe(1);
  });

  it("tells a second control when the level changes, until it stops listening", async () => {
    const heard = vi.fn();
    const off = subscribeZoom(heard);
    expect(await applyZoom(1.34)).toBe(1.3);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)).toEqual({ level: 1.3 });
    off();
    await applyZoom(1);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
