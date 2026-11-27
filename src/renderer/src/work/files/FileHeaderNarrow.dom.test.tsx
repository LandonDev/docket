// @vitest-environment jsdom
/**
 * A file's header under 480px (docs/DESIGN.md "The Files place"): the save line's first press stays, its second is
 * the first row of ⋯ and runs from there, and a cut line has its whole words in a tooltip. Wider, both presses are
 * drawn and ⋯ holds only the file's own rows. The line's words and the order of its presses do not change.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
import type { SavedAction } from "../canvas/kind";

const { FileHeader } = await import("./FileTabView");
const { SaveActions, SaveLine, tuckedRows, TUCKED } = await import("./SaveLine");
const { SeatBar } = await import("./Looks");

let width = 400;
class Measured {
  constructor(private readonly heard: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.heard([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(async () => {
  await act(async () => {
    await tooltipChunk.load();
    warmTooltips();
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ran: string[] = [];
const actions: SavedAction[] = [
  { id: "reload", label: "Reload", run: async () => void ran.push("reload") },
  { id: "keep", label: "Keep Both", run: async () => void ran.push("keep") },
];
const draw = (onRun: (action: SavedAction) => void) =>
  render(
    <FileHeader
      name="Spring LAN 2027 run of show.docx"
      line={{ state: "changed", actions }}
      where="Events"
      running={null}
      onRun={onRun}
      rows={[{ kind: "item", id: "rename", label: "Rename" }]}
      onPick={() => undefined}
      ask={{ disabled: false, pressed: false, run: () => undefined }}
    />,
  );

describe("a file header's presses", () => {
  it("take a second row at the end where the name and its line would be cut: the name keeps 16rem", () => {
    vi.stubGlobal("ResizeObserver", Measured);
    width = 600;
    draw(() => undefined);
    const header = document.querySelector<HTMLElement>("[data-files-header]")!;
    expect(header.className.split(" ")).toEqual(expect.arrayContaining(["flex-wrap", "min-h-12", "py-1"]));
    expect(header.className.split(" ")).not.toContain("h-12");
    const name = header.querySelector<HTMLElement>("[data-files-head-name]")!;
    expect(name.className.split(" ")).toContain("flex-[1_1_16rem]");
    // The presses are one group at the row's end, ⋯ and Ask with them, so they move to the second row together.
    const presses = header.querySelector<HTMLElement>("[data-files-head-presses]")!;
    expect(presses.className.split(" ")).toEqual(expect.arrayContaining(["ms-auto", "shrink-0"]));
    for (const label of ["Reload", "Ask"]) expect(presses.contains(within(header).getByRole("button", { name: label }))).toBe(true);
  });

  /** The live walk (S9): the name's rename press was its 20px line, cut by its truncating heading. */
  it("give the name's rename press 24px over its 20px line, cut in its own span so the heading clips nothing", () => {
    width = 900;
    render(<FileHeader name="Notes.md" line={null} where="Events" running={null} onRun={() => undefined} rows={[]} onPick={() => undefined} rename={{ on: false, start: () => undefined, done: () => undefined }} ask={{ disabled: false, pressed: false, run: () => undefined }} />);
    const press = document.querySelector<HTMLElement>("[data-files-rename-name]")!;
    expect(press.className.split(" ")).toEqual(expect.arrayContaining(["relative", "h-5", "after:absolute", "after:-inset-y-0.5"]));
    expect(press.closest("h2")!.className.split(" ")).not.toContain("truncate");
    expect(press.querySelector(".truncate")?.textContent).toBe("Notes.md");
  });

  it("keep one row with no line press: the name gives way first", () => {
    vi.stubGlobal("ResizeObserver", Measured);
    render(<FileHeader name="Notes.md" line={null} where="Events" running={null} onRun={() => undefined} rows={[]} onPick={() => undefined} ask={{ disabled: false, pressed: false, run: () => undefined }} />);
    const name = document.querySelector<HTMLElement>("[data-files-head-name]")!;
    expect(name.className.split(" ")).toContain("flex-1");
    expect(name.className.split(" ")).not.toContain("flex-[1_1_16rem]");
  });
});

