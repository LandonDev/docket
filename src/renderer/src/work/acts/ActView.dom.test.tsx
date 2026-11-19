// @vitest-environment jsdom
/** ActView says when the act's payload is on screen: not while its chunk loads or after it fails, and again once its Retry draws it. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineChunk } from "../../lib/lazyChunk";

const tries = vi.hoisted(() => ({ n: 0 }));
vi.mock("./registry", async () => ({
  ACT_VIEWS: {
    "form.publish": {
      kind: "form.publish",
      chunk: defineChunk("test-act", async () => {
        if (tries.n++ === 0) throw new Error("chunk failed");
        return { View: () => <div data-slot="act-payload">The form</div> };
      }),
    },
  },
}));

const { ActView } = await import("./ActView");

afterEach(cleanup);
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe("ActView's readiness", () => {
  it("is false while the view fails to load, and true once its Retry draws it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ready: boolean[] = [];
    render(<ActView item={{ kind: "form.publish", payload: {} } as never} env="box" onReady={(r) => ready.push(r)} />);
    await flush();
    await flush();
    expect(ready.at(-1)).toBe(false);
    expect(ready).not.toContain(true);
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Retry" })));
    await flush();
    await flush();
    expect(screen.getByText("The form")).toBeTruthy();
    expect(ready.at(-1)).toBe(true);
  });

  it("is true at once for the generic view", () => {
    const ready: boolean[] = [];
    render(<ActView item={{ kind: "teams.post", payload: { chat: "Staff", text: "Hi" } } as never} env="box" onReady={(r) => ready.push(r)} />);
    expect(ready).toEqual([true]);
  });
});
