import { ATTACHMENT_CHUNK_BYTES } from "@shared/contract-attachments";
import type { FileDone, FileRef, FileTab } from "@shared/contract-work-files";
import type { CanvasSource } from "@shared/work";
import { deleteAsk, questionFor, refusal, type FileEntry, type FolderRef, type MakeKind } from "@shared/work/files";
import { confirmAction } from "../../chrome/ConfirmDialog";
import { loadToast } from "../../components/ui/toaster";
import { blobSource } from "../../lib/attachmentUpload";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import { doneWords, refusedWords, type PlaceCopy } from "./model";
import { closeTab, tabsNow } from "./store";

/**
 * The window's side of every change in the Files place (docs/agents/work-files.md "New, rename, move and copy",
 * "Trash", "Upload"). Each asks the file's own host, under an operation id of its own so a retry does nothing
 * twice; a change others will see is asked first, in the grammar's own question (`questionFor`); what a place
 * refuses is said in its one sentence, and a bulk act says what it could not do, file by file. A delete, and a
 * move inside one place, say what went, with Undo.
 */

const opId = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const refOf = (entry: FileEntry): FileRef => (entry.ref ?? entry.folder)!;
const longWait = (copy: PlaceCopy): { timeoutMs?: number } => (copy.place.vm ? { timeoutMs: 120_000 } : {});

const failed = (title: string, err: unknown): void => void loadToast().then((toast) => toast.error(title, { description: refusalWords(err) || undefined }));
const said = (title: string, o: { description?: string; undo?: () => void } = {}): void =>
  void loadToast().then((toast) => toast.message(title, { ...(o.description ? { description: o.description } : {}), ...(o.undo ? { action: { label: "Undo", onClick: o.undo } } : {}) }));

/** What a change's answer says beyond its own toast: the things it could not do. */
function leftovers(done: FileDone): string | undefined {
  return refusedWords(done.refused) ?? undefined;
}

export interface ActsOf {
  workspaceId: string;
  /** the link of the workspace's own host, which keeps his marks and Trash */
  home: string;
}

/** New: a thing of `kind` in the folder. Answers the entry made, to select and name; null when it was refused (said in one toast). */
export async function makeIn(of: ActsOf, copy: PlaceCopy, at: FolderRef, kind: MakeKind, name?: string): Promise<FileEntry | null> {
  try {
    const done = await registry.linkOf(copy.link).request<FileDone>("work.files.make", { workspaceId: of.workspaceId, at, kind, ...(name?.trim() ? { name: name.trim() } : {}), op: opId() }, longWait(copy));
    return done.entries[0] ?? null;
  } catch (err) {
    failed("Nothing was made", err);
    return null;
  }
}

/** Rename in place. Answers whether it took; a refusal is one toast in the host's own sentence. */
export async function renameTo(of: ActsOf, copy: PlaceCopy, entry: FileEntry, name: string): Promise<FileEntry | null> {
  const next = name.trim();
  if (!next || next === entry.name) return null;
  try {
    const done = await registry.linkOf(copy.link).request<FileDone>("work.files.rename", { workspaceId: of.workspaceId, ref: refOf(entry), name: next, op: opId() }, longWait(copy));
    return done.entries[0] ?? null;
  } catch (err) {
    failed(`${entry.name} was not renamed`, err);
    return null;
  }
}

/** The folder a move's rows came from, where its Undo puts them back. */
export interface CameFrom {
  at: FolderRef;
  name: string;
}

/**
 * Move or copy into a folder. The grammar's refusal is said before anything is asked; a change others will see
 * is asked first. Answers whether anything went. A move inside one place, of rows from one folder (`back`), says
 * so with Undo, which moves what went back there through the same verb.
 */
