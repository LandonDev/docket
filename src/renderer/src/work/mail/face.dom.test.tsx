// @vitest-environment jsdom
/** Work's one face: every size's initials at 11px medium, one letter under 24px, a given picture drawn as it is. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Face, type FaceSize } from "./face";

afterEach(cleanup);

const face = (size: FaceSize, name = "Dana Lee", src?: string) => {
  const { container } = render(<Face name={name} size={size} src={src} />);
  return container.querySelector<HTMLElement>("[data-face]")!;
};

describe("a face", () => {
  it("draws its initials 11px medium at every list size, never 7, 8 or 9px", () => {
    for (const size of ["line", "chip", "bar", "row", "head"] as const) {
      const el = face(size);
      expect(el.getAttribute("data-face")).toBe(size);
      expect(el.className).toContain("text-[11px] font-medium");
      expect(el.className).not.toMatch(/text-\[(7|8|9)px\]/);
      cleanup();
    }
  });

  it("holds one letter under 24px and two from 24px", () => {
    expect(face("bar").textContent).toBe("D");
    cleanup();
    expect(face("line").textContent).toBe("D");
    cleanup();
    expect(face("row").textContent).toBe("DL");
  });

  it("draws a picture the page may show as it is, with no read of its bytes", () => {
    const el = face("bar", "Dana Lee", "https://lh3.googleusercontent.com/a/dana");
    expect(el.querySelector("img")?.getAttribute("src")).toBe("https://lh3.googleusercontent.com/a/dana");
  });
});
