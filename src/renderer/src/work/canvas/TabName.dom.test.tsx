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
