// @vitest-environment jsdom
/**
 * What waits in Excel, on the sheet's bar (excelWaits.tsx): the words for each count and each place the switch
 * goes, and the one line drawn in the bar's own type, with the whole of it in a tip only while it is cut.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "../../components/ui/tooltip";
import { ExcelWaits, waitsWords } from "./excelWaits";

afterEach(cleanup);

describe("the words", () => {
  it("says many as open and one as opens, starting as a sentence does", () => {
    expect(waitsWords({ parts: ["2 pivot tables", "macros"], to: "excel" }, "package")).toBe("2 pivot tables and macros open in Excel");
    expect(waitsWords({ parts: ["a pivot table"], to: "excel" }, "package")).toBe("A pivot table opens in Excel");
    expect(waitsWords({ parts: ["Power Query"], to: "excel" }, "package")).toBe("Power Query opens in Excel");
    expect(waitsWords({ parts: ["macros"], to: "excel" }, "package")).toBe("Macros open in Excel");
    expect(waitsWords({ parts: ["links to 3 other workbooks"], to: "excel" }, "package")).toBe("Links to 3 other workbooks open in Excel");
    expect(waitsWords({ parts: ["a pivot table", "a chart"], to: "excel" }, "package")).toBe("A pivot table and a chart open in Excel");
    expect(waitsWords({ parts: ["2 pivot tables", "12 charts", "macros", "a slicer"], to: "excel" }, "package")).toBe("2 pivot tables, 12 charts, macros and a slicer open in Excel");
  });

  it("names the full editor where the switch goes there", () => {
    expect(waitsWords({ parts: ["2 pivot tables"], to: "full" }, "package")).toBe("2 pivot tables open in the full editor");
  });

  it("says nothing with nothing counted, and nothing for a workbook Excel or Google holds", () => {
    expect(waitsWords(undefined, "package")).toBeNull();
    // A file that could not be opened here has the switch and no count: the state line says why.
    expect(waitsWords({ parts: [], to: "excel" }, "package")).toBeNull();
    expect(waitsWords({ parts: ["formatting", "inserting rows and columns"], to: "google" }, "package")).toBeNull();
    for (const store of ["lifeos", "tcsheet", "csv", undefined] as const) expect(waitsWords({ parts: ["formatting"], to: "excel" }, store)).toBeNull();
  });
});

describe("the bar's line", () => {
  const draw = (parts: string[]) =>
    render(
      <TooltipProvider>
        <ExcelWaits reach={{ parts, to: "excel" }} store="package" />
      </TooltipProvider>,
    );

  it("is one line of the bar's own text at the end of the tools, that truncates, with no chip, no glyph and no title", () => {
    const { container } = draw(["2 pivot tables", "macros"]);
    const line = container.querySelector("[data-sheet-waits]")!;
    expect(line.textContent).toBe("2 pivot tables and macros open in Excel");
    // `ms-auto`: at the tools' end, under the switch; no size or colour of its own, so the bar's 12px muted text.
    expect(line.className).toBe("ms-auto min-w-0 truncate");
    expect(line.getAttribute("title")).toBeNull();
    expect(container.querySelectorAll("svg, [data-slot='badge']")).toHaveLength(0);
    expect(container.children).toHaveLength(1);
  });

  it("draws nothing where there is nothing to say", () => {
    expect(draw([]).container.innerHTML).toBe("");
  });
});
