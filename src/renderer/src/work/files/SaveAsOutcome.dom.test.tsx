// @vitest-environment jsdom
/** Save As's outcome is two lines at most; where a narrow sheet still cuts it, it is whole on hover and focus (council R2-C6). */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";

const { Outcome } = await import("./SaveAs");

beforeAll(async () => {
  await act(async () => {
    await tooltipChunk.load();
    warmTooltips();
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WORDS = "Saves a copy of this document in Practice schedules, the job's folder on the box";

describe("Save As's outcome", () => {
  it("is a plain line, out of the Tab order, while it fits", () => {
    const { container } = render(<Outcome words={WORDS} />);
    const line = container.querySelector<HTMLElement>("[data-save-as-outcome]")!;
    expect(line.textContent).toBe(WORDS);
    expect(line.getAttribute("tabindex")).toBeNull();
  });

  it("takes the focus and a tip with its whole words when its two lines cut it", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(48);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(32);
    const { container } = render(<Outcome words={WORDS} />);
    const line = container.querySelector<HTMLElement>("[data-save-as-outcome]")!;
    expect(line.getAttribute("tabindex")).toBe("0");
    // A Tab stop draws its ring (council R3-C1).
    expect(line.className.split(" ")).toEqual(expect.arrayContaining(["line-clamp-2", "focus-ring"]));
  });
});