export async function carryTo(of: ActsOf, verb: "move" | "copy", from: PlaceCopy, entries: readonly FileEntry[], to: { copy: PlaceCopy; at: FolderRef; name: string }, back?: CameFrom): Promise<boolean> {
  if (!entries.length) return false;
  const no = entries.map((entry) => refusal(from.place, verb, entry, to.copy.place)).find((r) => r !== null);
  if (no) return (failed(verb === "move" ? "Nothing was moved" : "Nothing was copied", new Error(no.text)), false);
  const question = questionFor(from.place, verb, entries[0], to.copy.place);
  if (question && !(await confirmAction({ title: question.split("? ")[0]! + "?", body: question.split("? ").slice(1).join("? ") || undefined, action: verb === "move" ? "Move" : "Copy" }))) return false;
  try {
    const done = await registry
      .linkOf(from.link)
      .request<FileDone>(`work.files.${verb}`, { workspaceId: of.workspaceId, refs: entries.map(refOf), to: to.at, op: opId(), ...(question ? { asked: true } : {}) }, longWait(from));
    const samePlace = from.link === to.copy.link && from.place.id === to.copy.place.id;
    const undo = verb === "move" && back && samePlace ? () => void carryTo(of, "move", to.copy, done.entries, { copy: from, at: back.at, name: back.name }) : undefined;
    if (done.entries.length) said(doneWords(verb === "move" ? "Moved" : "Copied", done.entries.map((e) => e.name), to.name), { description: leftovers(done), ...(undo ? { undo } : {}) });
    else failed(verb === "move" ? "Nothing was moved" : "Nothing was copied", new Error(leftovers(done) ?? "The folder took nothing."));
    return done.entries.length > 0;
  } catch (err) {
    failed(verb === "move" ? "Nothing was moved" : "Nothing was copied", err);
    return false;
  }
}

/** A copy's states whose changes have not reached its file yet. */
const UNSENT = new Set(["sending", "changed", "away", "refused"]);
/** The workspace's file tabs on these things, or on anything inside these folders: a tab names a file by where it lies. */
export function tabsOn(tabs: readonly FileTab[], entries: readonly FileEntry[]): FileTab[] {
  const paths = entries.flatMap((e) => {
    const ref = e.ref ?? e.folder;
    return ref && ref.at === "file" ? [{ host: ref.host, path: ref.path }] : [];
  });
  const under = (host: string, path: string): boolean => paths.some((p) => p.host === host && (path === p.path || path.startsWith(`${p.path}/`) || path.startsWith(`${p.path}\\`)));
  const keys = new Set(entries.map((e) => e.key));
  return tabs.filter((t) => t.kind === "file" && ((t.key && keys.has(t.key)) || (t.copyOf ? under(t.copyOf.host, t.copyOf.path) : false)));
}
/** Whether a copy among these tabs holds changes that have not reached its file. */
export const unsentIn = (tabs: readonly FileTab[]): boolean => tabs.some((t) => !!t.back && UNSENT.has(t.back.is));

/**
 * Delete: to Trash, or in a place others can open to its computer's own bin, said in one toast with Undo. A place
 * others can open asks first, naming what goes and who can open it, and says when a copy of it holds changes not sent.
 */
export async function trash(of: ActsOf, copy: PlaceCopy, entries: readonly FileEntry[]): Promise<boolean> {
  if (!entries.length) return false;
  const no = entries.map((entry) => refusal(copy.place, "trash", entry)).find((r) => r !== null);
  if (no) return (failed("Nothing was deleted", new Error(no.text)), false);
  const question = questionFor(copy.place, "trash", entries[0]);
  const open = tabsOn(tabsNow(of.home, of.workspaceId), entries);
  if (question) {
    const ask = deleteAsk(copy.place, entries.map((e) => e.name));
    const body = unsentIn(open) ? `${ask.body} Changes in its open copy that have not reached it are lost.` : ask.body;
    if (!(await confirmAction({ title: ask.title, body, action: "Delete", danger: true }))) return false;
  }
  try {
    const done = await registry.linkOf(copy.link).request<FileDone>("work.files.trash", { workspaceId: of.workspaceId, refs: entries.map(refOf), op: opId(), ...(question ? { asked: true } : {}) }, longWait(copy));
    const ids = done.trashed ?? [];
    const gone = entries.length - done.refused.length;
    if (gone > 0) {
      const went = entries.filter((e) => !done.refused.some((r) => r.name === e.name));
      // A file of another computer leaves its seat here too: the workspace's own host keeps its tabs and copies.
      if (copy.link !== of.home) for (const tab of tabsOn(tabsNow(of.home, of.workspaceId), went)) void closeTab(of.home, of.workspaceId, tab.id, HOME_PAGE, true).catch(() => undefined);
      said(doneWords("Deleted", went.map((e) => e.name)), { description: leftovers(done), ...(ids.length ? { undo: () => void restore(of, copy.link, ids) } : {}) });
    } else failed("Nothing was deleted", new Error(leftovers(done) ?? "Nothing went to Trash."));
    return gone > 0;
  } catch (err) {
    failed("Nothing was deleted", err);
    return false;
  }
}
/** Where a window that keeps its own tabs lands when a delete closes its last one. */
const HOME_PAGE = { name: "Home", at: { at: "place" as const, id: "home" } };

