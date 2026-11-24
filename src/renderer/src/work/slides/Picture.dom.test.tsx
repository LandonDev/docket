// @vitest-environment jsdom
/**
 * A slide's picture while its page comes: a thumbnail shows the slide's title in its box, so the strip never stands
 * as blank boxes beside a drawn stage; the stage itself stays a quiet blank until it paints.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PdfDoc } from "../pdf/engine";
import { Picture } from "./Picture";

const waiting = { size: () => ({ width: 720, height: 405 }), paint: () => new Promise<void>(() => undefined), release: () => undefined } as unknown as PdfDoc;

afterEach(cleanup);

describe("a slide's picture", () => {
  it("shows a thumbnail's title until its page paints, and leaves the stage blank meanwhile", () => {
    const { container, rerender } = render(<Picture doc={waiting} page={1} width={112} title="Who comes" thumb waitTitle />);
    expect(container.textContent).toBe("Who comes");
    rerender(<Picture doc={waiting} page={1} width={640} title="Who comes" />);
    expect(container.textContent).toBe("");
    // The Sorter's tile has its label under it: no second title inside.
    rerender(<Picture doc={waiting} page={1} width={160} title="Who comes" thumb first />);
    expect(container.textContent).toBe("");
  });
});
