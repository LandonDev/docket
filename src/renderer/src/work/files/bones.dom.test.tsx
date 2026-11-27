// @vitest-environment jsdom
/**
 * The Files place's waits (docs/agents/loading-bones.md): each is the piece that shows the answer, drawn from the
 * folder's samples while its read is out, inert and hidden, and the answer lands over it.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FilesHome } from "@shared/contract-work-files";
import { HomePage } from "./Home";
import { ListBones, PageBones } from "./Page";
import { ArchiveList } from "./Preview";
import { SAMPLE_ENTRIES } from "./samples";

afterEach(cleanup);
const drawing = (): Element => document.querySelector("[data-region][data-bones] [skullet-loading]")!;
const settled = () => waitFor(() => expect(document.querySelector("[skullet-loading]")).toBeNull());

describe("the Files place's bones", () => {
  it("a folder's wait is the list itself: its column heads and the sample's rows, inert", () => {
    render(<PageBones />);
    expect(drawing().getAttribute("aria-hidden")).toBe("true");
    expect(drawing().querySelector("[data-files-bar-bones]")).toBeTruthy();
    expect(drawing().querySelectorAll("[data-files-list] [data-files-row]")).toHaveLength(SAMPLE_ENTRIES.length);
    // Nothing of the drawing is a control he can reach.
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("the list's second fact follows the folder's, so the heads do not change when the rows land", () => {
    render(<ListBones second="Where" />);
    expect(document.body.textContent).toContain("Where");
  });

  it("Home draws its own lists from the sample while it is read, then the answer lands", async () => {
    const view = render(<HomePage panelId="p" home={null} error={null} busy={null} bar={null} onRetry={() => undefined} onOpen={() => undefined} />);
    expect([...drawing().querySelectorAll("section")].map((s) => s.getAttribute("aria-label"))).toEqual(["Starred", "Recent"]);
    const home: FilesHome = { waiting: [], starred: [], recent: [] };
    view.rerender(<HomePage panelId="p" home={home} error={null} busy={null} bar={null} onRetry={() => undefined} onOpen={() => undefined} />);
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    await settled();
  });

  it("a zip's listing waits as its rows, and a failure lands in their place", async () => {
    const view = render(<ArchiveList view={{ is: "loading" }} />);
    expect(drawing().querySelectorAll("[role=listitem]").length).toBeGreaterThan(0);
    view.rerender(<ArchiveList view={{ is: "failed", why: "It could not be read." }} />);
    expect(screen.getByText("It could not be read.")).toBeTruthy();
    await settled();
  });
});
