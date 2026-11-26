// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SavedEnvironment } from "@server/shared/contract-remote";

/**
 * The addresses dialog on the dialog recipe: routes moving with the last one
 * held. A computer's name is a field on its page now (computers/OnThisMac),
 * and adding a device, a bot's key and a link to a computer moved to Add a
 * computer… (computers/AddComputer.dom.test.tsx).
 */

const calls: { method: string; params: unknown }[] = [];
const answers = new Map<string, unknown>();
vi.mock("../rpc", () => ({
  rpc: async (method: string, params: unknown) => {
    calls.push({ method, params });
    return answers.get(method);
  },
}));

const { tooltipChunk, warmTooltips } = await import("@renderer/components/ui/tooltip");
const { RoutesDialog } = await import("./RoutesDialog");

// Tooltips load their primitive on the first hover; load it once up front.
beforeAll(async () => {
  await tooltipChunk.load();
  warmTooltips();
});

const writeText = vi.fn(async () => undefined);
beforeEach(() => {
  calls.length = 0;
  answers.clear();
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

const env = (over: Partial<SavedEnvironment> = {}): SavedEnvironment =>
  ({
    id: "env_box",
    name: "box",
    routes: [
      { url: "wss://tempcode.example.com/ws", kind: "tunnel" },
      { url: "ws://10.0.0.5:7677/ws", kind: "lan" },
    ],
    ...over,
  }) as SavedEnvironment;

const noop = async () => undefined;

describe("RoutesDialog", () => {
  it("moves a route, holds the last one, and saves the order", async () => {
    const onClose = vi.fn();
    render(<RoutesDialog env={env()} onClose={onClose} onChanged={noop} />);
    const origins = () => within(screen.getByRole("list", { name: "Addresses" })).getAllByRole("listitem").map((row) => row.textContent);
    expect(origins()[0]).toContain("tempcode.example.com");

    const [firstDown] = screen.getAllByRole("button", { name: "Move down" });
    fireEvent.click(firstDown);
    expect(origins()[0]).toContain("10.0.0.5:7677");
    expect(screen.getAllByRole("button", { name: "Move up" })[0].hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove the address" })[1]);
    expect(origins()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Remove the address" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(calls[0]).toEqual({ method: "remote.environments.update", params: { id: "env_box", routes: [{ url: "ws://10.0.0.5:7677/ws", kind: "lan" }] } });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
