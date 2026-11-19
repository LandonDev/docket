import { defineChunk } from "../../lib/lazyChunk";
import { Media } from "../icons";
import { defineCanvasKind } from "../canvas/kind";
import type { MediaState } from "./MediaCanvas";

/**
 * The media kind of canvas item (docs/agents/work-media.md): an image or a
 * video beside a Work thread. It claims Frame.io's files too; their source
 * adapter is milestone 48's. Its own bar draws its versions, so the pane
 * draws no History for it.
 */
export const mediaCanvas = defineCanvasKind<MediaState>({
  kind: "media",
  label: "Media",
  icon: Media,
  opens: {
    sources: [{ at: "frameio" }],
    mime: ["image/*", "video/*"],
    ext: ["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif", "tif", "tiff", "bmp", "psd", "mp4", "m4v", "mov", "webm", "mkv", "mxf", "avi", "mts", "m2ts", "ogv"],
  },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-media-canvas", () => import("./MediaCanvas")),
});
