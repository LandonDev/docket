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

  it("wakes every pane of the kind with its bar once one pane's Retry lands the code, and none before", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let tries = 0;
    let land: () => void = () => undefined;
    const chunk = defineChunk<CanvasKindModule>("test-kind-retry-two", () => {
      tries += 1;
      if (tries === 1) return Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/kind.js"));
      // The second try fails; the third waits for the test to land it.
      if (tries === 2) return Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/kind.js"));
      return new Promise((resolve) => (land = () => resolve(module)));
    });
    const kinds = { ...CANVAS, document: { ...CANVAS.document, history: false, chunk } };
    const pane = (id: string) => <CanvasPane item={canvasItem(id)} environmentId="local" feeds={NO_FEEDS} shell={shell} onAsk={() => undefined} kinds={kinds} />;
    await act(async () => void render(<>{pane("a")}{pane("b")}</>));
    await act(async () => undefined);
    expect(screen.getAllByText("Its viewer did not load")).toHaveLength(2);
    // A Retry whose load fails again wakes no other pane's bar.
    await act(async () => void fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!));
    await act(async () => undefined);
    expect(screen.getAllByText("Its viewer did not load")).toHaveLength(2);
    expect(screen.queryByTestId("kind-tools")).toBeNull();
    expect(document.querySelector("[data-bar-bone]")).toBeNull();
    // While the next try is out, the other pane is as it was: no tools over its failure.
    await act(async () => void fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!));
    expect(screen.getAllByText("Its viewer did not load")).toHaveLength(1);
    expect(screen.queryByTestId("kind-tools")).toBeNull();
    await act(async () => land());
    await act(async () => undefined);
    expect(screen.queryByText("Its viewer did not load")).toBeNull();
    expect(screen.getAllByTestId("body")).toHaveLength(2);
    expect(screen.getAllByTestId("kind-tools")).toHaveLength(2);
  });
});


describe("a kind that draws nothing in the bar", () => {
  it("holds no bar while its code loads, so none comes and goes over the body; a kind with tools holds its bone", async () => {
    const waits = defineChunk<CanvasKindModule>("test-kind-barless", () => new Promise(() => undefined));
    const barless = { ...CANVAS, document: { ...CANVAS.document, history: false, bar: false as const, chunk: waits } };
    const view = render(<CanvasPane item={canvasItem("doc")} environmentId="local" feeds={NO_FEEDS} shell={shell} onAsk={() => undefined} kinds={barless} />);
    await act(async () => undefined);
    expect(document.querySelector("[data-canvas-bar]")).toBeNull();
    view.unmount();
    const tooled = { ...CANVAS, document: { ...CANVAS.document, history: false, chunk: defineChunk<CanvasKindModule>("test-kind-tooled", () => new Promise(() => undefined)) } };
    render(<CanvasPane item={canvasItem("doc")} environmentId="local" feeds={NO_FEEDS} shell={shell} onAsk={() => undefined} kinds={tooled} />);
    await act(async () => undefined);
    expect(document.querySelector("[data-canvas-bar] [data-bar-bone]")).not.toBeNull();
  });

  it("is the file kind: its code has no Bar and its pane no History", async () => {
    expect(CANVAS.file.bar).toBe(false);
    expect(CANVAS.file.history).toBeUndefined();
    expect("Bar" in (await import("../files/FileKind"))).toBe(false);
  });
});