describe("a narrow file header", () => {
  it("draws the second press in ⋯ and runs it from there", async () => {
    width = 400;
    vi.stubGlobal("ResizeObserver", Measured);
    const run = vi.fn();
    draw(run);
    const header = document.querySelector<HTMLElement>("[data-files-header]")!;
    // The second press is hidden under 480px of header by its container query, the first is not.
    expect(within(header).getByRole("button", { name: "Reload" }).className.split(" ")).not.toContain("hidden");
    const second = within(header).getByRole("button", { name: "Keep Both" }).className.split(" ");
    expect(second).toContain("hidden");
    expect(second).toContain("@[480px]/file-head:inline-flex");
    fireEvent.click(within(header).getByRole("button", { name: /^More for/ }));
    const menu = await screen.findByRole("menu");
    const rows = within(menu).getAllByRole("menuitem").map((row) => row.textContent);
    expect(rows).toEqual(["Keep Both", "Rename"]);
    await act(async () => void fireEvent.click(within(menu).getByRole("menuitem", { name: "Keep Both" })));
    expect(run).toHaveBeenCalledWith(actions[1]);
  });

  it("keeps ⋯ to the file's own rows where the header is wide", async () => {
    width = 640;
    vi.stubGlobal("ResizeObserver", Measured);
    draw(() => undefined);
    fireEvent.click(within(document.querySelector<HTMLElement>("[data-files-header]")!).getByRole("button", { name: /^More for/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((row) => row.textContent)).toEqual(["Rename"]);
  });

  it("puts no row first while a press is under way, and none with one press alone", () => {
    expect(tuckedRows([], actions, true, null)[0]).toMatchObject({ id: TUCKED, label: "Keep Both", disabled: false });
    expect(tuckedRows([], actions, true, "reload")[0]).toMatchObject({ id: TUCKED, disabled: true });
    expect(tuckedRows([], actions.slice(0, 1), true, null)).toEqual([]);
    expect(tuckedRows([], actions, false, null)).toEqual([]);
  });
});

describe("a save line outside a file's header", () => {
  it("draws both presses where no ⋯ holds the second (a side file, the Beside seat)", () => {
    render(<SaveActions actions={actions} busy={null} onRun={() => undefined} />);
    for (const name of ["Reload", "Keep Both"]) expect(screen.getByRole("button", { name }).className.split(" ")).not.toContain("hidden");
  });
});

describe("a cut save line", () => {
  const words = "This file changed on MacBook Pro at 2:14 PM while you had changes here";
  // jsdom lays nothing out: the line reads as cut where the test says so.
  const cut = () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-files-save-line") ? 900 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-files-save-line") ? 200 : 0;
    });
  };

  it("is a Tab stop with its whole words in a tooltip", () => {
    cut();
    render(<SaveLine line={{ state: "conflict", words }} where={null} />);
    const line = screen.getByText(words);
    expect(line.getAttribute("tabindex")).toBe("0");
    expect(line.getAttribute("data-slot")).toBe("tooltip-trigger");
  });

  it("is no Tab stop whole, and leaves its folder the one stop when cut", () => {
    render(<SaveLine line={{ state: "conflict", words }} where={null} />);
    expect(screen.getByText(words).hasAttribute("tabindex")).toBe(false);
    cleanup();
    vi.restoreAllMocks();
    cut();
    render(<SaveLine line={{ state: "saved", at: Date.now() }} where="Esports Staff › Events › Spring LAN 2027" onShowFolder={() => undefined} />);
    const line = document.querySelector<HTMLElement>("[data-files-save-line]")!;
    expect(line.hasAttribute("tabindex")).toBe(false);
    expect(within(line).getByRole("button")).toBeTruthy();
  });
});

