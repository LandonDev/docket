import { importXlsx, readMedia } from "work-kit/sheet/xlsx";

/**
 * An Excel package read for the grid: the workbook, its charts and pictures, and each picture's bytes by its part, as
 * a plain object a worker can hand back (`xlsxDecode.worker.ts`). The grid's decode runs it in that worker; a window
 * with no workers (a test, a preview) runs it here.
 */
export interface XlsxDecoded {
  workbook: unknown;
  objects: ReturnType<typeof importXlsx>["objects"];
  media: Array<{ part: string; bytes: Uint8Array; type: string }>;
}

export function decodeXlsx(bytes: Uint8Array): XlsxDecoded {
  const { workbook, objects } = importXlsx(bytes);
  const media: XlsxDecoded["media"] = [];
  const seen = new Set<string>();
  for (const picture of objects.pictures) {
    if (seen.has(picture.part)) continue;
    seen.add(picture.part);
    const got = readMedia(bytes, picture.part);
    // (a copy of its own, so its buffer can be handed back whole)
    if (got) media.push({ part: picture.part, bytes: got.slice(), type: picture.contentType });
  }
  return { workbook, objects, media };
}
