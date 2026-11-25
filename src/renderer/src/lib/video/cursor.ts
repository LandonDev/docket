import type { CursorShape } from "@server/shared/video/nsl1";

export function cursorGeometry(shape: CursorShape, scale: number, dpr: number) {
  if (!(scale > 0 && dpr > 0)) return null;
  const width = Math.max(1, Math.round(shape.width * scale * dpr));
  const height = Math.max(1, Math.round(shape.height * scale * dpr));
  if (width / dpr > 128 || height / dpr > 128) return null;
  // CSS hotspots are in CSS pixels and Chromium takes whole coordinates.
  const hotspot = (point: number, size: number, pixels: number) => Math.max(0, Math.min(Math.ceil(pixels / dpr) - 1, Math.round((point * pixels) / size / dpr)));
  return { width, height, hotX: hotspot(shape.hotX, shape.width, width), hotY: hotspot(shape.hotY, shape.height, height) };
}

const hidden = ({ rgba }: CursorShape): boolean => !rgba.some((alpha, i) => i % 4 === 3 && alpha !== 0);

type CursorImage = { url: Promise<string | null>; revoke: () => void };

export class CursorImages {
  private closed = false;
  private readonly images = new Map<string, CursorImage>();

  constructor(private readonly doc: Document) {}

  async css(shape: CursorShape, scale: number, dpr: number): Promise<string> {
    if (hidden(shape)) return "none";
    const size = cursorGeometry(shape, scale, dpr);
    if (!size) return "";
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(shape.rgba));
    if (this.closed) return "";
    const key = `${shape.width}:${shape.height}:${size.width}:${size.height}:${new Uint8Array(hash).join(".")}`;
    let image = this.images.get(key);
    if (!image) {
      if (this.images.size === 16) {
        const oldest = this.images.keys().next().value!;
        this.images.get(oldest)?.revoke();
        this.images.delete(oldest);
      }
      image = this.render(shape, size.width, size.height);
      this.images.set(key, image);
    } else {
      this.images.delete(key);
      this.images.set(key, image);
    }
    const url = await image.url;
    if (!url) return "";
    const value = dpr === 1 ? `url("${url}")` : `image-set(url("${url}") ${dpr}x)`;
    return `${value} ${size.hotX} ${size.hotY}, default`;
  }

  close(): void {
    this.closed = true;
    for (const image of this.images.values()) image.revoke();
    this.images.clear();
  }

  private render(shape: CursorShape, width: number, height: number): CursorImage {
    const canvas = this.doc.createElement("canvas");
    canvas.width = shape.width;
    canvas.height = shape.height;
    const ctx = canvas.getContext("2d");
    ctx?.putImageData(new ImageData(new Uint8ClampedArray(shape.rgba), shape.width, shape.height), 0, 0);
    const scaled = this.doc.createElement("canvas");
    scaled.width = width;
    scaled.height = height;
    const scaleCtx = scaled.getContext("2d");
    if (ctx && scaleCtx) {
      scaleCtx.imageSmoothingEnabled = false;
      scaleCtx.drawImage(canvas, 0, 0, width, height);
    }
    const url = new Promise<string | null>((resolve) => {
      if (!ctx || !scaleCtx) return resolve(null);
      scaled.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null));
    });
    return { url, revoke: () => void url.then((value) => { if (value) URL.revokeObjectURL(value); }) };
  }
}
