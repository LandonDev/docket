// @vitest-environment jsdom
/**
 * A file's header under 480px (docs/DESIGN.md "The Files place"): the save line's first press stays, its second is
 * the first row of ⋯ and runs from there, and a cut line has its whole words in a tooltip. Wider, both presses are
 * drawn and ⋯ holds only the file's own rows. The line's words and the order of its presses do not change.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavedAction } from "../canvas/kind";

const { FileHeader } = await import("./FileTabView");
const { tuckedRows, TUCKED } = await import("./SaveLine");

let width = 400;
class Measured {
  constructor(private readonly heard: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.heard([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ran: string[] = [];
const actions: SavedAction[] = [
  { id: "reload", label: "Reload", run: async () => void ran.push("reload") },
  { id: "keep", label: "Keep Both", run: async () => void ran.push("keep") },
];
const draw = (onRun: (action: SavedAction) => void) =>
  render(
    <FileHeader
      name="Spring LAN 2027 run of show.docx"
      line={{ state: "changed", actions }}
      where="Events"
      running={null}
      onRun={onRun}
      rows={[{ kind: "item", id: "rename", label: "Rename" }]}
      onPick={() => undefined}
      ask={{ disabled: false, pressed: false, run: () => undefined }}
    />,
  );

describe("a narrow file header", () => {
  it("draws the second press in ⋯ and runs it from there", async () => {
    width = 400;
    vi.stubGlobal("ResizeObserver", Measured);
    const run = vi.fn();
    draw(run);
    const header = document.querySelector<HTMLElement>("[data-files-header]")!;
    // The second press is hidden under 480px of header by its container query, the first is not.
    expect(within(header).getByRole("button", { name: "Reload" }).className.split(" ")).not.toContain("hidden");
    const second = within(header).getByRole("button", { name: "Keep Both" }).className.split(" ");
    expect(second).toContain("hidden");
    expect(second).toContain("@[480px]/file-head:inline-flex");
    fireEvent.click(within(header).getByRole("button", { name: /^More for/ }));
    const menu = await screen.findByRole("menu");
    const rows = within(menu).getAllByRole("menuitem").map((row) => row.textContent);
    expect(rows).toEqual(["Keep Both", "Rename"]);
    await act(async () => void fireEvent.click(within(menu).getByRole("menuitem", { name: "Keep Both" })));
    expect(run).toHaveBeenCalledWith(actions[1]);
  });

  it("keeps ⋯ to the file's own rows where the header is wide", async () => {
    width = 640;
    vi.stubGlobal("ResizeObserver", Measured);
    draw(() => undefined);
    fireEvent.click(within(document.querySelector<HTMLElement>("[data-files-header]")!).getByRole("button", { name: /^More for/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((row) => row.textContent)).toEqual(["Rename"]);
  });

  it("puts no row first while a press is under way, and none with one press alone", () => {
    expect(tuckedRows([], actions, true, null)[0]).toMatchObject({ id: TUCKED, label: "Keep Both", disabled: false });
    expect(tuckedRows([], actions, true, "reload")[0]).toMatchObject({ id: TUCKED, disabled: true });
    expect(tuckedRows([], actions.slice(0, 1), true, null)).toEqual([]);
    expect(tuckedRows([], actions, false, null)).toEqual([]);
  });
});
