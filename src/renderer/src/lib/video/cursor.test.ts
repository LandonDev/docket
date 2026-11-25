import { describe, expect, it, vi } from "vitest";
import type { CursorShape } from "@server/shared/video/nsl1";
import { CursorImages, cursorGeometry } from "./cursor";

const shape: CursorShape = { generation: 1, width: 64, height: 32, hotX: 32, hotY: 5, rgba: new Uint8Array(64 * 32 * 4).fill(255) };

describe("the local cursor", () => {
  it("rounds size to device pixels, scales the hotspot, and keeps it inside the image", () => {
    expect(cursorGeometry(shape, 0.68, 2)).toEqual({ width: 87, height: 44, hotX: 22, hotY: 3 });
    expect(cursorGeometry({ ...shape, hotX: 63 }, 0.01, 2)).toEqual({ width: 1, height: 1, hotX: 0, hotY: 0 });
    expect(cursorGeometry(shape, 2, 2)).toEqual({ width: 256, height: 128, hotX: 64, hotY: 10 });
    expect(cursorGeometry(shape, 2.01, 2)).toBeNull();
  });

  it("hides an all-clear shape even above the size limit", async () => {
    const images = new CursorImages({} as Document);
    expect(await images.css({ ...shape, rgba: new Uint8Array(shape.rgba.length) }, 4, 2)).toBe("none");
    expect(await images.css({ ...shape, width: 0, height: 0, rgba: new Uint8Array() }, 1, 1)).toBe("none");
    expect(await images.css(shape, 4, 2)).toBe("");
  });

  it("reuses each scaled shape by content and frees the URLs with the picture", async () => {
    const toBlob = vi.fn((reply) => reply(new Blob(["png"])));
    const ctx = { putImageData: vi.fn(), drawImage: vi.fn() };
    const fakeDoc = { createElement: () => ({ getContext: () => ctx, toBlob }) } as unknown as Document;
    vi.stubGlobal("ImageData", class {});
    let id = 0;
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:shape-${++id}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      const images = new CursorImages(fakeDoc);
      expect(await images.css(shape, 0.5, 2)).toBe('image-set(url("blob:shape-1") 2x) 16 3, default');
      expect(await images.css({ ...shape, hotX: 10, rgba: shape.rgba.slice() }, 0.5, 2)).toBe('image-set(url("blob:shape-1") 2x) 5 3, default');
      const changed = shape.rgba.slice();
      changed[0] = 1;
      expect(await images.css({ ...shape, rgba: changed }, 0.5, 2)).toContain("blob:shape-2");
      expect(create).toHaveBeenCalledTimes(2);
      images.close();
      await Promise.resolve();
      expect(revoke.mock.calls.flat().sort()).toEqual(["blob:shape-1", "blob:shape-2"]);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
