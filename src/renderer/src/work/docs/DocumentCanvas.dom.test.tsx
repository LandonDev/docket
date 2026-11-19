// @vitest-environment jsdom
/**
 * The document kind's body around the editor (docs/DESIGN.md "The canvas
 * pane", Document): bones while it opens, at the frame's insets; a failed
 * open said once on the state line with nothing pulsing under it; Share only
 * on what can be shared; Ask's chip as the frame takes it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasItem } from "@shared/work";
import type { CanvasShell, StatusLine } from "../canvas/kind";

const opening = vi.hoisted(() => ({ fail: (_: Error) => {} }));
vi.mock("./host", () => ({
  docHost: (env: string) => ({ env, open: () => new Promise((_, reject) => (opening.fail = reject)) }),
  servedBy: () => null,
}));
vi.mock("../../lib/connection", () => ({ registry: { onLink: () => () => undefined, linkOf: () => ({ request: async () => [], onPush: () => () => undefined }) } }));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ error: (m: string) => void toasts.push(m) }) }));

const { Body, Bar, TitleField, markOpen, selectionChip } = await import("./DocumentCanvas");

afterEach(cleanup);

const FILE = { at: "file", host: "box", path: "/w/Run of show.tcdoc" } as const;
const ITEM = { id: "d1", sessionId: "t1", kind: "document", title: "Run of show", source: FILE } as CanvasItem;

describe("the document's body", () => {
  it("draws its bones with the item's name while it opens, and nothing under the state line once it cannot", async () => {
    const lines: (StatusLine | null)[] = [];
    const shell = { statusLine: (line: StatusLine | null) => void lines.push(line), more: () => {} } as unknown as CanvasShell;
    const { container } = render(<Body item={ITEM} source={FILE} env="box" state={undefined} setState={() => {}} shell={shell} />);
    expect(screen.getByRole("heading", { name: "Run of show" })).toBeTruthy();
    expect(container.querySelectorAll("[data-slot=skeleton]").length).toBe(3);
    await act(async () => opening.fail(new Error("That file is not there any more")));
    await waitFor(() => expect(lines.at(-1)).toMatchObject({ tone: "failed", word: "Couldn't open this document", detail: "That file is not there any more", action: { label: "Retry" } }));
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
    expect(container.querySelector("[aria-busy]")).toBeNull();
  });
});

describe("the document's title", () => {
  it("puts a refused rename back, and says why once", async () => {
    const rename = vi.fn(async () => {
      throw new Error("LifeOS did not answer");
    });
    render(<TitleField text="Run of show" rename={rename} />);
    const field = screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Run of show, final" } });
    await act(async () => fireEvent.blur(field));
    expect(rename).toHaveBeenCalledWith("Run of show, final");
    await waitFor(() => expect(toasts).toEqual(["LifeOS did not answer"]));
    expect(field.value).toBe("Run of show");
  });
});

describe("the document's bar", () => {
  const LIFEOS = { at: "lifeos", table: "docs", id: "kd1" } as const;
  const bar = (source: CanvasItem["source"]) => <Bar item={{ ...ITEM, source }} source={source} env="box" state={undefined} setState={() => {}} shell={{} as CanvasShell} />;

  it("draws Share only on a LifeOS document, which a guest link can reach, once it has opened", () => {
    const { container, unmount } = render(bar(FILE));
    act(() => markOpen(ITEM.id, true));
    expect(container.innerHTML).toBe("");
    unmount();
    act(() => markOpen(ITEM.id, false));
    const view = render(bar(LIFEOS));
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    act(() => markOpen(ITEM.id, true));
    // Led by its glyph, as the bar's other tools are.
    expect(screen.getByRole("button", { name: "Share" }).querySelector("svg")).not.toBeNull();
    act(() => markOpen(ITEM.id, false));
    expect(view.container.innerHTML).toBe("");
  });

  it("offers no Share on a document that did not open", async () => {
    const lines: (StatusLine | null)[] = [];
    const shell = { statusLine: (line: StatusLine | null) => void lines.push(line), more: () => {} } as unknown as CanvasShell;
    const item = { ...ITEM, source: LIFEOS };
    render(
      <>
        {bar(LIFEOS)}
        <Body item={item} source={LIFEOS} env="box" state={undefined} setState={() => {}} shell={shell} />
      </>,
    );
    await act(async () => opening.fail(new Error("not connected")));
    await waitFor(() => expect(lines.at(-1)).toMatchObject({ word: "Couldn't open this document" }));
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });
});

describe("Ask on a document's selection", () => {
  it("is the frame's chip: the first 40 characters in quotes, then the document's name", () => {
    const open = { title: "Run of show", source: FILE };
    expect(selectionChip("Pools  run\non 24 stations", open)).toEqual({ kind: "selection", label: "“Pools run on 24 stations”, Run of show", ref: FILE, quote: "Pools  run\non 24 stations" });
    expect(selectionChip("x".repeat(50), open).label).toBe(`“${"x".repeat(40)}…”, Run of show`);
  });
});
