import { VIDEO_FIXED_SIZES, type VideoDetail } from "@server/shared/contract-video";
import type { Room } from "@server/shared/video/guestSize";
import { pixelRatioOf } from "./video/support";

/** The host's choice, supplied by the place that drives. */
export interface GuestSizeSetting {
  mode: "fit" | "fixed";
  fixed?: Room;
  detail: VideoDetail;
}

export type GuestSizeAsk = Room & (
  | { mode: "fit"; scale: number; detail: VideoDetail }
  | { mode: "fixed"; detail: VideoDetail }
);

/** Fit sends the room in CSS points. The host applies guestSizeFor with its own caps. */
export function guestSizeAsk(
  room: Room,
  element: Element | null,
  { mode, fixed, detail }: GuestSizeSetting = { mode: "fit", detail: "sharp" },
): GuestSizeAsk | null {
  if (mode === "fixed") {
    const size = VIDEO_FIXED_SIZES.find(({ width, height }) => width === fixed?.width && height === fixed?.height);
    return size ? { ...size, mode, detail } : null;
  }
  if (!(room.width > 0 && room.height > 0)) return null;
  return { width: room.width, height: room.height, mode, scale: pixelRatioOf(element), detail };
}

/**
 * The host's Size and Detail as the viewer's setting (`work.winvm.settings`, read from the keeper's state): Fit to
 * window, or one fixed size of the guest's pixels; Sharp or Faster. A host that says nothing leaves the default.
 */
export function guestSizeSettingOf(display: { screen: string; detail: VideoDetail } | null | undefined): GuestSizeSetting | undefined {
  if (!display) return undefined;
  const fixed = VIDEO_FIXED_SIZES.find(({ width, height }) => `${width}x${height}` === display.screen);
  return fixed ? { mode: "fixed", fixed: { width: fixed.width, height: fixed.height }, detail: display.detail } : { mode: "fit", detail: display.detail };
}
