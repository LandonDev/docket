// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wait, waited } from "work-kit/ui/wait";
import { BONES } from "../lib/ease";
import { KitWaits } from "./kitWaits";

/*
 * work-kit's waits under Docket's host (docs/agents/loading-bones.md "work-kit's screens"): each is a
 * Region, its bones drawn from the kit's sample, and one region from the bones to the content.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.advanceTimersByTime(100_000 * ++run);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
let run = 0;

/** A kit screen whose wait is an early return, as Projects' are. */
function Screen({ rows }: { rows: string[] | undefined }) {
  if (!rows) return <Wait loading bones={<b>bars</b>} sample={<p>Sample row</p>} label="Loading rows" />;
  return waited(
    <ul>
      {rows.map((row) => (
        <li key={row}>{row}</li>
      ))}
    </ul>,
  );
}

describe("KitWaits", () => {
  it("draws a kit wait as a region of bones from its sample", () => {
    const { container } = render(
      <KitWaits>
        <Screen rows={undefined} />
      </KitWaits>,
    );
    const region = container.querySelector<HTMLElement>("[data-region]")!;
    act(() => void vi.advanceTimersByTime(BONES.holdMs));
    expect(region.dataset.bones).toBe("shown");
    // The bones are measured from the sample's words, never the kit's bars.
    expect(container.querySelector("[skullet-loading]")?.textContent).toContain("Sample row");
    expect(container.textContent).not.toContain("bars");
  });

  it("keeps one region from the bones to the content, so the content comes in over them", async () => {
    const { container, rerender } = render(
      <KitWaits>
        <Screen rows={undefined} />
      </KitWaits>,
    );
    act(() => void vi.advanceTimersByTime(BONES.holdMs));
    const region = container.querySelector("[data-region]");
    rerender(
      <KitWaits>
        <Screen rows={["Real row"]} />
      </KitWaits>,
    );
    expect(container.querySelector("[data-region]")).toBe(region);
    expect(screen.getByRole("listitem").textContent).toBe("Real row");
    vi.useRealTimers();
    await waitFor(() => expect(container.querySelector("[skullet-loading]")).toBeNull());
  });

  it("leaves a kit screen outside it on the kit's own bars", () => {
    const { container } = render(<Screen rows={undefined} />);
    expect(container.innerHTML).toBe("<b>bars</b>");
  });
});
