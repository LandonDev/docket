// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChoiceCombobox } from "./choice-combobox";
import { resetSelects } from "./lazy-select";

/** A select chunk this file holds back: cold until a test lets it land. */
const chunk = vi.hoisted(() => ({ module: null as object | null, release: null as null | (() => void) }));
vi.mock("../surfaces/chunks", () => {
  const load = () =>
    new Promise<object>((resolve) => {
      chunk.release = async () => {
        chunk.module = await import("./select-body");
        resolve(chunk.module);
      };
    });
  return { selectChunk: { load, preload: () => void load(), loaded: () => chunk.module, intent: {} } };
});

const OPTIONS = [
  { value: "opus", label: "Opus 5.5", group: "Claude" },
  { value: "sol", label: "GPT-6.2 Sol", group: "Codex" },
];

beforeEach(() => {
  chunk.module = null;
  chunk.release = null;
  resetSelects();
});
afterEach(cleanup);

describe("ChoiceCombobox before the select chunk lands", () => {
  it("is its own still trigger at the caller's size and width, showing the chosen label", () => {
    render(<ChoiceCombobox label="Reviewer" value="sol" options={OPTIONS} onChange={() => {}} size="sm" className="w-44" />);
    const trigger = screen.getByRole("combobox", { name: "Reviewer" });
    expect(trigger.dataset.slot).toBe("select-trigger");
    expect(trigger.dataset.size).toBe("sm");
    expect(trigger.className).toContain("w-44");
    expect(trigger.textContent).toBe("GPT-6.2 Sol");
  });

  it("swaps to the real field in the same box, and a click on the cold one opens the list once it lands", async () => {
    render(<ChoiceCombobox label="Reviewer" value="opus" options={OPTIONS} onChange={() => {}} size="sm" className="w-44" />);
    const cold = screen.getByRole("combobox", { name: "Reviewer" });
    const coldClasses = cold.className;
    fireEvent.click(cold);
    await act(async () => chunk.release?.());
    const warm = document.querySelector<HTMLElement>("[data-slot=combobox-trigger]")!;
    expect(warm.className).toBe(coldClasses);
    expect(warm.dataset.size).toBe("sm");
    expect(warm.textContent).toContain("Opus 5.5");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Opus 5.5", "GPT-6.2 Sol"]);
  });
});
