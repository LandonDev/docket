import { describe, expect, it } from "vitest";
import { FILES_PANE_PREFIX } from "@shared/work/canvas";
import { SLIDE_IMPORT_EXTS } from "@shared/work/slideFormats";
import { slidesCanvas } from "./canvas";
import { FILES_PANE } from "./slideFileActions";

/**
 * Two things the deck's window says for itself, so that its first-paint row and its chunk take no value from a
 * shared module with zod in it (pdf/firstPaint.test.ts): held here to the names they copy.
 */
describe("what the deck's window says in place of an import", () => {
  it("opens every format the host converts, and .pptx", () => {
    expect(slidesCanvas.opens?.ext).toEqual(["pptx", ...SLIDE_IMPORT_EXTS]);
  });

  it("knows a Files tab's owner by the prefix the frame gives it", () => {
    expect(FILES_PANE).toBe(FILES_PANE_PREFIX);
  });
});
