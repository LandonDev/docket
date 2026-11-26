// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateField, dayOf, valueOf } from "./date-field";

afterEach(cleanup);

async function open(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  return screen.getByRole("dialog", { name: "Pick a day" });
}

describe("DateField", () => {
  it("reads and writes a date input's own value, in his zone", () => {
    expect(valueOf(dayOf("2026-11-26")!)).toBe("2026-11-26");
    expect(dayOf("2026-11-26")!.getDate()).toBe(26);
    expect(dayOf("")).toBeUndefined();
    expect(dayOf("2026-02-31")).toBeUndefined();
    expect(valueOf(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("is the select's box showing the day in words, and a muted line when it has none", () => {
    const { rerender } = render(<DateField aria-label="Due" value="2026-11-26" onChange={() => {}} />);
    const field = screen.getByRole("button", { name: "Due" });
    expect(field.textContent).toMatch(/Nov 26, 2026/);
    expect(field.classList).toContain("focus-field");
    expect(field.classList).toContain("data-[size=default]:h-8");
    expect(field.hasAttribute("data-placeholder")).toBe(false);
    rerender(<DateField aria-label="Due" value="" onChange={() => {}} />);
    expect(field.textContent).toBe("No date");
    expect(field.hasAttribute("data-placeholder")).toBe(true);
  });

  it("opens the calendar on the chosen day's month; a pick answers that day and closes", async () => {
    const onChange = vi.fn();
    render(<DateField aria-label="Due" value="2026-11-26" onChange={onChange} />);
    const popup = await open("Due");
    expect(popup.querySelector("[data-slot=calendar]")).not.toBeNull();
    expect(popup.textContent).toContain("November 2026");
    const chosen = popup.querySelector<HTMLElement>('[data-selected-single="true"], [aria-selected="true"]')!;
    expect(chosen.textContent).toContain("26");
    const twelfth = [...popup.querySelectorAll<HTMLButtonElement>("button[data-day]")].find((button) => button.dataset.day?.endsWith("-12") || button.dataset.day?.includes("11/12"))!;
    await act(async () => {
      fireEvent.click(twelfth);
    });
    expect(onChange).toHaveBeenCalledWith("2026-11-12");
    expect(screen.queryByRole("dialog", { name: "Pick a day" })).toBeNull();
  });

  it("Clear empties it, and a required field offers none", async () => {
    const onChange = vi.fn();
    const { unmount } = render(<DateField aria-label="Due" value="2026-11-26" onChange={onChange} />);
    const popup = await open("Due");
    await act(async () => {
      fireEvent.click(within(popup).getByRole("button", { name: "Clear" }));
    });
    expect(onChange).toHaveBeenCalledWith("");
    unmount();
    render(<DateField aria-label="Day" value="2026-11-26" required onChange={onChange} />);
    expect(within(await open("Day")).queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("holds the days before min and after max", async () => {
    render(<DateField aria-label="Due" value="2026-11-26" min="2026-11-20" max="2026-11-28" onChange={() => {}} />);
    const popup = await open("Due");
    const dayButton = (n: string) => [...popup.querySelectorAll<HTMLButtonElement>("button[data-day]")].find((button) => button.dataset.day?.endsWith(`-${n}`) || button.dataset.day?.includes(`11/${n}/`))!;
    expect(dayButton("12").disabled).toBe(true);
    expect(dayButton("22").disabled).toBe(false);
    expect(dayButton("29").disabled).toBe(true);
  });
});
