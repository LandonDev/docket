// @vitest-environment jsdom
/** Work's one face, on the shared Avatar: every size's pixels, its initials at 11px medium, one letter under 24px, a given picture drawn as it is once it loads. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Face, type FaceSize } from "./face";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const face = (size: FaceSize, name = "Dana Lee", src?: string) => {
  const { container } = render(<Face name={name} size={size} src={src} />);
  return container.querySelector<HTMLElement>("[data-slot=avatar]")!;
};

describe("a face", () => {
  it("is the shared Avatar at each size's pixels, its initials 11px medium (the page's 13px), never 7, 8 or 9px", () => {
    const px: Record<FaceSize, string> = { line: "16", chip: "18", bar: "20", row: "24", head: "28", page: "40" };
    for (const size of Object.keys(px) as FaceSize[]) {
      const el = face(size);
      expect(el.getAttribute("data-size")).toBe(px[size]);
      expect(el.getAttribute("aria-hidden")).toBe("true");
      expect(el.classList).toContain(size === "page" ? "text-[13px]" : "text-[11px]");
      expect(el.classList).toContain("font-medium");
      expect(el.className).not.toMatch(/text-\[(7|8|9)px\]/);
      cleanup();
    }
  });

  it("holds Work's initials, one letter under 24px and two from 24px, an address read by its parts", () => {
    expect(face("bar").textContent).toBe("D");
    cleanup();
    expect(face("line").textContent).toBe("D");
    cleanup();
    expect(face("row").textContent).toBe("DL");
    cleanup();
    expect(face("row", "dana.lee@purdue.edu").textContent).toBe("DL");
  });

  it("draws a picture the page may show as it is, with no read of its bytes, once it has loaded", () => {
    // jsdom loads no image: a picture the browser has at once (decoded, `complete`) stands in for one.
    vi.stubGlobal(
      "Image",
      class {
        complete = true;
        naturalWidth = 1;
        src = "";
      },
    );
    const el = face("bar", "Dana Lee", "https://lh3.googleusercontent.com/a/dana");
    expect(el.querySelector("img")?.getAttribute("src")).toBe("https://lh3.googleusercontent.com/a/dana");
  });

  it("stands on its initials while a picture has not loaded, so a broken one never flashes", () => {
    const el = face("row", "Dana Lee", "https://example.invalid/dana.png");
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("DL");
  });
});
