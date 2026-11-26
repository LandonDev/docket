import { describe, expect, it, vi } from "vitest";
import { ARCHIVE_ENTRIES_MAX, type FileBytes } from "@shared/contract-work-files";
import { makeZip } from "../../../../main/server/work/templates/zip";
import { archiveCopy } from "./archiveCopy";

function reader(archive: Uint8Array) {
  return vi.fn(async (offset: number, length: number, _version?: string): Promise<FileBytes> => {
    const data = archive.subarray(offset, offset + length);
    return { data: Buffer.from(data).toString("base64"), size: archive.length, changed: 0, version: "v1", end: offset + data.length >= archive.length };
  });
}

describe("an open ZIP copy's directory", () => {
  it("lists up to the same cap as the host and ties each range to the first version", async () => {
    const files = Object.fromEntries(Array.from({ length: ARCHIVE_ENTRIES_MAX + 1 }, (_, i) => [`item-${i}.txt`, "sample"]));
    const archive = makeZip(files);
    const read = reader(archive);
    const result = await archiveCopy(archive.length, read);
    expect(result.more).toBe(true);
    expect(result.entries).toHaveLength(ARCHIVE_ENTRIES_MAX);
    expect(result.entries[0]).toEqual({ name: "item-0.txt", size: 6, dir: false });
    expect(read.mock.calls.length).toBeGreaterThan(1);
    for (const [, length, version] of read.mock.calls.slice(1)) {
      expect(length).toBeLessThanOrEqual(64 * 1024);
      expect(version).toBe("v1");
    }
  });

  it("refuses a damaged directory without trying to extract an entry", async () => {
    const archive = makeZip({ "item.txt": "sample" });
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const directory = view.getUint32(archive.length - 6, true);
    view.setUint32(directory, 0);
    await expect(archiveCopy(archive.length, reader(archive))).rejects.toThrow("This zip could not be read.");
  });
});
