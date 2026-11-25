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
    "frameio.comment": { kind: "frameio.comment", chunk: defineChunk("test-act-slow", () => new Promise(() => {})) },
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

  it("draws bones in the payload's shape while the view loads, never a spinner", async () => {
    const ready: boolean[] = [];
    const { container } = render(<ActView item={{ kind: "frameio.comment", payload: {} } as never} env="box" onReady={(r) => ready.push(r)} />);
    await flush();
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    // Three header rows and three lines of body, the act's own shape.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(9);
    expect(screen.queryByText(/Loading the act/)).toBeNull();
    expect(ready).not.toContain(true);
  });

  it("is true at once for the generic view", () => {
    const ready: boolean[] = [];
    render(<ActView item={{ kind: "teams.post", payload: { chat: "Staff", text: "Hi" } } as never} env="box" onReady={(r) => ready.push(r)} />);
    expect(ready).toEqual([true]);
  });
});

describe("a kind's view that fails", () => {
  it("is one quiet line with Retry, no bones under it, and no payload for Send to wait on", async () => {
    const { ACT_VIEWS } = await import("./registry");
    const { defineChunk } = await import("../../lib/lazyChunk");
    const { ActView } = await import("./ActView");
    const { render, screen, waitFor } = await import("@testing-library/react");
    const was = ACT_VIEWS["teams.post"];
    ACT_VIEWS["teams.post"] = { kind: "teams.post", chunk: defineChunk("act-fails", () => Promise.resolve({ View: () => { throw new Error("bad payload"); } })) as never };
    try {
      const { container } = render(<ActView item={{ kind: "teams.post", payload: {} } as never} env="local" />);
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Its details could not be read."));
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
      expect(container.querySelector('[data-slot="act-payload"]')).toBeNull();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    } finally {
      ACT_VIEWS["teams.post"] = was;
    }
  });
});
