// @vitest-environment jsdom
/**
 * Save to Google Sheets in the sheet's More (toGoogle.tsx): the row is offered on the host's word alone, and
 * its press opens the google pillar's dialog, whose Save asks `work.google.upload` for this item.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MoreEntry } from "../canvas/kind";

const wire = vi.hoisted(() => ({ asked: [] as { env: string; method: string; params: unknown }[], accounts: [{ account: "owner@example.test", files: true }] as { account: string; files: boolean }[], refuse: null as string | null }));
vi.mock("../../lib/connection", () => ({
  registry: {
    primaryEnvironmentId: "box",
    onLink: () => () => undefined,
    linkOf: (env: string) => ({
      request: async (method: string, params: unknown) => {
        wire.asked.push({ env, method, params });
        if (method === "work.google.accounts") return { accounts: wire.accounts, picker: false };
        if (wire.refuse) throw new Error(wire.refuse);
        return { fileId: "dummy", url: "https://docs.google.com/spreadsheets/d/dummy/edit" };
      },
    }),
  },
}));

const { useSaveToGoogle } = await import("./toGoogle");

let row: MoreEntry | null = null;
function Seat({ offered }: { offered: boolean }) {
  const google = useSaveToGoogle({ env: "box", itemId: "item1", offered });
  row = google.row;
  return <>{google.dialog}</>;
}

afterEach(() => {
  cleanup();
  wire.asked.length = 0;
  wire.refuse = null;
  row = null;
});

describe("Save to Google Sheets", () => {
  it("is a row of More only where the host offers it", () => {
    const { rerender } = render(<Seat offered={false} />);
    expect(row).toBeNull();
    rerender(<Seat offered />);
    expect(row).toMatchObject({ id: "google-upload", label: "Save to Google Sheets" });
    // The same row while the offer stands: More is not fed a new list on every render.
    const first = row;
    rerender(<Seat offered />);
    expect(row).toBe(first);
  });

  it("opens the account dialog, and Save uploads this item to the picked account on the item's host", async () => {
    render(<Seat offered />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => void row!.run());
    const dialog = await screen.findByRole("dialog", { name: "Save to Google Sheets" });
    expect(await within(dialog).findByText("owner@example.test")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(wire.asked.find((a) => a.method === "work.google.upload")).toEqual({ env: "box", method: "work.google.upload", params: { account: "owner@example.test", itemId: "item1" } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the dialog open with the host's own words when the upload is refused", async () => {
    wire.refuse = "A file from a shared library stays on this host.";
    render(<Seat offered />);
    await act(async () => void row!.run());
    const dialog = await screen.findByRole("dialog", { name: "Save to Google Sheets" });
    await within(dialog).findByText("owner@example.test");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("A file from a shared library stays on this host.")).toBeTruthy();
  });

  it("closes with an offer the host takes back", async () => {
    const { rerender } = render(<Seat offered />);
    await act(async () => void row!.run());
    await screen.findByRole("dialog", { name: "Save to Google Sheets" });
    rerender(<Seat offered={false} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(row).toBeNull();
  });
});
