// @vitest-environment jsdom
/**
 * The document kind's body around the editor (docs/DESIGN.md "The canvas
 * pane", Document): bones while it opens, at the frame's insets; a failed
 * open said once on the state line with nothing pulsing under it; Share only
 * on what can be shared; Ask's chip as the frame takes it.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasItem } from "@shared/work";
import type { CanvasShell, StatusLine } from "../canvas/kind";

const opening = vi.hoisted(() => ({ fail: (_: Error) => {}, made: 0 }));
vi.mock("./host", () => ({
  docHost: (env: string) => (opening.made++, { env, open: () => new Promise((_, reject) => (opening.fail = reject)) }),
  servedBy: () => null,
}));
const conn = vi.hoisted(() => ({ asked: [] as Array<{ method: string; params: unknown }>, answer: (_method: string): Promise<unknown> => Promise.resolve([]) }));
vi.mock("../../lib/connection", () => ({
  registry: {
    onLink: () => () => undefined,
    linkOf: () => ({ request: (method: string, params: unknown) => (conn.asked.push({ method, params }), conn.answer(method)), onPush: () => () => undefined }),
  },
}));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ error: (m: string) => void toasts.push(m) }) }));

const { Body, Bar, Scroller, TitleField, markOpen, selectionChip, useDocReview, useDocument } = await import("./DocumentCanvas");

afterEach(cleanup);

const FILE = { at: "file", host: "box", path: "/w/Run of show.tcdoc" } as const;
const ITEM = { id: "d1", sessionId: "t1", kind: "document", title: "Run of show", source: FILE } as CanvasItem;

describe("the document's body", () => {
  it("draws its bones with the item's name while it opens, and nothing under the state line once it cannot; it tells the frame it has not opened, so History waits", async () => {
    const lines: (StatusLine | null)[] = [];
    const ready: boolean[] = [];
    const shell = { statusLine: (line: StatusLine | null) => void lines.push(line), ready: (r: boolean) => void ready.push(r), more: () => {} } as unknown as CanvasShell;
    const { container } = render(<Body item={ITEM} source={FILE} env="box" state={undefined} setState={() => {}} shell={shell} />);
    expect(screen.getByRole("heading", { name: "Run of show" })).toBeTruthy();
    expect(container.querySelectorAll("[data-slot=skeleton]").length).toBe(3);
    expect(ready).toEqual([false]);
    await act(async () => opening.fail(new Error("That file is not there any more")));
    await waitFor(() => expect(lines.at(-1)).toMatchObject({ tone: "failed", word: "Couldn't open this document", detail: "That file is not there any more", action: { label: "Retry" } }));
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
    expect(container.querySelector("[aria-busy]")).toBeNull();
    expect(ready.at(-1)).toBe(false);
  });

  it("opens once for the same source: a canvas push's new copy of the item reopens nothing; another document opens", () => {
    const shell = { statusLine: () => {}, ready: () => {}, more: () => {} } as unknown as CanvasShell;
    const made = opening.made;
    const at = (source: typeof FILE | { at: "file"; host: string; path: string }) => <Body item={{ ...ITEM, source }} source={source} env="box" state={undefined} setState={() => {}} shell={shell} />;
    const { rerender } = render(at(FILE));
    rerender(at({ ...FILE }));
    rerender(at({ ...FILE }));
    expect(opening.made - made).toBe(1);
    rerender(at({ ...FILE, path: "/w/Budget.tcdoc" }));
    expect(opening.made - made).toBe(2);
  });
});

describe("the document's mode", () => {
  it("a change the host refuses puts back the mode he had before the press", async () => {
    let refuse = false;
    const host = {
      env: "box",
      onPush: () => () => undefined,
      threads: () => new Promise(() => undefined),
      mode: async (mode: string) => {
        if (refuse) throw new Error("not now");
        return { mode };
      },
    } as never;
    const open = { doc: "file:x", source: FILE, mode: "writes", shared: false, written: null, me: "owner", names: {} } as never;
    const { result } = renderHook(() => useDocument(host, open));
    await act(async () => result.current.setMode("suggests"));
    expect(result.current.mode).toBe("suggests");
    refuse = true;
    await act(async () => result.current.setMode("writes"));
    expect(result.current.mode).toBe("suggests");
  });
});

describe("the document's kept place", () => {
  it("comes back once the document is open and laid out tall enough to hold it, never over the bones", () => {
    // How tall the scrolled page is; the editor lays out after it mounts.
    let tall = 120;
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => tall);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
    const watched: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private fire: () => void) {}
        observe() {
          watched.push(this.fire);
        }
        disconnect() {}
      },
    );
    try {
      const page = (ready: boolean) => (
        <Scroller scrollTop={600} ready={ready} onScroll={() => undefined}>
          {() => <div data-page />}
        </Scroller>
      );
      const { container, rerender } = render(page(false));
      const scroller = container.querySelector("[data-doc-scroller]") as HTMLElement;
      // While it opens, the bones keep the top.
      expect(scroller.scrollTop).toBe(0);
      // Open, but the editor has not laid out: the place waits rather than clamp to a short page.
      rerender(page(true));
      expect(scroller.scrollTop).toBe(0);
      // The editor lays out: the kept place comes back.
      tall = 1400;
      act(() => watched.forEach((fire) => fire()));
      expect(scroller.scrollTop).toBe(600);
    } finally {
      height.mockRestore();
      client.mockRestore();
      vi.unstubAllGlobals();
    }
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

  it("takes the one focus ring, inset into the gutter so the words keep the text's edge", () => {
    render(<TitleField text="Run of show" rename={vi.fn(async () => {})} />);
    const field = screen.getByRole("textbox", { name: "Title" });
    for (const c of ["focus-ring", "-mx-1.5", "px-1.5", "rounded-md"]) expect(field.className.split(" ")).toContain(c);
  });
});

describe("the document's bar", () => {
  const LIFEOS = { at: "lifeos", table: "docs", id: "kd1" } as const;
  const bar = (source: CanvasItem["source"]) => <Bar item={{ ...ITEM, source }} source={source} env="box" state={undefined} setState={() => {}} shell={{} as CanvasShell} />;

  it("holds the bar's place with a bone while it opens, then draws Share only on a LifeOS document, which a guest link can reach", () => {
    const { container, unmount } = render(bar(FILE));
    // Before the body has said, and while it opens: the bone.
    expect(container.querySelector("[data-slot=skeleton]")).not.toBeNull();
    act(() => markOpen(ITEM.id, "open"));
    expect(container.innerHTML).toBe("");
    unmount();
    act(() => markOpen(ITEM.id, "opening"));
    const view = render(bar(LIFEOS));
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(view.container.querySelector("[data-slot=skeleton]")).not.toBeNull();
    act(() => markOpen(ITEM.id, "open"));
    // Led by its glyph, as the bar's other tools are.
    expect(screen.getByRole("button", { name: "Share" }).querySelector("svg")).not.toBeNull();
    act(() => markOpen(ITEM.id, "failed"));
    expect(view.container.innerHTML).toBe("");
    act(() => markOpen(ITEM.id, null));
  });

  it("draws nothing for a Word file, which becomes a document of its own", () => {
    const word = { at: "file", host: "box", path: "/w/Plan.docx" } as const;
    const { container } = render(bar(word));
    expect(container.innerHTML).toBe("");
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
    // Nor a bone: the bar has nothing, so it goes, and the failure is the tab row and the state line.
    expect(document.querySelector("[data-slot=skeleton]")).toBeNull();
  });
});

describe("Ask on a document's selection", () => {
  it("is the frame's chip: the first 40 characters in quotes, then the document's name", () => {
    const open = { title: "Run of show", source: FILE };
    expect(selectionChip("Pools  run\non 24 stations", open)).toEqual({ kind: "selection", label: "“Pools run on 24 stations”, Run of show", ref: FILE, quote: "Pools  run\non 24 stations" });
    expect(selectionChip("x".repeat(50), open).label).toBe(`“${"x".repeat(40)}…”, Run of show`);
  });
});

describe("a mail's attachment as a document", () => {
  const MAIL = { at: "mail", threadId: "mt1", messageId: "mm1", partId: "2", name: "Brief.docx" } as const;
  const ATT = { ...ITEM, id: "a1", sessionId: "mailpane_w1", title: "Brief.docx", source: MAIL } as CanvasItem;

  it("is read once into a document beside the host's copy and opened from there; a failed read says so with Retry", async () => {
    conn.asked.length = 0;
    let fail = true;
    conn.answer = (method) =>
      method !== "work.formats.import" ? Promise.resolve([]) : fail ? Promise.reject(new Error("LibreOffice is not installed here")) : Promise.resolve({ source: { at: "file", host: "box", path: "/data/canvas/mailpane_w1/a1/file/Brief.tcdoc" }, title: "Brief", warnings: [], outsiders: false });
    const lines: (StatusLine | null)[] = [];
    const shell = { statusLine: (line: StatusLine | null) => void lines.push(line), ready: () => {}, more: () => {} } as unknown as CanvasShell;
    render(<Body item={ATT} source={MAIL} env="box" state={undefined} setState={() => {}} shell={shell} />);
    await waitFor(() => expect(lines.at(-1)).toMatchObject({ tone: "failed", word: "Couldn't open this document", detail: "LibreOffice is not installed here", action: { label: "Retry" } }));
    // The item stays the attachment: nothing opens in its place, and no thread is named.
    expect(conn.asked).toEqual([{ method: "work.formats.import", params: { itemId: "a1", from: { at: "source", source: MAIL } } }]);
    fail = false;
    await act(async () => lines.at(-1)!.action!.run());
    await waitFor(() => expect(lines.at(-1)).toBeNull());
    expect(conn.asked.filter((a) => a.method === "work.formats.import")).toHaveLength(2);
    // The document it became opens (here the host's open waits): its bones, under the attachment's name.
    expect(screen.getByRole("heading", { name: "Brief.docx" })).toBeTruthy();
  });

  it("offers no Share in the bar", () => {
    act(() => markOpen("a1", "open"));
    const { container } = render(<Bar item={ATT} source={MAIL} env="box" state={undefined} setState={() => {}} shell={{} as CanvasShell} />);
    expect(container.innerHTML).toBe("");
  });

  it("Keep as document saves it to the workspace and imports that copy into the pane, in the attachment's place", async () => {
    conn.asked.length = 0;
    conn.answer = (method) => Promise.resolve(method === "work.canvas.keep" ? { path: "/Cosmic/Brief.docx", name: "Brief.docx" } : { source: { at: "file", host: "box", path: "/Cosmic/Brief.tcdoc" }, title: "Brief", warnings: [], outsiders: false });
    const { keepAsDocument } = await import("../formats/Import");
    await keepAsDocument("box", { id: "a1", sessionId: "mailpane_w1" });
    expect(conn.asked).toEqual([
      { method: "work.canvas.keep", params: { itemId: "a1" } },
      { method: "work.formats.import", params: { sessionId: "mailpane_w1", itemId: "a1", from: { at: "source", source: { at: "file", host: "box", path: "/Cosmic/Brief.docx" } } } },
    ]);
  });
});

describe("a document he may only view", () => {
  function Probe({ role, shell }: { role: "edit" | "view"; shell: CanvasShell }) {
    const source = { at: "file", host: "box", path: `/data/canvas/mailpane_w1/a1/file/Brief-${role}.tcdoc` } as const;
    useDocReview({ env: "box" } as never, { doc: "d", source, title: "Brief", role, shared: false, mode: "suggests", written: null, me: "owner", names: {} } as never, shell, null);
    return null;
  }

  it("offers no change to decide, while one he may edit steps its changes with Reject and Accept", async () => {
    // A Word file's tracked change, as the import leaves it: one pending branch by its author.
    const branch = { id: "b1", baseVersionId: "v1", authors: ["external:Ada Reviewer"], label: "Ada Reviewer", at: 1, editedAt: 1, diff: { rows: [{ id: "blk1", kind: "removed" }], lines: [{ id: "blk1", left: "Doors at nine", right: null }] } };
    conn.answer = (method) => Promise.resolve(method === "work.history.branches" ? { branches: [branch], names: { "external:Ada Reviewer": "Ada Reviewer" } } : []);
    const fed = { view: [] as unknown[], edit: [] as unknown[] };
    const shellOf = (role: "view" | "edit") => ({ review: (r: unknown) => void fed[role].push(r) }) as unknown as CanvasShell;
    render(
      <>
        <Probe role="edit" shell={shellOf("edit")} />
        <Probe role="view" shell={shellOf("view")} />
      </>,
    );
    await waitFor(() => expect(fed.edit.some((r) => (r as { count?: number } | null)?.count === 1)).toBe(true));
    expect(fed.view.every((r) => r === null)).toBe(true);
  });
});

it("the document stepper exposes a page-only suggestion and sends its id on Reject", async () => {
  const branch = { id: "page-branch", baseVersionId: "v1", authors: ["agent:box:t1"], label: "Suggestions", at: 1, editedAt: 1,
    diff: { rows: [], lines: [], page: ["Header changed"] } };
  conn.answer = (method) => Promise.resolve(method === "work.history.branches" ? { branches: [branch], names: {} } : { left: 0 });
  let hooks: Parameters<CanvasShell["review"]>[0] | undefined;
  function Probe() {
    const source = { at: "file", host: "box", path: "/data/page-review.tcdoc" } as const;
    const review = useDocReview({ env: "box" } as never, { doc: "page", source, role: "edit" } as never,
      { review: (value) => { hooks = value; } } as CanvasShell, null);
    return <div>{review.pageWords?.join(", ")}</div>;
  }
  render(<Probe />);
  expect(await screen.findByText("Header changed")).toBeTruthy();
  expect(hooks?.count).toBe(1);
  await act(async () => { await hooks?.reject(0); });
  expect(conn.asked.find((req) => req.method === "work.history.decide")?.params).toMatchObject({ branchId: "page-branch", which: ["@page"], accept: false });
});
