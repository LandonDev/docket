// @vitest-environment jsdom
/**
 * A squeezed tab is its glyph alone (docs/DESIGN.md "Spacing"): under the room of one letter and its ellipsis the
 * name gives way whole, by a container query on its own box, while it stays the tab's name; an unseen copy gives the
 * tab its width. jsdom draws no layout, so the classes that do it are held here; the pictures show it drawn.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TabName } from "./TabName";

afterEach(cleanup);

describe("a tab's name", () => {
  it("gives way whole under the room of a letter and its ellipsis, and stays the tab's name", () => {
    render(
      <button role="tab">
        <TabName name="Ballroom contract.pdf" titleRef={() => undefined} />
      </button>,
    );
    const name = screen.getByText("Ballroom contract.pdf");
    expect(name.className.split(" ")).toEqual(expect.arrayContaining(["truncate", "@max-[1.25rem]/tab-name:sr-only"]));
    expect(name.parentElement!.className.split(" ")).toContain("@container/tab-name");
    // The copy that sizes the tab is a ::before, so the name is in the page once and is the tab's name.
    const box = name.parentElement!.parentElement!;
    expect(box.getAttribute("data-tab-name")).toBe("Ballroom contract.pdf");
    expect(box.className).toContain("before:content-[attr(data-tab-name)]");
    expect(box.className).toContain("before:invisible");
    expect(screen.getByRole("tab", { name: "Ballroom contract.pdf" })).toBeTruthy();
  });
});

describe("a tab's name among tabs that share a start", () => {
  it("is cut in its middle: the start gives way first and the end that differs stays", () => {
    render(
      <button role="tab">
        <TabName name="Purdue Esports Budget.xlsx" keep={15} titleRef={() => undefined} />
      </button>,
    );
    // Still one name to a reader, and in the tip.
    const tab = screen.getByRole("tab", { name: "Purdue Esports Budget.xlsx" });
    const end = screen.getByText("Budget.xlsx");
    const start = end.previousElementSibling as HTMLElement;
    expect(start.textContent).toBe("Purdue Esports\u00a0");
    expect(start.className.split(" ")).toEqual(expect.arrayContaining(["truncate", "min-w-[1.5em]"]));
    // The end never shrinks: it is cut only where it alone is wider than the room less the start's ellipsis.
    expect(end.className.split(" ")).toEqual(expect.arrayContaining(["truncate", "shrink-0", "max-w-[calc(100%-1.5em)]"]));
    expect(end.parentElement!.className.split(" ")).toContain("@max-[1.25rem]/tab-name:sr-only");
    // In a tab too narrow for both, the end alone is drawn, never a sliver after the start's ellipsis: at the 128px
    // a tab gives way to (70px of name) the end is whole, never "T…Page…" (council R1-A5).
    expect(start.className.split(" ")).toContain("@max-[5.5rem]/tab-name:hidden");
    expect(end.className.split(" ")).toContain("@max-[5.5rem]/tab-name:max-w-full");
    expect(start.getAttribute("aria-hidden")).toBe("true");
    expect(end.getAttribute("aria-hidden")).toBe("true");
  });

  it("is cut at its end when nothing is shared", () => {
    render(
      <button role="tab">
        <TabName name="Events" keep={null} titleRef={() => undefined} />
      </button>,
    );
    expect(screen.getByText("Events").className.split(" ")).toContain("block");
  });
});

describe("a name cut where it differs", () => {
  it("keeps a lone long name's last word, and leaves a short or one-word name to its end's cut", async () => {
    const { lastWord } = await import("./TabName");
    expect(lastWord("TempCode proof Walk")).toBe("TempCode proof ".length);
    expect(lastWord("Dummy Esports")).toBeNull();
    expect(lastWord("Supercalifragilisticexpialidocious")).toBeNull();
  });

  it("cuts a tail too long for its room at its start, its words kept in order, and keeps the start its least room", async () => {
    const { MiddleCut } = await import("./TabName");
    const { container } = render(<MiddleCut text="General › TempCode proof archive 2027" keep={8} startRoom="4em" tail />);
    const [, start, end] = [...container.querySelector("[data-middle-cut]")!.children] as HTMLElement[];
    expect(start!.style.minWidth).toBe("4em");
    expect(end!.style.maxWidth).toBe("calc(100% - 4em)");
    expect(end!.getAttribute("dir")).toBe("rtl");
    expect(end!.querySelector("bdi")!.textContent).toBe("› TempCode proof archive 2027");
  });

  /** Polish 2 council round 1 (R1-C3): a cut place lost the space before its "›" ("Dummy Es…› Events"). */
  it("keeps the space an end starts with, unbreaking, so a cut start never runs into it", async () => {
    const { MiddleCut } = await import("./TabName");
    const { container } = render(<MiddleCut text="Dummy Esports › Events" keep={13} startRoom="4em" tail />);
    const [, start, end] = [...container.querySelector("[data-middle-cut]")!.children] as HTMLElement[];
    expect(start!.textContent).toBe("Dummy Esports");
    expect(end!.querySelector("bdi")!.textContent).toBe("\u00a0› Events");
  });
});
