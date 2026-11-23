// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ENTRY_KINDS } from "@shared/work/files";
import { KIND_ICON, KIND_TINT, KindGlyph } from "./KindGlyph";

afterEach(cleanup);

const classOf = (node: Element | null): string[] => (node?.getAttribute("class") ?? "").split(/\s+/);
const kindClasses = (classes: string[]): string[] => classes.filter((c) => c.startsWith("text-kind-"));

describe("KindGlyph", () => {
  it("has a glyph and a tint for every kind", () => {
    for (const kind of ENTRY_KINDS) {
      expect(KIND_ICON[kind], kind).toBeDefined();
      expect(KIND_TINT[kind], kind).toMatch(/^text-/);
    }
    expect(Object.keys(KIND_ICON).sort()).toEqual([...ENTRY_KINDS].sort());
    expect(Object.keys(KIND_TINT).sort()).toEqual([...ENTRY_KINDS].sort());
  });

  it("draws one hidden svg for every kind, 16px by default", () => {
    for (const kind of ENTRY_KINDS) {
      const { container } = render(<KindGlyph kind={kind} />);
      const svgs = container.querySelectorAll("svg");
      expect(svgs.length, kind).toBe(1);
      expect(svgs[0].getAttribute("aria-hidden"), kind).toBe("true");
      expect(classOf(svgs[0]), kind).toEqual(expect.arrayContaining(["size-4", "shrink-0"]));
      cleanup();
    }
  });

  it("tints a document in its kind's colour", () => {
    const classes = classOf(render(<KindGlyph kind="document" />).container.querySelector("svg"));
    expect(classes).toContain("text-kind-doc");
    expect(classes).not.toContain("text-muted-foreground");
  });

  it("draws muted with no kind colour when untinted, as a canvas tab row does", () => {
    for (const kind of ENTRY_KINDS) {
      const classes = classOf(render(<KindGlyph kind={kind} tinted={false} />).container.querySelector("svg"));
      expect(classes, kind).toContain("text-muted-foreground");
      expect(kindClasses(classes), kind).toEqual([]);
      cleanup();
    }
  });

  it("keeps archive and other muted even when tinted", () => {
    for (const kind of ["archive", "other"] as const) {
      const classes = classOf(render(<KindGlyph kind={kind} />).container.querySelector("svg"));
      expect(classes, kind).toContain("text-muted-foreground");
      expect(kindClasses(classes), kind).toEqual([]);
      cleanup();
    }
  });

  it("takes its size from className", () => {
    const classes = classOf(render(<KindGlyph kind="pdf" className="size-3.5" />).container.querySelector("svg"));
    expect(classes).toContain("size-3.5");
    expect(classes).not.toContain("size-4");
    expect(classes).toContain("text-kind-pdf");
  });
});
