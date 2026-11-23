// @vitest-environment jsdom
/**
 * The deck's Preview in the window: the rows each format shows in the frame's column (and none that would change
 * nothing), the ways in (Export… in More, File → Export… and Print…, the Present menu's Preview), and the deck kept
 * mounted and out of reach under it.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeckOut, DeckReach } from "@shared/contract-work-slides";
import { openMenus } from "../../../chrome/menuRows";
import { workCommands } from "../../../lib/appCommands";
import type { CanvasShell, MoreEntry } from "../../canvas/kind";
import { Preview } from "../../formats/PreviewFrame";
import { fakeDoc, fakeEngine } from "../../pdf/testkit";
import { deckStoreOf } from "../deck";
import { PresentButton } from "../Present";
import { deckView } from "../testkit";
import { askPreview, PreviewOpener } from "./ask";
import { DeckPreviewLayer, deckRows, defaultOptions } from "./DeckPreview";
import { deckPreviewSource, type DeckOptions } from "./source";

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const facts = { slides: 12, hidden: 1, notes: 0, animated: 0, transitions: 0, videos: 0, sounds: 0, pending: 0 };
async function request<T>(_env: string, method: string, params: unknown): Promise<T> {
  const p = params as { format?: string; rev?: string };
  if (method === "work.slides.reach") return { pdf: "none", video: "none" } as T;
  if (method === "work.slides.previewRead") return { data: btoa(String.fromCharCode(...PDF)) } as T;
  const rev = (p.format ?? "x").padEnd(32, "0");
  const out: DeckOut =
    p.format === "pics"
      ? { file: { rev, size: 3, name: "Talk.zip" }, thumbs: [{ name: "Slide 01.png", thumb: "data:image/png;base64,AA" }], drawnBy: "tempcode", facts }
      : p.format === "video"
        ? { file: { rev, size: 3, name: "Talk.mp4" }, video: { seconds: 60, poster: "data:image/png;base64,AA", height: 1080 }, drawnBy: "tempcode", facts }
        : { file: { rev, size: PDF.length, name: "Talk.pdf" }, pdf: { rev, size: PDF.length, pages: 2 }, drawnBy: "tempcode", facts };
  return out as T;
}
const engine = () => fakeEngine(() => fakeDoc([{ size: { width: 720, height: 405 }, runs: [] }, { size: { width: 720, height: 405 }, runs: [] }]));

function framed(reach: DeckReach = { pdf: "none", video: "none" }, hidden = 1) {
  function Held() {
    const [options, setOptions] = useState<DeckOptions>(defaultOptions("en-US"));
    const set = (next: Partial<DeckOptions>): void => setOptions((o) => ({ ...o, ...next }));
    const source = useMemo(() => deckPreviewSource({ env: "e", itemId: "i", options, setOptions: set, reach: async () => reach, request }), [options]);
    return <Preview source={source} title="Talk" kind="deck" onClose={() => {}} engine={engine()} width={1200} height={700} tight={false} rowsFor={(f) => deckRows(f, { options, set, hidden, aspect: 16 / 9, reach })} />;
  }
  return render(<Held />);
}

const column = (): HTMLElement => document.querySelector<HTMLElement>("[data-preview-column]")!;
// A menu mounts lazily and the frame draws after a host call: under a loaded box either can pass a second, the library's own wait.
configure({ asyncUtilTimeout: 10_000 });

const pick = (label: string): void => void fireEvent.click(screen.getByRole("tab", { name: label }));

describe("the rows of each format", () => {
  it("a PDF has Layout and Hidden slides; Paper comes with paper, and the shared rows that do nothing for slides never show", async () => {
    framed();
    pick("PDF");
    // Drawn: the column stands beside the pages, where it stays.
    await screen.findByText("The file itself");
    const col = within(column());
    expect(col.getByText("Page")).toBeTruthy();
    expect(col.getByRole("button", { name: "Layout: Slides" })).toBeTruthy();
    expect(col.queryByText("Paper")).toBeNull();
    expect(col.queryByText("Orientation")).toBeNull();
    expect(col.queryByText("Margins")).toBeNull();
    expect(col.getByRole("switch", { name: "Hidden slides" })).toBeTruthy();
    await act(async () => fireEvent.click(col.getByRole("button", { name: "Layout: Slides" })));
    const six = await screen.findByRole("menuitemcheckbox", { name: "Handouts, 6 a page" });
    await act(async () => fireEvent.click(six));
    await waitFor(() => expect(within(column()).getByRole("button", { name: "Paper: Letter" })).toBeTruthy());
  });

  it("the file itself and the OpenDocument copy have no rows", async () => {
    framed();
    pick("PowerPoint");
    await waitFor(() => expect(document.querySelector('[data-preview="pptx"]')).toBeTruthy());
    expect(document.querySelector("[data-preview-page]")).toBeNull();
    expect(document.querySelector("[data-preview-own]")).toBeNull();
  });

  it("pictures have Type and Size, with no heading the bar already says; a video has Each slide and Quality, and PowerPoint only where it is in reach", async () => {
    framed();
    pick("Pictures");
    await waitFor(() => expect(document.querySelector("[data-preview-own]")).toBeTruthy());
    const own = within(document.querySelector<HTMLElement>("[data-preview-own]")!);
    expect(own.queryByText("Pictures")).toBeNull();
    expect(own.getByRole("button", { name: "Type: PNG" })).toBeTruthy();
    expect(own.getByRole("button", { name: "Size: 1,920 by 1,080" })).toBeTruthy();
    pick("Video");
    await waitFor(() => expect(within(document.querySelector<HTMLElement>("[data-preview-own]")!).getByRole("button", { name: "Each slide: 5 seconds" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Quality: 1080p" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Made by/ })).toBeNull();
    cleanup();
    localStorage.clear();
    framed({ pdf: "ready", video: "asleep" }, 0);
    pick("Video");
    await waitFor(() => expect(screen.getByRole("button", { name: "Made by: TempCode" })).toBeTruthy());
    // A deck with no hidden slides has no switch for them.
    expect(screen.queryByRole("switch", { name: "Hidden slides" })).toBeNull();
  });
});

describe("the ways in", () => {
  function layer(itemId: string) {
    deckStoreOf(itemId).view(deckView({ itemId }));
    const more: Array<MoreEntry[] | null> = [];
    const shell = { more: (entries: MoreEntry[] | null) => void more.push(entries) } as unknown as CanvasShell;
    // Pictures first, so no page needs drawing in jsdom.
    localStorage.setItem("work.preview.format.deck", "pics");
    render(
      <DeckPreviewLayer env="e" itemId={itemId} shell={shell} request={request}>
        <div data-slides>
          <button type="button">slide</button>
        </div>
      </DeckPreviewLayer>,
    );
    return { more };
  }

  it("Export… in More opens Preview over the deck, which stays mounted and out of reach; Escape goes back", async () => {
    const { more } = layer("deck-more");
    const entry = more.at(-1)!.find((e) => e.id === "export")!;
    expect(entry.label).toBe("Export…");
    act(() => void entry.run());
    await waitFor(() => expect(document.querySelector('[data-preview="pics"]')).toBeTruthy());
    expect(document.querySelector("[data-slides]")!.parentElement!.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(document.querySelector("[data-preview]")!, { key: "Escape" });
    expect(document.querySelector("[data-preview]")).toBeNull();
    expect(document.querySelector("[data-slides]")).toBeTruthy();
  });

  it("File → Print… opens it on Print, and the Present menu's Preview on the last format", async () => {
    layer("deck-cmd");
    expect(workCommands.has("print")).toBe(true);
    act(() => workCommands.run("print"));
    await waitFor(() => expect(document.querySelector('[data-preview="print"]')).toBeTruthy());
    fireEvent.keyDown(document.querySelector("[data-preview]")!, { key: "Escape" });
    act(() => askPreview("deck-cmd"));
    await waitFor(() => expect(document.querySelector('[data-preview="pics"]')).toBeTruthy());
  });

  it("Present's menu has Preview where a deck gives one, and not elsewhere", async () => {
    let opened = 0;
    render(
      <PreviewOpener.Provider value={() => void opened++}>
        <PresentButton native={null} onPresent={() => {}} />
      </PreviewOpener.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ways to present" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Preview" }));
    expect(opened).toBe(1);
    cleanup();
    render(<PresentButton native={null} onPresent={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Ways to present" }));
    await screen.findByRole("menuitem", { name: /From the start/ });
    expect(screen.queryByRole("menuitem", { name: "Preview" })).toBeNull();
  });
});
