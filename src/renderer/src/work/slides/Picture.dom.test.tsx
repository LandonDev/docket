// @vitest-environment jsdom
/**
 * A slide's picture while its page comes: a thumbnail shows the slide's title in its box, so the strip never stands
 * as blank boxes beside a drawn stage; the stage waits on paper with a slide's bones, in the box the picture fills.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PdfDoc } from "../pdf/engine";
import { Picture } from "./Picture";

const waiting = { size: () => ({ width: 720, height: 405 }), paint: () => new Promise<void>(() => undefined), release: () => undefined } as unknown as PdfDoc;

afterEach(cleanup);

describe("a slide's picture", () => {
  it("shows a thumbnail's title until its page paints, and the stage's bones meanwhile, with no words", () => {
    const { container, rerender } = render(<Picture doc={waiting} page={1} width={112} title="Who comes" thumb waitTitle />);
    expect(container.textContent).toBe("Who comes");
    expect(container.querySelector("[data-paper-bones]")).toBeNull();
    rerender(<Picture doc={waiting} page={1} width={640} title="Who comes" />);
    // The bones' sample words sit in their unseen drawing alone (`[skullet-loading]`, aria-hidden): no word is shown.
    const drawing = container.querySelector("[skullet-loading]");
    expect(drawing?.closest("[aria-hidden=true]")).not.toBeNull();
    expect(container.textContent).toBe(drawing?.textContent);
    expect(container.querySelector("[data-paper-bones='slide']")).not.toBeNull();
    // The Sorter's tile has its label under it: no second title inside.
    rerender(<Picture doc={waiting} page={1} width={160} title="Who comes" thumb first />);
    expect(container.textContent).toBe("");
  });

  it("draws the bones in the box the slide fills, and lets them go once it paints: nothing moves", async () => {
    let painted = (): void => undefined;
    const doc = { ...waiting, paint: () => new Promise<void>((done) => (painted = done)) } as unknown as PdfDoc;
    const { container } = render(<Picture doc={doc} page={1} width={640} title="Who comes" />);
    const box = container.firstElementChild as HTMLElement;
    // 720 by 405 points at 640px wide: 360px tall, the same box before and after the paint.
    expect(box.style.width).toBe("640px");
    expect(box.style.height).toBe("360px");
    const waitingOn = box.querySelector("[data-slide-waiting]")!;
    expect(waitingOn.className).toContain("absolute inset-0");
    await act(async () => painted());
    expect(box.querySelector("[data-slide-waiting]")).toBeNull();
    expect(box.style.height).toBe("360px");
  });
});
