// @vitest-environment jsdom
/**
 * A menu row that answers in place (menuRows.tsx `keepOpen`, `busy`): the Work heading's + menu's Retry asks its host
 * with the menu open, its row spinning, and the answer's state replaces the row, the menu still open (council round 11).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { menuChunk } from "../surfaces/chunks";
import { resetMenus, RowsContextMenu, type MenuRow } from "./menuRows";

beforeEach(() => resetMenus());
afterEach(cleanup);

function Rail({ answer }: { answer: Promise<void> }) {
  const [state, setState] = useState<"down" | "asking" | "back">("down");
  const open = useRef<((at: { x: number; y: number; id: string | null }) => void) | null>(null);
  const rows = (): MenuRow[] =>
    state === "back"
      ? [{ kind: "note", id: "work:connecting", content: "LifeOS is still connecting on the box" }]
      : [{ kind: "item", id: "work:retry", label: "Retry", description: "LifeOS did not answer the box", keepOpen: true, ...(state === "asking" ? { busy: true } : {}) }];
  return (
    <>
      <button onClick={() => open.current?.({ x: 1, y: 1, id: "work:add" })}>Add</button>
      <RowsContextMenu label="Workspace actions" rowsFor={rows} openRef={open} onPick={() => (setState("asking"), void answer.then(() => setState("back")))}>
        <div />
      </RowsContextMenu>
    </>
  );
}

describe("a row that answers in place", () => {
  it("keeps the menu open on its press, spins the row while it asks, and lets the answer replace the row", async () => {
    let release!: () => void;
    render(<Rail answer={new Promise((done) => (release = done))} />);
    await act(() => menuChunk.load().then(() => new Promise((r) => setTimeout(r, 0))));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const menu = await screen.findByRole("menu", { name: "Workspace actions" });
    fireEvent.click(screen.getByRole("menuitem", { name: /Retry/ }));
    const row = screen.getByRole("menuitem", { name: /Retry/ });
    expect(row.getAttribute("aria-busy")).toBe("true");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.querySelector("[data-slot=spinner], [role=status], svg")).toBeTruthy();
    await act(async () => release());
    expect(screen.getByRole("menu", { name: "Workspace actions" })).toBe(menu);
    expect(menu.textContent).toContain("LifeOS is still connecting on the box");
    expect(screen.queryByRole("menuitem", { name: /Retry/ })).toBeNull();
  });
});
