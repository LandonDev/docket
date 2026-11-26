// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColorPicker } from "./ColorPicker";

afterEach(cleanup);

describe("ColorPicker", () => {
  it("the hex field takes typing key by key and changes the colour once the code is whole", () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#ff0000" onChange={onChange} />);
    const field = screen.getByRole("textbox", { name: "Hex colour" }) as HTMLInputElement;
    expect(field.value).toBe("#ff0000");
    const code = "#1a2b3c";
    for (let end = 1; end < code.length; end++) {
      fireEvent.change(field, { target: { value: code.slice(0, end) } });
      // The first keys of a new code stay in the field, unfinished.
      expect(field.value).toBe(code.slice(0, end));
      expect(onChange).not.toHaveBeenCalled();
    }
    fireEvent.change(field, { target: { value: code } });
    expect(onChange).toHaveBeenLastCalledWith("#1a2b3c");
    // Left unfinished, the field goes back to the colour it shows.
    fireEvent.change(field, { target: { value: "#1a2" } });
    fireEvent.blur(field);
    expect(field.value).toBe("#1a2b3c");
  });

  it("Tab reaches the hue strip, a slider the arrows move", async () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#ff0000" onChange={onChange} />);
    const hue = screen.getByRole("slider", { name: "Hue" }) as HTMLInputElement;
    expect(hue.tagName).toBe("INPUT");
    expect(hue.tabIndex).toBe(0);
    expect(hue.getAttribute("aria-valuetext")).toBe("0°");
    await act(async () => {
      hue.focus();
      fireEvent.keyDown(hue, { key: "ArrowRight" });
    });
    expect(onChange).toHaveBeenCalled();
    expect(screen.getByRole("slider", { name: "Hue" }).getAttribute("aria-valuetext")).toBe("1°");
    // The thumb is the one focus ring's (index.css names the slot).
    expect(hue.closest("[data-slot=slider-thumb]")).not.toBeNull();
  });

  it("the colour field takes the keyboard: arrows move saturation and brightness, Shift by ten", () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#804040" onChange={onChange} />);
    const field = screen.getByRole("slider", { name: "Saturation and brightness" });
    expect(field.tabIndex).toBe(0);
    expect(field.classList).toContain("focus-ring");
    const before = field.getAttribute("aria-valuetext")!;
    const numbers = (text: string) => text.match(/\d+/g)!.map(Number);
    const [s0, v0] = numbers(before);
    fireEvent.keyDown(field, { key: "ArrowRight" });
    expect(numbers(field.getAttribute("aria-valuetext")!)).toEqual([s0 + 1, v0]);
    fireEvent.keyDown(field, { key: "ArrowUp", shiftKey: true });
    expect(numbers(field.getAttribute("aria-valuetext")!)).toEqual([s0 + 1, v0 + 10]);
    expect(onChange).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(field, { key: "a" });
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