/** Put back from Trash. */
export async function restore(of: ActsOf, link: string, ids: readonly string[]): Promise<boolean> {
  if (!ids.length) return false;
  try {
    const done = await registry.linkOf(link).request<FileDone>("work.files.restore", { workspaceId: of.workspaceId, ids, op: opId() });
    if (done.entries.length) said(doneWords("Put back", done.entries.map((e) => e.name)), { description: leftovers(done) });
    else failed("Nothing was put back", new Error(leftovers(done) ?? "Trash held none of them."));
    return done.entries.length > 0;
  } catch (err) {
    failed("Nothing was put back", err);
    return false;
  }
}

/** Delete for good: these Trash rows, or all of Trash. Asked first, since nothing brings them back. */
export async function purge(of: ActsOf, link: string, o: { ids?: readonly string[]; names?: readonly string[] } = {}): Promise<boolean> {
  const all = !o.ids;
  const what = all ? "everything in Trash" : o.names?.length === 1 ? o.names[0]! : `${o.ids!.length} things`;
  if (!(await confirmAction({ title: all ? "Empty Trash?" : `Delete ${what} for good?`, body: "This cannot be undone.", action: all ? "Empty Trash" : "Delete for Good", danger: true }))) return false;
  try {
    await registry.linkOf(link).request("work.files.purge", { workspaceId: of.workspaceId, ...(o.ids ? { ids: o.ids } : {}) });
    return true;
  } catch (err) {
    failed(all ? "Trash was not emptied" : "Nothing was deleted", err);
    return false;
  }
}

/** A star on, or off: his mark, kept where the workspace lives. */
export async function star(of: ActsOf, entries: readonly FileEntry[], on: boolean): Promise<void> {
  try {
    for (const entry of entries) await registry.linkOf(of.home).request("work.files.star", { workspaceId: of.workspaceId, ref: refOf(entry), name: entry.name, on });
  } catch (err) {
    failed(on ? "Not starred" : "The star stayed", err);
  }
}

/** Keep: a mail's file is copied into the workspace's folder (or a folder of it), and leaves From mail. Said in one toast. */
export async function keepMail(of: ActsOf, from: PlaceCopy, entries: readonly FileEntry[], to: { at: FolderRef; name: string }): Promise<boolean> {
  if (!entries.length) return false;
  try {
    const done = await registry.linkOf(from.link).request<FileDone>("work.files.copy", { workspaceId: of.workspaceId, refs: entries.map(refOf), to: to.at, op: opId() }, longWait(from));
    if (done.entries.length) said(`Kept ${done.entries.length === 1 ? done.entries[0]!.name : `${done.entries.length} files`} in ${to.name}`, { description: leftovers(done) });
    else failed("Nothing was kept", new Error(leftovers(done) ?? "The folder took nothing."));
    return done.entries.length > 0;
  } catch (err) {
    failed("Nothing was kept", err);
    return false;
  }
}

/** Add to a project, or take out of one: a link kept in LifeOS, on the workspace's own host. The file stays where it is. */
export async function setProject(of: ActsOf, entry: FileEntry, project: { id: string; name: string }, on: boolean): Promise<boolean> {
  try {
    await registry.linkOf(of.home).request("work.files.project", { workspaceId: of.workspaceId, ref: refOf(entry), projectId: project.id, on });
    said(on ? `Added ${entry.name} to ${project.name}` : `Took ${entry.name} out of ${project.name}`);
    return true;
  } catch (err) {
    failed(on ? `${entry.name} was not added to ${project.name}` : `${entry.name} is still in ${project.name}`, err);
    return false;
  }
}

/** How long the Picker may stay open in his browser before the ask is given up. */
const PICK_WAIT_MS = 10 * 60_000;

