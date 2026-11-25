/// <reference lib="webworker" />
import { decodeXlsx, type XlsxDecoded } from "./xlsxDecode";

/**
 * An Excel file's decode off the window's main thread (perf M9): the package's bytes come in transferred, the workbook,
 * its charts and pictures go back with each picture's bytes transferred. One message in, one out.
 */
self.onmessage = (event: MessageEvent<{ id: number; bytes: ArrayBuffer }>) => {
  const { id, bytes } = event.data;
  try {
    const got: XlsxDecoded = decodeXlsx(new Uint8Array(bytes));
    (self as unknown as Worker).postMessage({ id, got }, got.media.map((m) => m.bytes.buffer as ArrayBuffer));
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
