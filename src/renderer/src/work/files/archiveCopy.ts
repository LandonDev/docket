import { ARCHIVE_ENTRIES_MAX, type FileArchive, type FileBytes } from "@shared/contract-work-files";
import { bytesOfBase64 } from "./fileText";

const END = 0x06054b50;
const END64 = 0x06064b50;
const END64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const TAIL_MAX = 22 + 0xffff;
const CHUNK = 64 * 1024;

const unreadable = (): Error => new Error("This zip could not be read.");
const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const wide = (view: DataView, at: number): number => {
  const value = Number(view.getBigUint64(at, true));
  if (!Number.isSafeInteger(value)) throw unreadable();
  return value;
};

/** A copy outside the listed places can only be read by its open item. Read the ZIP directory by range. */
export async function archiveCopy(size: number, read: (offset: number, length: number, version?: string) => Promise<FileBytes>): Promise<FileArchive> {
  if (size < 22) throw unreadable();
  const tailAt = Math.max(0, size - TAIL_MAX);
  const first = await read(tailAt, size - tailAt);
  if (first.size !== size) throw unreadable();
  const tail = viewOf(bytesOfBase64(first.data));
  const part = async (at: number, length: number): Promise<Uint8Array> => {
    if (at < 0 || length < 1 || length > size - at) throw unreadable();
    const got = await read(at, length, first.version);
    const bytes = bytesOfBase64(got.data);
    if (bytes.length !== length) throw unreadable();
    return bytes;
  };
  let end = tail.byteLength - 22;
  for (; end >= 0; end--) {
    if (tail.getUint32(end, true) === END && end + 22 + tail.getUint16(end + 20, true) === tail.byteLength) break;
  }
  if (end < 0 || tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true)) throw unreadable();
  let count = tail.getUint16(end + 10, true);
  let left = tail.getUint32(end + 12, true);
  let at = tail.getUint32(end + 16, true);
  if (count === 0xffff || left === 0xffffffff || at === 0xffffffff) {
    const locator = end >= 20 ? viewOf(new Uint8Array(tail.buffer, tail.byteOffset + end - 20, 20)) : viewOf(await part(tailAt + end - 20, 20));
    if (locator.getUint32(0, true) !== END64_LOCATOR || locator.getUint32(16, true) !== 1) throw unreadable();
    const record = viewOf(await part(wide(locator, 8), 56));
    if (record.getUint32(0, true) !== END64 || record.getUint32(16, true) || record.getUint32(20, true)) throw unreadable();
    count = wide(record, 32);
    left = wide(record, 40);
    at = wide(record, 48);
  }
  if (left > size - at) throw unreadable();

  // Keep at most one record and one chunk in memory. Reuse the tail when the directory fits there.
  let bytes = new Uint8Array(0);
  const ensure = async (length: number): Promise<void> => {
    while (bytes.length < length && left > 0) {
      const take = Math.min(left, CHUNK);
      const next = at >= tailAt && at + take <= tailAt + tail.byteLength
        ? new Uint8Array(tail.buffer, tail.byteOffset + at - tailAt, take)
        : await part(at, take);
      const joined = new Uint8Array(bytes.length + next.length);
      joined.set(bytes);
      joined.set(next, bytes.length);
      bytes = joined;
      at += take;
      left -= take;
    }
    if (bytes.length < length) throw unreadable();
  };
  const entries: FileArchive["entries"] = [];
  const utf8 = new TextDecoder();
  for (let i = 0; i < Math.min(count, ARCHIVE_ENTRIES_MAX); i++) {
    await ensure(46);
    const head = viewOf(bytes);
    if (head.getUint32(0, true) !== CENTRAL) throw unreadable();
    const nameLength = head.getUint16(28, true);
    const extraEnd = 46 + nameLength + head.getUint16(30, true);
    const length = extraEnd + head.getUint16(32, true);
    await ensure(length);
    const raw = bytes.subarray(46, 46 + nameLength);
    const name = head.getUint16(8, true) & 0x800 ? utf8.decode(raw) : String.fromCharCode(...raw);
    let size = head.getUint32(24, true);
    if (size === 0xffffffff) {
      const fields = viewOf(bytes);
      for (let field = 46 + nameLength; field + 4 <= extraEnd; ) {
        const kind = fields.getUint16(field, true);
        const length = fields.getUint16(field + 2, true);
        if (field + 4 + length > extraEnd) throw unreadable();
        if (kind === 1 && length >= 8) {
          size = wide(fields, field + 4);
          break;
        }
        field += 4 + length;
      }
    }
    entries.push({ name, size, dir: name.endsWith("/") });
    bytes = bytes.subarray(length);
  }
  return { entries, more: count > entries.length };
}
