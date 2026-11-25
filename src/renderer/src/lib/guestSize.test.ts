import { describe, expect, it } from "vitest";
import { VIDEO_FIXED_SIZES } from "@server/shared/contract-video";
import { guestSizeAsk, guestSizeSettingOf } from "./guestSize";

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

describe("the host's Size and Detail as the viewer's setting", () => {
  it("is Fit or a fixed size, Sharp or Faster, as the keeper says it (Faster changed nothing on his Mac until it was passed on)", () => {
    expect(guestSizeSettingOf({ screen: "fit", detail: "faster" })).toEqual({ mode: "fit", detail: "faster" });
    expect(guestSizeSettingOf({ screen: "2560x1600", detail: "sharp" })).toEqual({ mode: "fixed", fixed: { width: 2560, height: 1600 }, detail: "sharp" });
    expect(guestSizeSettingOf(null)).toBeUndefined();
    expect(guestSizeAsk({ width: 1023, height: 819 }, null, guestSizeSettingOf({ screen: "fit", detail: "faster" }))).toMatchObject({ mode: "fit", detail: "faster" });
  });
});
