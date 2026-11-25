import { ATTACHMENT_CHUNK_BYTES } from "@shared/contract-attachments";
import type { FileDone, FileRef, FileTab, SavedAsWord } from "@shared/contract-work-files";
import type { CanvasSource } from "@shared/work";
import { deleteAsk, questionFor, refKey, refusal, type FileEntry, type FolderRef, type MakeKind } from "@shared/work/files";
import { confirmAction } from "../../chrome/ConfirmDialog";
import { loadToast } from "../../components/ui/toaster";
import { blobSource } from "../../lib/attachmentUpload";
import { registry } from "../../lib/connection";
import { workErrorWords } from "../../lib/workErrorWords";
import { flushItem } from "../canvas/flush";
import { carryRefusal, doneWords, refusedWords, type PlaceCopy } from "./model";
import { filesLink } from "./farLink";
import { openingWords, type MarkBusy, type RowBusy } from "./busy";
import { closeTab, tabsNow } from "./store";

/**
 * The window's side of every change in the Files place (docs/agents/work-files.md "New, rename, move and copy",
 * "Trash", "Upload"). Each asks the file's own host, under an operation id of its own so a retry does nothing
 * twice; a change others will see is asked first, in the grammar's own question (`questionFor`); what a place
 * refuses is said in its one sentence, and a bulk act says what it could not do, file by file. A delete, and a
 * move inside one place, say what went, with Undo. While the host works, each row the act changes shows the list's
 * spinner and its verb (`ActsOf.busy`; a rename shows the name he typed), until the answer.
 */

const opId = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const refOf = (entry: FileEntry): FileRef => (entry.ref ?? entry.folder)!;
const longWait = (copy: PlaceCopy): { timeoutMs?: number } => (copy.place.vm ? { timeoutMs: 120_000 } : {});

const failed = (title: string, err: unknown): void => void loadToast().then((toast) => toast.error(title, { description: workErrorWords(err) || undefined }));
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
  /** marks the rows an act is changing, and lets them go; absent, nothing is marked */
  busy?: MarkBusy;
}

/**
 * How long rows an act changed keep their word once the host said it went: the folder is read again on the host's
 * push first, so a renamed, moved or deleted row never shows its old self between the answer and the new list.
 */
export const SETTLE_MS = 2000;

/** The rows marked while `work` runs; let go at its end, or a little after where `went` says it changed them. */
async function marking<T>(of: ActsOf, keys: readonly string[], busy: RowBusy, work: () => Promise<T>, went: (out: T) => boolean = () => false): Promise<T> {
  of.busy?.(keys, busy);
  let changed = false;
  try {
    const out = await work();
    changed = went(out);
    return out;
  } finally {
    if (changed) setTimeout(() => of.busy?.(keys, null), SETTLE_MS);
    else of.busy?.(keys, null);
  }
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
  // The row shows the name he typed from his Return until the host answers.
  return marking(
    of,
    [entry.key],
    { word: "Renaming…", name: next },
    async () => {
      // What an open tab on it holds goes in first; words still waiting follow the file to its new name.
      await unsavedIn(tabsOn(tabsNow(of.home, of.workspaceId), [entry]));
      try {
        const done = await filesLink(copy.link).request<FileDone>("work.files.rename", { workspaceId: of.workspaceId, ref: refOf(entry), name: next, op: opId() }, longWait(copy));
        const made = done.entries[0];
        if (made) await copiesFollow(of, copy, [[entry, made]]);
        return made ?? null;
      } catch (err) {
        failed(`${entry.name} was not renamed`, err);
        return null;
      }
    },
    (made) => made !== null,
  );
}

/**
 * A file of another host renamed or moved there: the workspace's own host keeps its open copy, which follows to where
 * the file now lies, so his next edit is sent there (files/copies.ts `copiesMoved`). A host of this host's own carries
 * its copies itself. An older workspace host that does not know the verb leaves the copy as it was.
 */
async function copiesFollow(of: ActsOf, copy: PlaceCopy, pairs: readonly [FileEntry, FileEntry][]): Promise<void> {
  if (copy.link === of.home) return;
  const moves = pairs.flatMap(([was, now]) => {
    const from = refOf(was);
    const to = refOf(now);
    return from.at === "file" && to.at === "file" && from.path !== to.path ? [{ from, to }] : [];
  });
  if (!moves.length || !tabsOn(tabsNow(of.home, of.workspaceId), pairs.map(([was]) => was)).length) return;
  await registry.linkOf(of.home).request("work.files.copiesMoved", { workspaceId: of.workspaceId, moves }).catch(() => undefined);
}

/**
 * Each thing a move took, with where it went: paired by name only where the name is one thing's alone, among those
 * asked and those that went, and was not refused. Two of one name from two folders pair with nothing, so no copy is
 * ever pointed at the other's file.
 */
