// @vitest-environment jsdom
/**
 * What the window keeps over a long day is bounded (the Work performance pass, M12): face pictures by count with
 * their blobs let go, thumbnails by count and by characters, history's compares by count. Each keeps what a screen
 * shows now.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FACES_KEPT, facesKept, keepFaceForTests } from "./mail/face";
import { forgetPictures, keepThumbForTests, THUMBS_CHARS, THUMBS_KEPT, thumbCharsKept } from "./files/previews";
import { COMPARES_KEPT, comparesKept, putForTests } from "./history/store";

afterEach(() => {
  forgetPictures();
  vi.restoreAllMocks();
});

describe("face pictures", () => {
  it("keeps at most FACES_KEPT, and lets go of each dropped blob", () => {
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    for (let i = 0; i < 1000; i++) keepFaceForTests(`lifeos://face/${i}`, `blob:face-${i}`);
    expect(FACES_KEPT).toBe(120);
    expect(facesKept()).toBe(120);
    expect(revoke).toHaveBeenCalledTimes(880);
    expect(revoke).toHaveBeenCalledWith("blob:face-0");
    expect(revoke).not.toHaveBeenCalledWith("blob:face-999");
  });
});

describe("thumbnails", () => {
  it("are held under THUMBS_CHARS characters as well as THUMBS_KEPT pictures", () => {
    const big = "x".repeat(1_000_000);
    for (let i = 0; i < 40; i++) keepThumbForTests(`t${i}`, big);
    expect(thumbCharsKept()).toBeLessThanOrEqual(THUMBS_CHARS);
    expect(thumbCharsKept()).toBe(16_000_000);
    forgetPictures();
    for (let i = 0; i < THUMBS_KEPT + 50; i++) keepThumbForTests(`s${i}`, "data:,");
    expect(thumbCharsKept()).toBe(THUMBS_KEPT * 6);
  });
});

describe("history's compares", () => {
  it("keeps at most COMPARES_KEPT compares no screen shows", () => {
    for (let i = 0; i < 100; i++) putForTests(`box\u0000{"at":"file"}\u0000compare|v${i}|live`, { blocks: [] });
    expect(COMPARES_KEPT).toBe(20);
    expect(comparesKept()).toBe(20);
  });
});