/**
 * Add from Drive: Google's own Picker, in this computer's browser, as the place's account. What he picks there is
 * what TempCode may then see of his Drive; nothing else of it is listed. Answers how many he picked.
 */
export async function addFromDrive(account: string): Promise<number> {
  try {
    const { files } = await registry.linkOf(registry.primaryEnvironmentId).request<{ files: unknown[] }>("work.google.pick", { account }, { timeoutMs: PICK_WAIT_MS });
    if (files.length) said(files.length === 1 ? "Added 1 file from Drive" : `Added ${files.length} files from Drive`);
    return files.length;
  } catch (err) {
    failed("Nothing was added from Drive", err);
    return 0;
  }
}

export interface UploadProgress {
  /** the file now going, and where it stands among them */
  name: string;
  index: number;
  count: number;
  sent: number;
  total: number;
}

/**
 * Files from this computer into a folder, one after another, each in chunks under its own upload: the host
 * checks its size and hash before it makes the file, never over anything. Answers how many landed; each that
 * did not is said once.
 */
export async function uploadTo(of: ActsOf, copy: PlaceCopy, at: FolderRef, files: readonly File[], o: { onProgress?(progress: UploadProgress | null): void; signal?: AbortSignal } = {}): Promise<number> {
  const no = refusal(copy.place, "upload");
  if (no) return (failed("Nothing was uploaded", new Error(no.text)), 0);
  const link = registry.linkOf(copy.link);
  let landed = 0;
  const lost: { name: string; text: string }[] = [];
  for (const [index, file] of files.entries()) {
    if (o.signal?.aborted) break;
    let uploadId: string | null = null;
    try {
      const source = await blobSource(file);
      const begun = await link.request<{ uploadId: string; chunkBytes?: number }>("work.files.upload", { workspaceId: of.workspaceId, at, name: file.name, size: source.size, sha256: source.sha256, op: opId() }, longWait(copy));
      uploadId = begun.uploadId;
      const chunk = Math.min(begun.chunkBytes || ATTACHMENT_CHUNK_BYTES, ATTACHMENT_CHUNK_BYTES);
      o.onProgress?.({ name: file.name, index, count: files.length, sent: 0, total: source.size });
      for (let offset = 0, part = 0; offset < source.size; offset += chunk, part += 1) {
        o.signal?.throwIfAborted();
        await link.request("attachment.chunk", { uploadId, index: part, dataBase64: await source.read(offset, Math.min(chunk, source.size - offset)) });
        o.onProgress?.({ name: file.name, index, count: files.length, sent: Math.min(offset + chunk, source.size), total: source.size });
      }
      o.signal?.throwIfAborted();
      await link.request("attachment.commit", { uploadId });
      landed += 1;
    } catch (err) {
      if (uploadId) void link.request("attachment.abort", { uploadId }).catch(() => undefined);
      if (o.signal?.aborted) break;
      lost.push({ name: file.name, text: refusalWords(err) || "It did not upload." });
    }
  }
  o.onProgress?.(null);
  if (lost.length) failed(landed ? `${lost.length} of ${files.length} did not upload` : "Nothing was uploaded", new Error(refusedWords(lost) ?? ""));
  return landed;
}

/** A file's bytes to this computer, read from where they lie in parts of one version. */
export async function download(of: ActsOf, copy: PlaceCopy, entry: FileEntry): Promise<void> {
  if (!entry.ref) return;
  try {
    const link = registry.linkOf(copy.link);
    const parts: BlobPart[] = [];
    let version: string | undefined;
    for (let offset = 0; ; ) {
      const got = await link.request<{ data: string; version: string; end: boolean }>("work.files.read", { workspaceId: of.workspaceId, ref: entry.ref as CanvasSource, offset, length: 4 * 1024 * 1024, ...(version ? { version } : {}) }, longWait(copy));
      const raw = atob(got.data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      parts.push(bytes as BlobPart);
      version = got.version;
      offset += bytes.length;
      if (got.end || bytes.length === 0) break;
    }
    const url = URL.createObjectURL(new Blob(parts));
    const a = document.createElement("a");
    a.href = url;
    a.download = entry.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    failed(`${entry.name} did not download`, err);
  }
}
