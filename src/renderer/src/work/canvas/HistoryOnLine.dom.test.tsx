// @vitest-environment jsdom
/**
 * An item he can only read (docs/DESIGN.md "The canvas pane"): its quiet line may say History stands at its end
 * (`StatusLine.history`), and then the kind's bar offers no second History, so the item has one row above it, not a
 * bar holding History alone over the line. Where the line is said elsewhere (a Files tab's save line) History stays
 * in the bar.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineChunk } from "../../lib/lazyChunk";
import { CanvasPane } from "./CanvasPane";
import { NO_FEEDS, type Feeds } from "./frame";
import type { CanvasKindModule, CanvasShell, StatusLine } from "./kind";
import { CANVAS } from "./registry";
import { canvasItem } from "./testkit";

afterEach(cleanup);

const module = { Body: () => <p>The grid</p>, Bar: () => null } as unknown as CanvasKindModule;
const chunk = defineChunk<CanvasKindModule>("test-history-on-line", async () => module);
const kinds = { ...CANVAS, sheet: { ...CANVAS.sheet, history: true, chunk } };

async function pane(status: StatusLine, saveLine = false) {
  const openHistory = vi.fn();
  const shell = new Proxy({ openHistory }, { get: (own, key) => (key in own ? own[key as keyof typeof own] : () => undefined) }) as unknown as CanvasShell;
  const feeds: Feeds = { ...NO_FEEDS, status };
  await act(async () => void render(<CanvasPane item={canvasItem("s1", { kind: "sheet" })} environmentId="local" feeds={feeds} shell={shell} onAsk={() => undefined} kinds={kinds} saveLine={saveLine} />));
  await act(async () => undefined);
  return openHistory;
}

const bar = () => document.querySelector<HTMLElement>("[data-canvas-bar]");
const line = () => document.querySelector<HTMLElement>("[data-canvas-state='quiet']");

describe("History on a read-only item's quiet line", () => {
  it("ends the line, and the bar holds no History of its own", async () => {
    const openHistory = await pane({ tone: "quiet", word: "Read only", detail: "Saved as .xlsb, which opens here only to read", history: true });
    expect(line()!.textContent).toContain("Read only");
    expect(bar()?.textContent ?? "").not.toContain("History");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(openHistory).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("button", { name: "History" })).toHaveLength(1);
  });

  it("stays in the bar for a line that does not ask for it", async () => {
    await pane({ tone: "quiet", word: "Read only" });
    expect(line()!.querySelector("button")).toBeNull();
    expect(bar()!.textContent).toContain("History");
  });

  it("stays in the bar where the line is said on the save line instead", async () => {
    await pane({ tone: "quiet", word: "The Excel file moved", saving: true, history: true }, true);
    expect(line()).toBeNull();
    expect(bar()!.textContent).toContain("History");
  });
});
