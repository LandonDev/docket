import { describe, expect, it } from "vitest";
import { VIDEO_FIXED_SIZES } from "@server/shared/contract-video";
import { guestSizeAsk } from "./guestSize";

const room = { width: 1123.5, height: 740 };

describe("the place's guest size ask", () => {
  it("keeps the CSS room and takes the device scale from the element's own window", () => {
    const element = { ownerDocument: { defaultView: { devicePixelRatio: 1.75 } } } as Element;
    expect(guestSizeAsk(room, element)).toEqual({ ...room, mode: "fit", scale: 1.75, detail: "sharp" });
    expect(guestSizeAsk({ ...room, height: 0 }, element)).toBeNull();
  });

  it("takes a supported fixed size in guest pixels and requires a size in fixed mode", () => {
    for (const fixed of VIDEO_FIXED_SIZES) {
      expect(guestSizeAsk(room, null, { mode: "fixed", fixed, detail: "faster" })).toEqual({ ...fixed, mode: "fixed", detail: "faster" });
    }
    expect(guestSizeAsk(room, null, { mode: "fixed", detail: "sharp" })).toBeNull();
    expect(guestSizeAsk(room, null, { mode: "fixed", fixed: room, detail: "sharp" })).toBeNull();
  });
});
