// @vitest-environment jsdom
/**
 * A kind whose code did not load the first time (docs/DESIGN.md "The canvas pane", "Loading and empty states"): the
 * body says so with Retry and the bar holds no loading bone, since nothing is loading; Retry loads the code again,
 * and once it lands the kind's tools are in the bar.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineChunk } from "../../lib/lazyChunk";
import { CanvasPane } from "./CanvasPane";
import { NO_FEEDS } from "./frame";
import type { CanvasKindModule, CanvasShell } from "./kind";
import { CANVAS } from "./registry";
import { canvasItem } from "./testkit";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const shell = new Proxy({}, { get: () => () => undefined }) as unknown as CanvasShell;
const module = { Body: () => <p data-testid="body">The body</p>, Bar: () => <span data-testid="kind-tools">Zoom</span> } as unknown as CanvasKindModule;

describe("a kind whose code did not load", () => {
  it("holds no bone in the bar while it has failed, and draws the kind's tools once Retry lands it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let tries = 0;
    const chunk = defineChunk<CanvasKindModule>("test-kind-retry", async () => {
      tries += 1;
      if (tries === 1) throw new TypeError("Failed to fetch dynamically imported module: /assets/kind.js");
      return module;
    });
    const kinds = { ...CANVAS, document: { ...CANVAS.document, history: false, chunk } };
    await act(async () => void render(<CanvasPane item={canvasItem("doc")} environmentId="local" feeds={NO_FEEDS} shell={shell} onAsk={() => undefined} kinds={kinds} />));
    await act(async () => undefined);
    expect(screen.getByText("Its viewer did not load")).toBeTruthy();
    expect(document.querySelector("[data-bar-bone]")).toBeNull();
    expect(screen.queryByTestId("kind-tools")).toBeNull();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await act(async () => undefined);
    expect(tries).toBe(2);
    expect(screen.getByTestId("body")).toBeTruthy();
    expect(screen.getByTestId("kind-tools")).toBeTruthy();
    expect(document.querySelector("[data-bar-bone]")).toBeNull();
  });
});