export function movedPairs(entries: readonly FileEntry[], done: Pick<FileDone, "entries" | "refused">): [FileEntry, FileEntry][] {
  const once = (names: readonly string[], name: string): boolean => names.filter((n) => n === name).length === 1;
  const asked = entries.map((e) => e.name);
  const went = done.entries.map((e) => e.name);
  const refused = new Set(done.refused.map((r) => r.name));
  return entries.flatMap((e) => (once(asked, e.name) && once(went, e.name) && !refused.has(e.name) ? [[e, done.entries.find((d) => d.name === e.name)!] as [FileEntry, FileEntry]] : []));
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
export async function carryTo(
  of: ActsOf,
  verb: "move" | "copy",
  from: PlaceCopy,
  entries: readonly FileEntry[],
  to: { copy: PlaceCopy; at: FolderRef; name: string },
  back?: CameFrom,
  /** says why nothing went where he asked (Move to…'s own line); else a toast says it */
  fail?: (why: string) => void,
): Promise<boolean> {
  if (!entries.length) return false;
  const title = verb === "move" ? "Nothing was moved" : "Nothing was copied";
  const didNot = (err: unknown): false => (fail ? fail(workErrorWords(err, { host: from.host, write: true }) || `${title}.`) : failed(title, err), false);
  const no = entries.map((entry) => carryRefusal(from.place, verb, entry, to.copy.place)).find((r) => r !== null);
  if (no) return didNot(new Error(no.text));
  const question = questionFor(from.place, verb, entries[0], to.copy.place);
  if (question && !(await confirmAction({ title: question.split("? ")[0]! + "?", body: question.split("? ").slice(1).join("? ") || undefined, action: verb === "move" ? "Move" : "Copy" }))) return false;
  if (verb === "move") await unsavedIn(tabsOn(tabsNow(of.home, of.workspaceId), entries));
  try {
    const done = await marking(
      of,
      entries.map((e) => e.key),
      { word: verb === "move" ? "Moving…" : "Copying…" },
      () => filesLink(from.link).request<FileDone>(`work.files.${verb}`, { workspaceId: of.workspaceId, refs: entries.map(refOf), to: to.at, op: opId(), ...(question ? { asked: true } : {}) }, longWait(from)),
      // A copy leaves its rows where they were: only a move's rows leave the list.
      (out) => verb === "move" && out.entries.length > 0,
    );
    if (verb === "move") await copiesFollow(of, from, movedPairs(entries, done));
    const samePlace = from.link === to.copy.link && from.place.id === to.copy.place.id;
    const undo = verb === "move" && back && samePlace ? () => void carryTo(of, "move", to.copy, done.entries, { copy: from, at: back.at, name: back.name }) : undefined;
    if (!done.entries.length) return didNot(new Error(leftovers(done) ?? "The folder took nothing."));
    said(doneWords(verb === "move" ? "Moved" : "Copied", done.entries.map((e) => e.name), to.name), { description: leftovers(done), ...(undo ? { undo } : {}) });
    return true;
  } catch (err) {
    return didNot(err);
  }
}

/**
 * Save as Word to…: the document written as a new .docx into the folder he picked, under a free name, never over
 * anything (files/saveAsWord.ts on the workspace's host, which exports it from the live text). One toast with Show.
 */
export async function saveAsWordTo(of: ActsOf, source: CanvasSource, to: { at: FolderRef; name: string }, show: () => void): Promise<boolean> {
  try {
    await registry.linkOf(of.home).request<SavedAsWord>("work.files.saveAsWord", { workspaceId: of.workspaceId, source, at: to.at, op: opId() }, { timeoutMs: 180_000 });
    void loadToast().then((toast) => toast.message(`Saved as Word in ${to.name}`, { action: { label: "Show", onClick: show } }));
    return true;
  } catch (err) {
    failed("Not saved as Word", err);
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
/** The writes of each open copy among these tabs, by its file's key: what a delete's question showed, so the host lets go of no write made after his press. */
export const writesIn = (tabs: readonly FileTab[]): Record<string, number> =>
  Object.fromEntries(tabs.flatMap((t) => (t.copyOf && t.back?.writes !== undefined ? [[refKey({ at: "file", host: t.copyOf.host, path: t.copyOf.path }), t.back.writes] as const] : [])));

/**
 * What these open tabs still hold, sent to their files first (canvas/flush.ts, as a close does): the name of one whose
 * words did not go in, or whose send was still on its way at the wait's end; null when every tab's went.
 */
export async function unsavedIn(tabs: readonly FileTab[]): Promise<string | null> {
  const sent = await Promise.all(tabs.map(async (t) => ((await flushItem(t.itemId).catch(() => "failed" as const)) === "sent" ? null : t.name)));
  return sent.find((name) => name !== null) ?? null;
}

/**
 * Delete: to Trash, or in a place others can open to its computer's own bin, said in one toast with Undo. What an open
 * tab on it still holds is sent first, so Trash keeps his last words; words that did not go in are asked about. A place
 * others can open asks first, naming what goes and who can open it, and says when a copy of it holds changes not sent.
 */
export async function trash(of: ActsOf, copy: PlaceCopy, entries: readonly FileEntry[]): Promise<boolean> {
  if (!entries.length) return false;
  const no = entries.map((entry) => refusal(copy.place, "trash", entry)).find((r) => r !== null);
  if (no) return (failed("Nothing was deleted", new Error(no.text)), false);
  const question = questionFor(copy.place, "trash", entries[0]);
  const unsaved = await unsavedIn(tabsOn(tabsNow(of.home, of.workspaceId), entries));
  // The tabs as the question shows them, after what they held went in.
  const open = tabsOn(tabsNow(of.home, of.workspaceId), entries);
  // A drive with no bin (a mapped drive on his PC) is always asked: what goes there cannot be put back.
  const forGood = copy.place.bin === false;
  // The copies' writes a question showed go with the delete: the host lets go of none written after his press.
  const writes = question || forGood || unsaved ? writesIn(open) : {};
  if (question || forGood) {
    const ask = deleteAsk(copy.place, entries.map((e) => e.name));
    const lost = unsaved ? " Changes in its open tab that are not saved are lost." : unsentIn(open) ? " Changes in its open copy that have not reached it are lost." : "";
    if (!(await confirmAction({ title: ask.title, body: ask.body + lost, action: "Delete", danger: true }))) return false;
  } else if (unsaved && !(await confirmAction({ title: `Changes to ${unsaved} are not saved.`, body: "Delete it anyway? They will be lost.", action: "Delete Anyway", danger: true }))) return false;
  try {
    // A desktop the window cannot reach is asked through the workspace's host (farLink.ts), which sends it there.
    const done = await marking(
      of,
      entries.map((e) => e.key),
      { word: "Deleting…" },
      () => filesLink(copy.link).request<FileDone>("work.files.trash", { workspaceId: of.workspaceId, refs: entries.map(refOf), op: opId(), ...(question ? { asked: true } : {}), ...(forGood ? { forGood: true } : {}), ...(Object.keys(writes).length ? { writes } : {}) }, longWait(copy)),
      (out) => out.refused.length < entries.length,
    );
    const ids = done.trashed ?? [];
    const gone = entries.length - done.refused.length;
    if (gone > 0) {
      const went = entries.filter((e) => !done.refused.some((r) => r.name === e.name));
      // A file of another computer leaves its seat here too: the workspace's own host keeps its tabs and copies.
      if (copy.link !== of.home) for (const tab of tabsOn(tabsNow(of.home, of.workspaceId), went)) void closeTab(of.home, of.workspaceId, tab.id, HOME_PAGE, true).catch(() => undefined);
      said(doneWords("Deleted", went.map((e) => e.name)), { description: leftovers(done), ...(ids.length ? { undo: () => void restore(of, copy.link, ids) } : {}) });
    } else failed(done.refused.some((r) => r.unknown) ? "Delete not confirmed" : "Nothing was deleted", new Error(leftovers(done) ?? "Nothing went to Trash."));
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
    const done = await filesLink(link).request<FileDone>("work.files.restore", { workspaceId: of.workspaceId, ids, op: opId() });
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

/** Save to Workspace: a mail's file is copied into the workspace's folder (or a folder of it), and leaves From mail. Said in one toast. */
export async function keepMail(of: ActsOf, from: PlaceCopy, entries: readonly FileEntry[], to: { at: FolderRef; name: string }): Promise<boolean> {
  if (!entries.length) return false;
  try {
    const done = await registry.linkOf(from.link).request<FileDone>("work.files.copy", { workspaceId: of.workspaceId, refs: entries.map(refOf), to: to.at, op: opId() }, longWait(from));
    if (done.entries.length) said(`Saved ${done.entries.length === 1 ? done.entries[0]!.name : `${done.entries.length} files`} to ${to.name}`, { description: leftovers(done) });
    else failed("Nothing was saved", new Error(leftovers(done) ?? "The folder took nothing."));
    return done.entries.length > 0;
  } catch (err) {
    failed("Nothing was saved", err);
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

/** An upload the host no longer knows: its id expired, or the host started again since the begin. */
const expired = (err: unknown): boolean => (err as { code?: string })?.code === "unknown-upload" || /unknown upload/i.test(err instanceof Error ? err.message : String(err));

/**
 * Whether a commit whose answer did not come made the file all the same: the commit asked again is answered as the
 * first was (attachmentUploads.ts keeps each commit's answer a day), and across a restart of the host the upload's op
 * says whether it landed (upload.ts `beginUpload`). Nothing is sent again before one of them answers.
 */
async function landedAfter(link: ReturnType<typeof registry.linkOf>, uploadId: string, begin: Record<string, unknown>, wait: { timeoutMs?: number }): Promise<boolean> {
  try {
    await link.request("attachment.commit", { uploadId });
    return true;
  } catch {
    const again = await link.request<{ landed?: true }>("work.files.upload", begin, wait).catch(() => null);
    return again?.landed === true;
  }
}

/**
 * Files from this computer into a folder, one after another, each in chunks under its own upload: the host
 * checks its size and hash before it makes the file, never over anything. A commit whose answer was lost is asked
 * of the host before it is called failed (`landedAfter`), and an upload the host forgot before its commit (it started
 * again) is sent once more under a new op. Answers how many landed; each that did not is said once.
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
    const send = async (source: Awaited<ReturnType<typeof blobSource>>): Promise<void> => {
      const begin = { workspaceId: of.workspaceId, at, name: file.name, size: source.size, sha256: source.sha256, op: opId() };
      const begun = await link.request<{ uploadId: string; chunkBytes?: number }>("work.files.upload", begin, longWait(copy));
      const id = (uploadId = begun.uploadId);
      const chunk = Math.min(begun.chunkBytes || ATTACHMENT_CHUNK_BYTES, ATTACHMENT_CHUNK_BYTES);
      o.onProgress?.({ name: file.name, index, count: files.length, sent: 0, total: source.size });
      for (let offset = 0, part = 0; offset < source.size; offset += chunk, part += 1) {
        o.signal?.throwIfAborted();
        await link.request("attachment.chunk", { uploadId: id, index: part, dataBase64: await source.read(offset, Math.min(chunk, source.size - offset)) });
        o.onProgress?.({ name: file.name, index, count: files.length, sent: Math.min(offset + chunk, source.size), total: source.size });
      }
      o.signal?.throwIfAborted();
      try {
        await link.request("attachment.commit", { uploadId: id });
      } catch (err) {
        if (!(await landedAfter(link, id, begin, longWait(copy)))) throw err;
      }
    };
    try {
      const source = await blobSource(file);
      try {
        await send(source);
      } catch (err) {
        if (!expired(err) || o.signal?.aborted) throw err;
        await send(source);
      }
      landed += 1;
    } catch (err) {
      if (uploadId) void link.request("attachment.abort", { uploadId }).catch(() => undefined);
      if (o.signal?.aborted) break;
      lost.push({ name: file.name, text: workErrorWords(err) || "It did not upload." });
    }
  }
  o.onProgress?.(null);
  if (lost.length) failed(landed ? `${lost.length} of ${files.length} did not upload` : "Nothing was uploaded", new Error(refusedWords(lost) ?? ""));
  return landed;
}

/**
 * Which Download a file's tab offers: its own copy's bytes for a copy, the file's own where this window may read
 * them (never a shared library's from another computer's window), else none: a press that can only be refused is
 * not offered.
 */
export function downloadOf<T>(file: { copy: boolean; shared: boolean; there: boolean }, ways: { copy: T; lies: T }): { download?: T } {
  if (file.copy) return { download: ways.copy };
  return file.shared && file.there ? {} : { download: ways.lies };
}

/**
 * A file's bytes to this computer, read from where they lie in parts of one version. With `itemId` the bytes are a
 * Files tab's own copy (a file of another computer or the VM, open here): the workspace's host reads the copy it
 * holds, since the original's bytes go to no window but its own computer's.
 */
export async function download(of: ActsOf, copy: PlaceCopy, entry: FileEntry, itemId?: string): Promise<void> {
  if (!entry.ref) return;
  // The row says how far the bytes have come where its size is known.
  const far = (got: number): RowBusy => ({ word: entry.size ? openingWords(got, entry.size, "Downloading…") : "Downloading…" });
  of.busy?.([entry.key], far(0));
  try {
    const link = registry.linkOf(copy.link);
    const parts: BlobPart[] = [];
    let version: string | undefined;
    for (let offset = 0; ; ) {
      const got = await link.request<{ data: string; version: string; end: boolean }>("work.files.read", { workspaceId: of.workspaceId, ref: entry.ref as CanvasSource, ...(itemId ? { itemId } : {}), offset, length: 4 * 1024 * 1024, ...(version ? { version } : {}) }, longWait(copy));
      const raw = atob(got.data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      parts.push(bytes as BlobPart);
      version = got.version;
      offset += bytes.length;
      if (got.end || bytes.length === 0) break;
      of.busy?.([entry.key], far(offset));
    }
    const url = URL.createObjectURL(new Blob(parts));
    const a = document.createElement("a");
    a.href = url;
    a.download = entry.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    failed(`${entry.name} did not download`, err);
  } finally {
    of.busy?.([entry.key], null);
  }
}
