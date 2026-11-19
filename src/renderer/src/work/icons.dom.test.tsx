import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ICON_STROKE } from "../chrome/icons";
import { Download, Export, Lifeos, TaskAdd } from "./icons";

afterEach(cleanup);

describe("Work's glyphs for a filed task, a task to make, a download and an export", () => {
  it("draws each at the chrome's one stroke, in currentColor, with no fill", () => {
    for (const Glyph of [Lifeos, TaskAdd, Download, Export]) {
      const { container } = render(<Glyph className="size-3.5" />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("fill"), Glyph.displayName).toBe("none");
      const marks = [...svg.children];
      expect(marks.length, Glyph.displayName).toBeGreaterThan(0);
      for (const mark of marks) {
        expect(mark.getAttribute("stroke"), Glyph.displayName).toBe("currentColor");
        expect(Number(mark.getAttribute("stroke-width")), Glyph.displayName).toBe(ICON_STROKE);
      }
      cleanup();
    }
  });

  it("draws LifeOS's mark as the prototype does: a ring, a meridian and two parallels", () => {
    const { container } = render(<Lifeos />);
    const svg = container.querySelector("svg")!;
    expect(svg.querySelector("circle")?.getAttribute("r")).toBe("9");
    expect(svg.querySelector("path")?.getAttribute("d")).toBe("M12 3v18M4.5 8.5c4 2.5 11 2.5 15 0M4.5 15.5c4-2.5 11-2.5 15 0");
  });
});
