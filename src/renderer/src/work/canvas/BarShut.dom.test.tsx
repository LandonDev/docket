// @vitest-environment jsdom
/**
 * The kind's bar over an item that cannot open (docs/DESIGN.md "The canvas pane": a kind with nothing to put there
 * draws no bar). A kind draws its bone in the bar first, which holds the bar's 32px (KindBar.tsx `useHeld`); once the
 * body is the centred failure, or a PDF's password ask, the hold lets go and no empty band stands over it. A read-only
 * item whose quiet line ends with History lets it go too. Retry brings the bone, and the bar, back.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Skeleton } from "../../components/ui/skeleton";
import { defineChunk } from "../../lib/lazyChunk";
import { CanvasPane } from "./CanvasPane";
import { OpenFailed } from "./FetchState";
import { NO_FEEDS, type Feeds } from "./frame";
import type { CanvasKindModule, CanvasShell } from "./kind";
import { BAR_TOOLS_ONLY } from "./KindBar";
import { CANVAS } from "./registry";
import { canvasItem } from "./testkit";

afterEach(cleanup);

/** Where the test's kind stands: opening (a bone in the bar), failed (the centred failure), open with nothing for the bar. */
let phase: "opening" | "failed" | "open" = "opening";
const module = {
  Body: () => (phase === "failed" ? <OpenFailed kind="document" why="The file is not where it was." onRetry={() => undefined} /> : <p>The page</p>),
  Bar: () => (phase === "opening" ? <Skeleton className="h-3 w-30" /> : null),
} as unknown as CanvasKindModule;
const chunk = defineChunk<CanvasKindModule>("test-bar-shut", async () => module);
const kinds = { ...CANVAS, document: { ...CANVAS.document, chunk } };
const shell = new Proxy({}, { get: () => () => undefined }) as unknown as CanvasShell;

async function pane(feeds: Feeds = NO_FEEDS) {
  const view = render(<CanvasPane item={canvasItem("d1", { kind: "document" })} environmentId="local" feeds={feeds} shell={shell} onAsk={() => undefined} kinds={kinds} />);
  await act(async () => undefined);
  return { again: (next: Feeds = feeds) => act(async () => void view.rerender(<CanvasPane item={canvasItem("d1", { kind: "document" })} environmentId="local" feeds={next} shell={shell} onAsk={() => undefined} kinds={kinds} />)) };
}

const bar = () => document.querySelector<HTMLElement>("[data-canvas-bar]")!;
/** Drawn: not hidden by the tools-only rule, which hides the bar while its tools slot is empty. */
const drawn = (): boolean => !(bar().className.includes(BAR_TOOLS_ONLY) && bar().matches(":has([data-canvas-tools]:empty)"));

describe("the bar over an item that cannot open", () => {
  it("goes once the body is the centred failure, and comes back with the bone on Retry", async () => {
    phase = "opening";
    const { again } = await pane();
    expect(drawn()).toBe(true);
    phase = "failed";
    await again();
    expect(document.querySelector("[data-canvas-failed]")).not.toBeNull();
    expect(drawn()).toBe(false);
    phase = "opening";
    await again();
    expect(drawn()).toBe(true);
  });

  it("stays, held, for a kind that opened and draws nothing for a moment", async () => {
    phase = "opening";
    const { again } = await pane();
    phase = "open";
    await again();
    expect(drawn()).toBe(true);
  });

  it("goes over a read-only item whose quiet line ends with History", async () => {
    phase = "opening";
    const { again } = await pane();
    phase = "open";
    await again({ ...NO_FEEDS, status: { tone: "quiet", word: "Read only", history: true } });
    expect(drawn()).toBe(false);
  });
});
