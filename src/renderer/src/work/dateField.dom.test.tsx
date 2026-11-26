// @vitest-environment jsdom
/**
 * Work's date fields are the shared DateField (components/ui/date-field.tsx), never Chromium's `type="date"`:
 * Send later's picker (outbox/HeldDetail.tsx `PickTime`) draws it under its label, in the Tab order before Time; a
 * pick sets the day the line under it reads; Escape shuts the calendar alone, the dialog stays and the caret is back
 * on the field. No Work dialog draws a native date input.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { PickTime } = await import("./outbox/HeldDetail");

afterEach(cleanup);

const calendar = () => screen.queryByRole("dialog", { name: "Pick a day" });

describe("a date in a Work dialog", () => {
  it("is the shared field: labelled, before Time in the Tab order, a pick sets the day, Escape shuts the calendar alone", async () => {
    const onPick = vi.fn();
    render(<PickTime onPick={onPick} onClose={() => {}} />);
    const day = screen.getByLabelText("Day");
    expect(day.tagName).toBe("BUTTON");
    expect(day.getAttribute("data-slot")).toBe("date-field");
    expect(document.querySelector('input[type="date"]')).toBeNull();
    // The field comes before Time, as the native one did.
    const time = screen.getByLabelText("Time");
    expect(day.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => {
      fireEvent.click(day);
    });
    const popup = calendar()!;
    // A day must stay chosen: no Clear.
    expect(popup.textContent).not.toContain("Clear");
    const days = [...popup.querySelectorAll<HTMLButtonElement>("button[data-day]:not(:disabled)")];
    const last = days[days.length - 1]!;
    await act(async () => {
      fireEvent.click(last);
    });
    expect(calendar()).toBeNull();
    const picked = new Date(last.dataset.day!);
    expect(day.textContent).toContain(String(picked.getDate()));
    // Escape: the calendar goes, Send later's dialog stays, the caret is back on the field.
    await act(async () => {
      fireEvent.click(day);
    });
    expect(calendar()).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    expect(calendar()).toBeNull();
    expect(screen.getByRole("dialog", { name: "Send later" })).toBeTruthy();
    expect(document.activeElement).toBe(day);
  });

  it("is the only date field Work draws: no dialog keeps a native date input", () => {
    const root = resolve(__dirname);
    const native: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx$/.test(name) && !/\.(test|preview|fixtures)\.tsx$/.test(name) && name !== "testDateField.tsx" && /type="date"/.test(readFileSync(path, "utf8"))) native.push(path.slice(root.length + 1));
      }
    };
    walk(root);
    walk(resolve(__dirname, "../../../hosted"));
    expect(native).toEqual([]);
  });
});
