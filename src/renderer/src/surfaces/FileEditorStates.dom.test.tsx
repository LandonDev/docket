import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { EditorLoading, EditorOpenError } from "./FileEditor";

describe("the editor's waiting states", () => {
  afterEach(cleanup);

  it("loads as bones of eight lines of sample code in the editor's type, under the header's strip", () => {
    const { container } = render(<EditorLoading name="App.tsx" />);
    // The drawing is the bones' own, unseen by a screen reader: the status names the wait.
    const drawing = container.querySelector("[data-region][data-bones] [skullet-loading]")!;
    expect(drawing.getAttribute("aria-hidden")).toBe("true");
    const lines = drawing.querySelectorAll<HTMLElement>("[data-loading-line]");
    expect(lines).toHaveLength(8);
    for (const line of lines) expect(line.className).toContain("font-mono text-[13px] leading-[1.6]");
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    // The bare strip keeps its hairline: an empty box is a leaf Skullet would hide.
    expect(drawing.querySelector(".h-8")!.hasAttribute("skullet-own")).toBe(true);
    expect(container.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe("Opening App.tsx");
  });

  it("fails as one Empty: the name, why, and Retry", () => {
    const onRetry = vi.fn();
    const { container, getByRole } = render(
      <EditorOpenError name="App.tsx" line="No such file on box." onRetry={onRetry} />,
    );
    expect(container.querySelector('[data-slot="empty-title"]')!.textContent).toBe("Couldn't open App.tsx");
    expect(container.querySelector('[data-slot="empty-description"]')!.textContent).toBe("No such file on box.");
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
