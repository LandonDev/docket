// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChoiceCombobox } from "./choice-combobox-body";

const OPTIONS = [
  { value: "", label: "Auto" },
  { value: "opus", label: "Opus 5.5", group: "Claude" },
  { value: "sonnet", label: "Sonnet 5.5", group: "Claude" },
  { value: "sol", label: "GPT-6.2 Sol", group: "Codex" },
];

afterEach(cleanup);

async function open(trigger: HTMLElement) {
  await act(async () => {
    fireEvent.click(trigger);
  });
}

async function type(field: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(field, { target: { value } });
  });
}

async function key(field: HTMLElement, name: string) {
  await act(async () => {
    fireEvent.keyDown(field, { key: name });
  });
}

const trigger = (name: string) => document.querySelector<HTMLElement>(`[data-slot=combobox-trigger][aria-label="${name}"]`)!;

describe("ChoiceCombobox", () => {
  it("shows the chosen option's label on a trigger in the select's box", () => {
    render(<ChoiceCombobox label="Build model" value="sol" options={OPTIONS} onChange={() => {}} size="sm" className="w-44" />);
    const field = trigger("Build model");
    expect(field.textContent).toContain("GPT-6.2 Sol");
    expect(field.dataset.size).toBe("sm");
    expect(field.className).toContain("w-44");
    expect(field.className).toContain("focus-field");
  });

  it("lists grouped options under their group, ungrouped ones first", async () => {
    render(<ChoiceCombobox label="Build model" value="" options={OPTIONS} onChange={() => {}} />);
    await open(trigger("Build model"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Auto", "Opus 5.5", "Sonnet 5.5", "GPT-6.2 Sol"]);
    expect([...document.querySelectorAll("[data-slot=combobox-label]")].map((label) => label.textContent)).toEqual(["Claude", "Codex"]);
  });

  it("filters as he types, and says so when nothing matches", async () => {
    render(<ChoiceCombobox label="Build model" value="" options={OPTIONS} onChange={() => {}} />);
    await open(trigger("Build model"));
    const field = screen.getByRole("combobox", { name: "Search Build model" });
    await type(field, "son");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Sonnet 5.5"]);
    expect([...document.querySelectorAll("[data-slot=combobox-label]")].map((label) => label.textContent)).toEqual(["Claude"]);
    await type(field, "zzz");
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(document.querySelector("[data-slot=combobox-empty]")?.textContent).toBe("No matches");
  });

  it("the arrows move the row the field names, and Enter picks it", async () => {
    const onChange = vi.fn();
    render(<ChoiceCombobox label="Build model" value="" options={OPTIONS} onChange={onChange} />);
    await open(trigger("Build model"));
    const field = screen.getByRole("combobox", { name: "Search Build model" });
    await key(field, "ArrowDown");
    const first = field.getAttribute("aria-activedescendant");
    expect(first).toBeTruthy();
    await key(field, "ArrowDown");
    const second = field.getAttribute("aria-activedescendant");
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(document.getElementById(second!)?.hasAttribute("data-highlighted")).toBe(true);
    await key(field, "Enter");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(OPTIONS.map((option) => option.value)).toContain(onChange.mock.calls[0][0]);
  });

  it("calls onChange with the option pressed, an empty value included, and never for the one already chosen", async () => {
    const onChange = vi.fn();
    render(<ChoiceCombobox label="Build model" value="opus" options={OPTIONS} onChange={onChange} />);
    await open(trigger("Build model"));
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Opus 5.5" }));
    });
    expect(onChange).not.toHaveBeenCalled();
    await open(trigger("Build model"));
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Auto" }));
    });
    expect(onChange).toHaveBeenCalledWith("");
  });
});
