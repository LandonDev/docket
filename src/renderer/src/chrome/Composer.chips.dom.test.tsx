// @vitest-environment jsdom
/**
 * The composer's chip row (docs/DESIGN.md "The composer's chip row"): what
 * the message is about sits in the box over the field, a chip alone can be
 * sent, and the send carries each chip as a line of the message. A draft's
 * first chip is kept for its create.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ContextChip } from "@shared/work";

vi.mock("./CwdPicker", () => ({ CwdPicker: () => null }));
vi.mock("./DraftHostPicker", () => ({ DraftHostPicker: () => null }));
vi.mock("./BranchPicker", () => ({ BranchPicker: () => null }));
vi.mock("./ThreadTypeChip", () => ({ ThreadTypeChip: () => null }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

import { aboutFor, addContextChip, chipLine, contextChipsOf, resetContextChips } from "../work/canvas/chips";
import { Composer } from "./Composer";

const task: ContextChip = { kind: "task", label: "Book the ballroom for April 10", ref: { at: "lifeos", table: "tasks", id: "k1" } };
const selection: ContextChip = { kind: "selection", label: "“Pools run on 24 stations”, Run of show", ref: { at: "lifeos", table: "docs", id: "d1" }, quote: "Pools run on 24 stations" };

const noop = () => {};
function mount(over: Partial<ComponentProps<typeof Composer>> = {}) {
  return render(
    <Composer focused={false} harness="claude" model="claude-opus-5-5" runtimeMode="supervised" executionCwd="/work/alpha" cwd="/work/alpha" sessionId="draft-c" onFocus={noop} onCwdChange={noop} onModelChange={noop} onRuntimeModeChange={noop} onSubmit={noop} {...over} />,
  );
}
const row = (view: ReturnType<typeof render>) => view.container.querySelector<HTMLElement>("[data-composer-chips]");
const send = () => screen.getByRole("button", { name: /^Send/ });

beforeEach(resetContextChips);
afterEach(cleanup);

describe("the composer's chip row", () => {
  it("is absent, and Send idle, while the composer holds no chip", () => {
    const view = mount();
    expect(row(view)).toBeNull();
    expect(send().hasAttribute("disabled")).toBe(true);
  });

  it("draws each chip with its kind's glyph, its label and Remove", async () => {
    const view = mount();
    act(() => {
      addContextChip("draft-c", task);
      addContextChip("draft-c", selection);
    });
    await waitFor(() => expect(row(view)).not.toBeNull());
    const chips = [...row(view)!.querySelectorAll<HTMLElement>("[data-chip]")];
    expect(chips.map((chip) => chip.dataset.chip)).toEqual(["task", "selection"]);
    expect(chips.map((chip) => chip.textContent)).toEqual([task.label, selection.label]);
    for (const chip of chips) expect(chip.querySelector("svg")).not.toBeNull();
    fireEvent.click(within(chips[0]).getByRole("button", { name: "Remove the task" }));
    expect(contextChipsOf("draft-c")).toEqual([selection]);
    await waitFor(() => expect(row(view)!.querySelectorAll("[data-chip]")).toHaveLength(1));
  });

  it("sends a chip by itself: Send is live with nothing typed, and the message is the chip's line", async () => {
    const onSubmit = vi.fn();
    const view = mount({ onSubmit });
    act(() => addContextChip("draft-c", task));
    await waitFor(() => expect(row(view)).not.toBeNull());
    expect(send().hasAttribute("disabled")).toBe(false);
    fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0]).toBe(chipLine(task));
    // The chips went with the message, and the draft's create is told what it is about.
    expect(contextChipsOf("draft-c")).toEqual([]);
    expect(row(view)).toBeNull();
    expect(aboutFor("draft-c", () => false)).toEqual(task);
  });

  it("puts the chip's line above what was typed, and sends plain words as they are with no chip", async () => {
    const onSubmit = vi.fn();
    const view = mount({ onSubmit, initialDraft: "Tighten the morning" });
    fireEvent.click(send());
    expect(onSubmit.mock.calls[0][0]).toBe("Tighten the morning");
    cleanup();
    const again = mount({ onSubmit, initialDraft: "Tighten the morning" });
    act(() => addContextChip("draft-c", selection));
    await waitFor(() => expect(row(again)).not.toBeNull());
    fireEvent.click(send());
    expect(onSubmit.mock.calls[1][0]).toBe(`${chipLine(selection)}\n\nTighten the morning`);
    void view;
  });
});
