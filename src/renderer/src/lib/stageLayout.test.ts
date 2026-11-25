import { describe, expect, it } from "vitest";
import { STAGE_GAP, STAGE_INSET, STRIP_MAX, STRIP_MIN, drawnPixelated, fitStage, pictureKind, roomKnown, stageLayout, stageOf } from "./stageLayout";


describe("the Computers page's stage", () => {
  it("fits a picture only to a room that is measured: before that the picture takes the page's width, never a sliver", () => {
    expect(roomKnown(stageLayout({ width: 0, height: 0 }, 1).room)).toBe(false);
    expect(roomKnown(stageLayout({ width: 420, height: 0 }, 1).room)).toBe(false);
    expect(roomKnown(stageLayout({ width: 420, height: 700 }, 1).room)).toBe(true);
  });

  it("gives one computer the page less its inset, both ways: the header is its bar, so no caption takes a share", () => {
    expect(stageLayout({ width: 1200, height: 860 }, 1)).toEqual({ room: { width: 1200 - STAGE_INSET * 2, height: 860 - STAGE_INSET * 2 }, strip: "none", stripWidth: 0 });
    expect(stageLayout({ width: 1800, height: 860 }, 3).room.height).toBe(860 - STAGE_INSET * 2);
  });

  it("puts the others in a strip beside it, 176 to 240 wide, and under it on a page narrower than 640", () => {
    const wide = stageLayout({ width: 1800, height: 900 }, 3);
    expect(wide).toMatchObject({ strip: "side", stripWidth: STRIP_MAX });
    expect(wide.room.width).toBe(1800 - STAGE_INSET * 2 - STRIP_MAX - STAGE_GAP);
    expect(stageLayout({ width: 700, height: 900 }, 2)).toMatchObject({ strip: "side", stripWidth: STRIP_MIN });
    expect(stageLayout({ width: 1100, height: 900 }, 2).stripWidth).toBe(Math.round((1100 - STAGE_INSET * 2) * 0.18));
    const narrow = stageLayout({ width: 600, height: 900 }, 2);
    expect(narrow).toMatchObject({ strip: "below", room: { width: 600 - STAGE_INSET * 2 } });
  });

  it("never asks for room it does not have", () => {
    expect(stageLayout({ width: 10, height: 10 }, 2).room).toEqual({ width: 0, height: 0 });
  });

  it("fits the picture in its shape, to whichever of the room's sides is tighter", () => {
    // a 1440×900 window: the stage is about 1150 by 720 alone
    const room = stageLayout({ width: 1440 - 240, height: 900 - 40 }, 1).room;
    const alone = fitStage(room, { width: 2560, height: 1600 }, 2);
    expect(alone.width / alone.height).toBeCloseTo(1.6, 2);
    expect(alone.height).toBeLessThanOrEqual(room.height);
    expect(fitStage({ width: 2000, height: 500 }, { width: 3840, height: 2400 }, 2)).toEqual({ width: 800, height: 500 });
    expect(fitStage({ width: 600, height: 2000 }, { width: 3840, height: 2400 }, 2)).toEqual({ width: 600, height: 375 });
  });

  it("never draws a picture past twice its own pixels, and takes 16:10 before its frame is known", () => {
    // the box's 1280×800 page on a 2× screen is 640 points: at most 1280 on the stage
    expect(fitStage({ width: 2000, height: 1500 }, { width: 1280, height: 800 }, 2)).toEqual({ width: 1280, height: 800 });
    // a small window stays small
    expect(fitStage({ width: 2000, height: 1500 }, { width: 400, height: 300 }, 2)).toEqual({ width: 400, height: 300 });
    expect(fitStage({ width: 800, height: 800 }, null, 2)).toEqual({ width: 800, height: 500 });
  });

  it("draws a picture grown past its pixels at a whole scale when that costs at most a fifth of its width", () => {
    const vm = { width: 1280, height: 800 };
    // 1x screen, room 1400 wide: 1280, one to one, not 1400 and soft
    expect(fitStage({ width: 1400, height: 1000 }, vm, 1)).toEqual({ width: 1280, height: 800 });
    // 1.3 times would lose more than a fifth at 1: the largest fit stays
    expect(fitStage({ width: 1664, height: 1200 }, vm, 1)).toEqual({ width: 1664, height: 1040 });
    // 2x screen, room 1150 wide: 1.8 device pixels a pixel would lose too much at 1; 2 is past the room
    expect(fitStage({ width: 1150, height: 1000 }, vm, 2)).toEqual({ width: 1150, height: 718 });
    // shrunk, it is never snapped
    expect(fitStage({ width: 1000, height: 1000 }, vm, 1)).toEqual({ width: 1000, height: 625 });
    // the 1920 by 1200 VM on a 1x screen 2000 wide: one to one
    expect(fitStage({ width: 2000, height: 1300 }, { width: 1920, height: 1200 }, 1)).toEqual({ width: 1920, height: 1200 });
  });

  it("fills the room with a whole computer's screen in its shape, with no cap and no snap", () => {
    const vm = { width: 1280, height: 800 };
    expect(pictureKind("vm:windows")).toBe("screen");
    expect(pictureKind("browser:p1")).toBe("window");
    expect(pictureKind("window:t1")).toBe("window");
    // full screen on the ASUS (3200×1800 points, 2x): the display's full height, 90% of its width
    expect(fitStage({ width: 3200, height: 1800 }, vm, 2, "screen")).toEqual({ width: 2880, height: 1800 });
    // the MacBook (1728×1117 points, 2x): its full width
    expect(fitStage({ width: 1728, height: 1117 }, vm, 2, "screen")).toEqual({ width: 1728, height: 1080 });
    // the LG (3840×1620 points): its full height
    expect(fitStage({ width: 3840, height: 1620 }, vm, 2, "screen")).toEqual({ width: 2592, height: 1620 });
    // the same rooms hold a window's picture of that size to twice its pixels, as before
    expect(fitStage({ width: 3200, height: 1800 }, vm, 2)).toEqual({ width: 1280, height: 800 });
    expect(fitStage({ width: 1728, height: 1117 }, vm, 2)).toEqual({ width: 1280, height: 800 });
    expect(fitStage({ width: 3840, height: 1620 }, vm, 2)).toEqual({ width: 1280, height: 800 });
    // a screen on a 1x display is not snapped down to one to one either: 1400 wide, not 1280
    expect(fitStage({ width: 1400, height: 1000 }, vm, 1, "screen")).toEqual({ width: 1400, height: 875 });
    expect(fitStage({ width: 800, height: 800 }, null, 2, "screen")).toEqual({ width: 800, height: 500 });
  });

  it("draws pixelated only at a whole scale of two or more screen pixels to each of the stream's", () => {
    const vm = { width: 1280, height: 800 };
    // a window's picture at its cap on a 2x display: 2:1
    expect(drawnPixelated(1280, vm, 2)).toBe(true);
    // 3:1: 1920 points of a 1280 stream on a 2x display is 3 device pixels to each
    expect(drawnPixelated(1920, { width: 1280, height: 800 }, 2)).toBe(true);
    // the screens of full screen: 4.5:1 on the ASUS, 2.7:1 on the MacBook, 4.05:1 on the LG, smooth
    expect(drawnPixelated(2880, vm, 2)).toBe(false);
    expect(drawnPixelated(1728, vm, 2)).toBe(false);
    expect(drawnPixelated(2592, vm, 2)).toBe(false);
    // one to one is the stream's own pixels: nothing to double
    expect(drawnPixelated(640, vm, 2)).toBe(false);
    expect(drawnPixelated(1280, vm, 1)).toBe(false);
    // a width floored to a CSS pixel still counts as whole
    expect(drawnPixelated(1279.6, vm, 2)).toBe(true);
    expect(drawnPixelated(1200, vm, 2)).toBe(false);
    expect(drawnPixelated(1280, null, 2)).toBe(false);
  });

  it("keeps his pick while it is there, then what had the stage, then the one that needs him, then the one that acted last", () => {
    const tiles = [
      { key: "a", asking: false, lastCallAt: 3 },
      { key: "b", asking: false, lastCallAt: 9 },
      { key: "c", asking: true, lastCallAt: 1 },
    ];
    expect(stageOf(tiles, "a", "b")).toBe("a");
    expect(stageOf(tiles, "gone", "b")).toBe("b");
    expect(stageOf(tiles, null, null)).toBe("c");
    expect(stageOf(tiles.slice(0, 2), null, "gone")).toBe("b");
    expect(stageOf([], null, null)).toBeNull();
  });
});
