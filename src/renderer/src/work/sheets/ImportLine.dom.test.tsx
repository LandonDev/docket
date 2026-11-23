// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ImportLine } from "./ImportLine";

afterEach(cleanup);

describe("the quiet line over a sheet opened as a copy", () => {
  it("draws its words and one press, which runs the act the words lead to", async () => {
    const ran: string[] = [];
    render(<ImportLine imported={{ format: "xls", name: "Ledger.xls" }} shared={false} run={async (a) => void ran.push(a)} />);
    const line = document.querySelector("[data-sheet-import]")!;
    expect(line.getAttribute("data-sheet-import")).toBe("xls");
    expect(line.textContent).toContain("Edits save to an Excel copy. Saving back as .xls drops tables and newer functions.");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Save back" })));
    expect(ran).toEqual(["back"]);
  });

  it("is off while its press runs, takes no second press, and comes back when it ends", async () => {
    let end: () => void = () => {};
    let runs = 0;
    render(<ImportLine imported={{ format: "ods", name: "Ledger.ods", stale: true }} shared={false} run={() => (runs++, new Promise<void>((done) => (end = done)))} />);
    const button = screen.getByRole("button", { name: "Save as Excel" }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.querySelector("[data-busy]")).not.toBeNull();
    fireEvent.click(button);
    expect(runs).toBe(1);
    await act(async () => end());
    expect(button.disabled).toBe(false);
  });

  it("the words are never cut: they wrap", () => {
    render(<ImportLine imported={{ format: "tsv", name: "Scores.tsv" }} shared run={async () => {}} />);
    const words = document.querySelector("[data-sheet-import] > span")!;
    expect(words.className).not.toContain("truncate");
    expect(words.textContent).toBe("Edits stay in this tab's Excel copy until you save back. Saving back as .tsv drops formulas, formatting and other sheets.");
  });
});
