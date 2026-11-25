// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FormatRowBone, SheetSkeleton } from "./SheetBody";

afterEach(cleanup);

describe("the sheet's bones while its book comes", () => {
  it("a book of more than one piece shows how much has come in the formula bar's place, with its value", () => {
    render(<SheetSkeleton loading={{ at: 4 * 1024 * 1024, size: 10 * 1024 * 1024 }} name="Budget.xlsx" />);
    const bar = screen.getByRole("progressbar", { name: "Getting Budget.xlsx" });
    expect(bar.getAttribute("aria-valuenow")).toBe(String(4 * 1024 * 1024));
    expect(bar.getAttribute("aria-valuemax")).toBe(String(10 * 1024 * 1024));
    expect(screen.getByText("4.0 of 10.0 MB")).toBeTruthy();
    expect(screen.getByLabelText("Loading").getAttribute("aria-busy")).toBe("true");
  });

  it("a book of one piece shows the bones alone", () => {
    render(<SheetSkeleton />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("holds the format row's 36px above the formula bar where the sheet will have a row, so the grid does not drop when it lands", () => {
    const { container, rerender } = render(<SheetSkeleton row />);
    const frame = screen.getByLabelText("Loading");
    // First the row, at work-kit's FormatRow height (h-9, its hairline inside), then the formula bar's 32px.
    const [row, formula] = [...frame.children] as HTMLElement[];
    expect(row!.hasAttribute("data-format-row-bone")).toBe(true);
    expect(row!.className).toContain("h-9");
    expect(row!.className).toContain("border-b");
    expect(formula!.className).toContain("h-8");
    // The loaded body draws the same bone until the grid hands its handle (SheetBody), the same 36px.
    const loaded = render(<FormatRowBone />).container.firstElementChild!;
    expect(loaded.className).toBe(row!.className);
    // A sheet with no row (read only, or a store that keeps no formatting) has none.
    rerender(<SheetSkeleton />);
    expect(container.querySelector("[data-format-row-bone]")).toBeNull();
  });
});
