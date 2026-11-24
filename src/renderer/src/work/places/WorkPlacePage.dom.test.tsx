// @vitest-environment jsdom
/** The frame of a page above the Work workspaces: its header's end is the place's own, also when he goes straight from one place to another. */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineChunk } from "../../lib/lazyChunk";
import type { WorkPlaceModule } from "./registry";

const place = (name: string): WorkPlaceModule => ({ View: () => <p>{`${name} body`}</p>, Head: () => <span>{`${name} head`}</span> });
const chunks = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./registry", async (original) => ({
  ...(await original<object>()),
  placeChunk: (id: string) => chunks.get(id) ?? null,
}));
// The window's own chrome is not this test's.
vi.mock("../../chrome/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../../chrome/TitleBar", () => ({ OverlayNav: () => null }));
chunks.set("today", defineChunk("test-place-today", () => Promise.resolve(place("Today"))));
chunks.set("review", defineChunk("test-place-review", () => Promise.resolve(place("Review"))));

const { WorkPlacePage } = await import("./WorkPlacePage");

afterEach(cleanup);

describe("a place's frame", () => {
  it("draws each place's own header end, from Review straight to Today and back", async () => {
    const { rerender } = render(<WorkPlacePage place="review" onClose={() => {}} />);
    expect(await screen.findByText("Review head")).toBeTruthy();
    expect(await screen.findByText("Review body")).toBeTruthy();
    // The frame stays mounted: only the place changes.
    rerender(<WorkPlacePage place="today" onClose={() => {}} />);
    expect(screen.queryByText("Review head")).toBeNull();
    expect(await screen.findByText("Today head")).toBeTruthy();
    expect(await screen.findByText("Today body")).toBeTruthy();
    rerender(<WorkPlacePage place="review" onClose={() => {}} />);
    expect(screen.queryByText("Today head")).toBeNull();
    expect(screen.getByText("Review head")).toBeTruthy();
    await act(async () => {});
    expect(screen.getByText("Review head")).toBeTruthy();
  });
});
