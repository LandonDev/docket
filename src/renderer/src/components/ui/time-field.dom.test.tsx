// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTime, QUARTERS, TimeField, timesFor, timeWords } from "./time-field";

afterEach(cleanup);

describe("the time's words and what he types", () => {
  it("says a value in his clock's one form: no padded hour", () => {
    expect(timeWords("18:00")).toBe("6:00 PM");
    expect(timeWords("06:30")).toBe("6:30 AM");
    expect(timeWords("00:15")).toBe("12:15 AM");
    expect(timeWords("")).toBe("");
    expect(timeWords("25:00")).toBe("");
  });

  it.each([
    ["6", "06:00"],
    ["6p", "18:00"],
    ["6 pm", "18:00"],
    ["6:30 pm", "18:30"],
    ["6:30 P.M.", "18:30"],
    ["630", "06:30"],
    ["1830", "18:30"],
    ["18:00", "18:00"],
    ["12a", "00:00"],
    ["12p", "12:00"],
    ["6:00 PM", "18:00"],
    ["", ""],
  ])("reads %j as %j", (typed, value) => {
    expect(parseTime(typed)).toBe(value);
  });

  it.each(["soon", "24:00", "6:60", "13pm", "0am", "6:5"])("refuses %j", (typed) => {
    expect(parseTime(typed)).toBeNull();
  });

  it("lists every quarter hour, and while typing those whose words begin with it", () => {
    expect(QUARTERS).toHaveLength(96);
    expect(QUARTERS[0]).toBe("00:00");
    expect(QUARTERS.at(-1)).toBe("23:45");
    expect(timesFor("")).toHaveLength(96);
    expect(timesFor("6").map(timeWords)).toEqual(["6:00 AM", "6:15 AM", "6:30 AM", "6:45 AM", "6:00 PM", "6:15 PM", "6:30 PM", "6:45 PM"]);
    expect(timesFor("6p").map(timeWords)).toEqual(["6:00 PM", "6:15 PM", "6:30 PM", "6:45 PM"]);
    expect(timesFor("6:3").map(timeWords)).toEqual(["6:30 AM", "6:30 PM"]);
    expect(timesFor("soon")).toEqual([]);
  });

  // Council 5 S F11.1: on a 24-hour clock "6p" offered nothing, though Enter took it: the match read the words "18:00".
  it("matches the value, not his clock's words, so a 24-hour clock offers 6p's quarters and its own hours", () => {
    expect(timesFor("6p", true)).toEqual(["18:00", "18:15", "18:30", "18:45"]);
    expect(timesFor("6:3 pm", true)).toEqual(["18:30"]);
    expect(timesFor("12a", true)).toEqual(["00:00", "00:15", "00:30", "00:45"]);
    expect(timesFor("6", true)).toEqual(["06:00", "06:15", "06:30", "06:45"]);
    expect(timesFor("06", true)).toEqual(["06:00", "06:15", "06:30", "06:45"]);
    expect(timesFor("18", true)).toEqual(["18:00", "18:15", "18:30", "18:45"]);
    expect(timesFor("183", true)).toEqual(["18:30"]);
    // Each offer is a value Enter would set the same: what is offered for "6p" is what parseTime reads.
    expect(timesFor("6p", true)[0]).toBe(parseTime("6p"));
    expect(timesFor("6p", false)).toEqual(["18:00", "18:15", "18:30", "18:45"]);
  });
});

function Held({ initial = "18:00", onChange, required }: { initial?: string; onChange?: (value: string) => void; required?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <TimeField
      aria-label="From"
      value={value}
      required={required}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const field = () => screen.getByRole("combobox", { name: "From" }) as HTMLInputElement;

describe("TimeField", () => {
  it("is a text field showing the time in words, with no clock glyph, and a muted placeholder with none", () => {
    const { rerender } = render(<TimeField aria-label="From" value="18:00" onChange={() => {}} />);
    expect(field().type).toBe("text");
    expect(field().value).toBe("6:00 PM");
    expect(field().className).toContain("tabular-nums");
    rerender(<TimeField aria-label="From" value="" onChange={() => {}} />);
    expect(field().value).toBe("");
    expect(field().placeholder).toBe("No time");
  });

  it("reads what he typed when he leaves the field and answers a time input's value", () => {
    const onChange = vi.fn();
    render(<Held onChange={onChange} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "6:30p" } });
    fireEvent.blur(field());
    expect(onChange).toHaveBeenCalledWith("18:30");
    expect(field().value).toBe("6:30 PM");
  });

  it("reads it on Enter too", () => {
    const onChange = vi.fn();
    render(<Held onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "9" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("09:00");
    expect(field().value).toBe("9:00 AM");
  });

  it("gives words that are no time the last time back, and asks nothing", () => {
    const onChange = vi.fn();
    render(<Held onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "soon" } });
    fireEvent.blur(field());
    expect(onChange).not.toHaveBeenCalled();
    expect(field().value).toBe("6:00 PM");
  });

  it("clears on an emptied field, unless a time is required", () => {
    const onChange = vi.fn();
    const { unmount } = render(<Held onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.blur(field());
    expect(onChange).toHaveBeenCalledWith("");
    unmount();
    const held = vi.fn();
    render(<Held onChange={held} required />);
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.blur(field());
    expect(held).not.toHaveBeenCalled();
    expect(field().value).toBe("6:00 PM");
  });

  it("drops the quarter hours from ↓, the set one ticked; a pick sets it", async () => {
    const onChange = vi.fn();
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    render(<Held onChange={onChange} />);
    await act(async () => {
      field().focus();
      fireEvent.keyDown(field(), { key: "ArrowDown" });
    });
    // Opened on the set time: its row is brought into view.
    await act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
    expect(scrolled.map((row) => row.getAttribute("data-time"))).toContain("18:00");
    const list = await screen.findByRole("listbox");
    const rows = [...list.querySelectorAll("[data-time]")];
    expect(rows).toHaveLength(96);
    const set = list.querySelector('[data-time="18:00"]')!;
    expect(set.textContent).toBe("6:00 PM");
    expect(set.querySelector("svg")).not.toBeNull();
    expect(list.querySelector('[data-time="18:15"] svg')).toBeNull();
    await act(async () => {
      fireEvent.click(list.querySelector('[data-time="07:45"]')!);
    });
    expect(onChange).toHaveBeenCalledWith("07:45");
    expect(field().value).toBe("7:45 AM");
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("narrows the list to what he typed", async () => {
    render(<Held />);
    await act(async () => {
      field().focus();
      fireEvent.input(field(), { target: { value: "6p" }, inputType: "insertText" });
    });
    const list = await screen.findByRole("listbox");
    expect([...list.querySelectorAll("[data-time]")].map((row) => row.getAttribute("data-time"))).toEqual(["18:00", "18:15", "18:30", "18:45"]);
  });
});