describe("the Beside seat's bar", () => {
  const presses = () => document.querySelector<HTMLElement>("[data-files-seat-presses]")!.className.split(" ");

  it("gives a line that needs him the first row under 520px of seat, its presses a second row at the end", () => {
    render(<SeatBar saved={{ state: "conflict", detail: "This file changed at 2:14 PM", actions }} running={null} onRun={() => undefined} onTab={() => undefined} />);
    expect(document.querySelector("[data-files-seat-bar]")!.className.split(" ")).toContain("@container/seat-bar");
    // The bar wraps; the presses fill a row of their own until the seat is 520px wide, then sit beside the line.
    expect(document.querySelector("[data-files-seat-bar] > div")!.className.split(" ")).toContain("flex-wrap");
    expect(presses()).toEqual(expect.arrayContaining(["w-full", "justify-end", "@[520px]/seat-bar:w-auto"]));
    expect(screen.getByText("This file changed at 2:14 PM")).toBeTruthy();
    for (const name of ["Reload", "Keep Both", "Open in a Tab"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it("keeps one row where the line has no press", () => {
    render(<SeatBar saved={{ state: "saved", at: Date.now() }} running={null} onRun={() => undefined} onTab={() => undefined} />);
    expect(presses()).not.toContain("w-full");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Open in a Tab"]);
  });
});

/** Polish 2 council round 1 (R1-C11, R1-C12): "In Events" was plain words, and the save line's folder 16px to hit. */
describe("the folder a file's line names", () => {
  const head = (line: Parameters<typeof FileHeader>[0]["line"], onShowFolder?: () => void) =>
    render(<FileHeader name="Budget.xlsx" line={line} where="Events" running={null} onRun={() => undefined} {...(onShowFolder ? { onShowFolder } : {})} rows={[]} onPick={() => undefined} ask={{ disabled: false, pressed: false, run: () => undefined }} />);

  it("is a press that shows the folder, with no save line as with one, 24px to hit and nothing moved", () => {
    const shown: string[] = [];
    head(null, () => void shown.push("Events"));
    const link = screen.getByRole("button", { name: "Events" });
    expect(link.parentElement!.textContent).toBe("In Events");
    expect(link.className.split(" ")).toEqual(expect.arrayContaining(["relative", "after:absolute", "after:-top-0.5", "after:-bottom-1.5"]));
    // The line's clip has room for the press, and takes it back.
    expect(link.parentElement!.className.split(" ")).toEqual(expect.arrayContaining(["-mt-0.5", "pt-0.5", "-mb-1.5", "pb-1.5"]));
    fireEvent.click(link);
    expect(shown).toEqual(["Events"]);
    cleanup();
    head({ state: "saved", at: Date.now() }, () => undefined);
    const saved = screen.getByRole("button", { name: "Events" });
    expect(saved.hasAttribute("data-files-folder-link")).toBe(true);
    expect(saved.closest("[data-files-save-line]")!.className).toContain("pb-1.5");
  });

  it("stays words where nothing can show the folder", () => {
    head(null);
    expect(screen.queryByRole("button", { name: "Events" })).toBeNull();
    expect(screen.getByText("In Events").className).not.toContain("pb-1.5");
  });
});

describe("a file tab's ⋯", () => {
  it("ends with Full Window and Close Tab; a Word file's own save choice stands with the other saves above them", async () => {
    const { fileMenuEnd } = await import("./FileTabView");
    const ids = (rows: ReturnType<typeof fileMenuEnd>): string[] => rows.map((r) => (r.kind === "item" ? r.id : r.kind));
    expect(ids(fileMenuEnd({ download: true, saveAs: false, template: false, wordAuto: false, full: false }))).toEqual(["sep", "download", "word-auto", "sep", "full", "close"]);
    expect(ids(fileMenuEnd({ download: false, saveAs: false, template: false, wordAuto: null, full: false }))).toEqual(["sep", "full", "close"]);
    const word = fileMenuEnd({ download: false, saveAs: true, template: false, wordAuto: true, full: false }).find((r) => r.kind === "item" && r.id === "word-auto");
    expect(word && word.kind === "item" ? word.label : null).toBe("Ask Before Saving to Word");
  });
});

/** The owner: "Breadcrumbs should still show on an open file so you can easily go back." */
describe("an open file's trail", () => {
  const events = { at: { at: "file" as const, host: "env_box", path: "/w/Events" }, name: "Events" };
  const steps = [{ name: "Dummy Esports", at: { at: "place" as const, id: "folder" } }, { name: "Events", at: events.at }];
  const drawTrail = (onGo: (page: { at: unknown; name: string }) => void) =>
    render(
      <FileHeader
        name="Run of show.docx"
        line={{ state: "saved", at: Date.now() - 60_000 }}
        where="Events"
        trail={{ steps, onGo }}
        running={null}
        onRun={() => undefined}
        onShowFolder={() => undefined}
        rows={[]}
        onPick={() => undefined}
        ask={{ disabled: false, pressed: false, run: () => undefined }}
      />,
    );

  it("names the folders before the file's name, each a press back to its folder; the name is the trail's end", () => {
    const onGo = vi.fn();
    drawTrail(onGo);
    const nav = screen.getByRole("navigation", { name: "File" });
    expect(within(nav).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Dummy Esports", "Events", "Run of show.docx"]);
    // The name is the heading at the end, no press to a folder.
    const end = nav.querySelector<HTMLElement>("[data-trail-step=file]")!;
    expect(within(end).getByRole("heading").textContent).toBe("Run of show.docx");
    expect(within(end).queryByRole("button")).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: "Events" }));
    expect(onGo).toHaveBeenCalledWith({ at: events.at, name: "Events" });
    // The trail names the folder, so the save line does not again.
    expect(document.querySelector("[data-files-save-line]")!.textContent).not.toContain("Events");
  });

  it("never wraps: under 520px of room the folder that holds the file stays beside it, the steps above it give way", () => {
    drawTrail(() => undefined);
    const nav = screen.getByRole("navigation", { name: "File" });
    expect(nav.querySelector("ol")!.className.split(" ")).toContain("flex-nowrap");
    const [above, holder, file] = [...nav.querySelectorAll<HTMLElement>("[data-trail-step]")];
    expect(above!.getAttribute("data-trail-step")).toBe("above");
    expect(above!.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "@[520px]/files-bar:flex"]));
    expect(holder!.getAttribute("data-trail-step")).toBe("holder");
    expect(holder!.className.split(" ")).not.toContain("hidden");
    expect(holder!.className.split(" ")).toEqual(expect.arrayContaining(["overflow-hidden", "min-w-9"]));
    // The file's name never shrinks; it leaves the folder that holds it its least room at any width.
    expect(file!.className.split(" ")).toEqual(expect.arrayContaining(["shrink-0", "max-w-[calc(100%-var(--trail-holder))]"]));
    expect(file!.style.getPropertyValue("--trail-holder")).toBe("38px");
    // The chevron before the name always shows; the holder's own shows only once a step stands before it.
    expect(file!.querySelector("[data-slot=breadcrumb-separator]")!.className.split(" ")).not.toContain("hidden");
    expect(holder!.querySelector("[data-slot=breadcrumb-separator]")!.className.split(" ")).toContain("hidden");
  });

  it("keeps the line's folder where no trail is known", () => {
    render(<FileHeader name="Notes.md" line={null} where="Events" trail={{ steps: [], onGo: () => undefined }} running={null} onRun={() => undefined} rows={[]} onPick={() => undefined} ask={{ disabled: false, pressed: false, run: () => undefined }} />);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByText("In Events")).toBeTruthy();
  });
});
