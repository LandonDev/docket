import type { CanvasItem, CanvasKind } from "@shared/work";
import { attachmentSettings, blobSource, formatBytes, hostSource, uploadFile, type Source, type UploadProgress } from "../../lib/attachmentUpload";
import { kindForFile } from "./registry";
import { openItem, selectItem } from "./store";

/**
 * Files from outside the app opened in a thread's canvas (docs/agents/work-canvas.md
 * "Opening a file from outside"): a drop, or a pick from the system's open dialog. A
 * file a kind shows lands in the workspace's own folder on the thread's host, under
 * its real name (`attachment.begin` with `into: 'workspace'`), and opens there as a
 * `{ at: 'file' }` item; one already inside that folder on the same machine opens in
 * place with no copy. A file no kind shows is handed back for the caller to offer as
 * an attachment.
 */

/** A file from outside: a drop's File, or a path on the host `origin` (a pick). */
export interface OutsideFile {
  name: string;
  /** The type the desktop gave; a guess (kindForFile). */
  type?: string;
  /** A drop's own File: the bytes when there is no path (a drop from another app's memory). */
  file?: File;
  /** Its path on `origin`, when it has one. */
  path?: string;
  origin?: string;
}

export interface SortedFiles {
  shows: { file: OutsideFile; kind: CanvasKind }[];
  unknown: OutsideFile[];
}

/** Which kind shows each file, in the order given; the rest are no kind's. */
export function sortFiles(files: readonly OutsideFile[]): SortedFiles {
  const out: SortedFiles = { shows: [], unknown: [] };
  for (const file of files) {
    const kind = kindForFile(file.name, file.type);
    if (kind) out.shows.push({ file, kind });
    else out.unknown.push(file);
  }
  return out;
}

const norm = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");

/** Whether `path` is inside `folder`, both on one host; a drive letter's path is matched without case. */
export function inside(path: string, folder: string): boolean {
  const caseless = /^[a-z]:\//i.test(norm(folder));
  const [p, f] = caseless ? [norm(path).toLowerCase(), norm(folder).toLowerCase()] : [norm(path), norm(folder)];
  return f.length > 0 && p.startsWith(`${f}/`);
}

/** The path a file opens at with no copy: one already inside the workspace's folder, on the thread's own host. */
export function inPlace(file: OutsideFile, env: string, folder: string | null): string | null {
  return file.path && file.origin === env && folder && inside(file.path, folder) ? file.path : null;
}

/** A path is read on its host in ranges, so a big file never sits whole in the window; a bare File is read here. */
function sourceOf(file: OutsideFile): Promise<Source> {
  if (file.path && file.origin) return hostSource(file.origin, file.path);
  if (file.file) return blobSource(file.file);
  return Promise.reject(new Error(`${file.name} has nothing to read`));
}

/**
 * Opens each file in the thread's canvas, one after another: the first is shown, the
 * rest are its tabs. A cancel (`signal`) stops before the next chunk; the host drops
 * the partial file, and files opened before it stay.
 */
export async function openFiles(opts: {
  env: string;
  sessionId: string;
  files: readonly { file: OutsideFile; kind: CanvasKind }[];
  /** The workspace's folder on the thread's host; null for a thread with none (a Work Chat). */
  folder: string | null;
  signal?: AbortSignal;
  onProgress?: (file: OutsideFile, progress: UploadProgress) => void;
}): Promise<CanvasItem[]> {
  const opened: CanvasItem[] = [];
  for (const { file, kind } of opts.files) {
    opts.signal?.throwIfAborted();
    let path = inPlace(file, opts.env, opts.folder);
    if (!path) {
      const [{ maxBytes }, source] = await Promise.all([attachmentSettings(opts.env), sourceOf(file)]);
      if (source.size > maxBytes) throw new Error(`${file.name} is ${formatBytes(source.size)}, over this host's ${formatBytes(maxBytes)} limit`);
      const landed = await uploadFile({
        threadEnv: opts.env,
        sessionId: opts.sessionId,
        name: file.name,
        ...(file.type ? { mime: file.type } : {}),
        source,
        into: "workspace",
        ...(opts.signal ? { signal: opts.signal } : {}),
        onProgress: (progress) => opts.onProgress?.(file, progress),
      });
      path = landed.path;
    }
    // A cancel pressed as the last chunk landed still opens nothing.
    opts.signal?.throwIfAborted();
    opened.push(await openItem(opts.env, opts.sessionId, { kind, source: { at: "file", host: opts.env, path }, title: file.name }));
  }
  if (opened.length > 1) selectItem(opts.sessionId, opened[0]!.id);
  return opened;
}
