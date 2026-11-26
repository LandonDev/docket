// @vitest-environment jsdom
/**
 * Escape from Go to or Search gives the focus back (council R2-C4): to what opened the field while it is still on the
 * page, else to the bar's press of the same name, which stands again where the field was. A press elsewhere that
 * closes the field leaves the focus where it landed.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/connection", async (original) => ({
  ...(await original<typeof import("../../lib/connection")>()),
  registry: { linkOf: () => ({ request: () => Promise.resolve({ entries: [] }) }), onLink: () => () => undefined },
}));

const { PageBar } = await import("./Page");

function Bar() {
  const [mode, setMode] = useState<"goto" | "search" | null>(null);
  const find = { link: "box", workspaceId: "w1", tabs: [], mode, setMode, onGoTo: () => undefined, onSearch: () => undefined };
  return (
    <>
      <PageBar name="Events" trail={[]} canBack={false} canForward={false} onBack={() => undefined} onForward={() => undefined} onGo={() => undefined} find={find} />
      <button type="button">Elsewhere</button>
    </>
  );
}

afterEach(cleanup);

describe("closing Go to and Search", () => {
  it("gives the focus back to the bar's press on Escape", async () => {
    render(<Bar />);
    for (const name of ["Go to", "Search"]) {
      const press = screen.getByRole("button", { name });
      press.focus();
      fireEvent.click(press);
      const field = await screen.findByRole(name === "Go to" ? "combobox" : "searchbox", { name });
      field.focus();
      await act(async () => void fireEvent.keyDown(field, { key: "Escape" }));
      expect(document.activeElement).toBe(screen.getByRole("button", { name }));
    }
  });

  it("gives the focus back to what opened Go to when it is still there", async () => {
    render(<Bar />);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    fireEvent.click(screen.getByRole("button", { name: "Go to" }));
    const field = await screen.findByRole("combobox", { name: "Go to" });
    field.focus();
    await act(async () => void fireEvent.keyDown(field, { key: "Escape" }));
    expect(document.activeElement).toBe(elsewhere);
  });
});
