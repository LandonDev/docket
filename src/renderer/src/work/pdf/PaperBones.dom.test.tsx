import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PaperBones } from "./PaperBones";

afterEach(cleanup);

describe("paper's bones", () => {
  it("lie on the paper's own ground, their sample set in a share of the sheet's width", () => {
    const { container } = render(<PaperBones shape="page" />);
    const region = container.querySelector<HTMLElement>("[data-region]")!;
    expect(region.getAttribute("data-bones-on")).toBe("paper");
    expect(region.className).toContain("@container");
    expect(container.querySelector("[skullet-loading] [data-paper-bones='page'] p")?.className).toMatch(/cqw/);
  });

  it("centre a slide's title by its top inset, from the slide's own proportion", () => {
    const inset = (aspect?: number) => {
      const { container, unmount } = render(aspect ? <PaperBones shape="slide" aspect={aspect} /> : <PaperBones shape="slide" />);
      const top = parseFloat(container.querySelector<HTMLElement>("[data-paper-bones='slide']")!.style.paddingTop);
      unmount();
      return top;
    };
    // A 16:9 sheet is 56.25cqw tall; the words are 13.84cqw: (56.25 - 13.84) / 2.
    expect(inset()).toBeCloseTo(21.205, 2);
    expect(inset(4 / 3)).toBeCloseTo((75 - 13.84) / 2, 2);
    // A sheet shorter than its words starts at the top.
    expect(inset(10)).toBe(0);
  });
});
