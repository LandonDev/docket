import { loadToast } from "../../components/ui/toaster";
import { attachmentsFromFiles, attachmentsFromPaths } from "../../lib/attachments";
import { giveComposerFiles } from "../../lib/composerDrafts";
import { pickFiles } from "../../lib/fs";
import type { FilePlace } from "../../lib/openFilePlace";
import { registry } from "../../lib/connection";
import { ensureCreated } from "../../lib/tcserver/commands";
import { sessionStore } from "../../lib/tcserver/store";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { openWorkView, workStartPort } from "../../lib/workSwitch";
import { setOpening } from "./fileDrop";
import { openFiles, sortFiles, type OutsideFile } from "./fileOpen";

/** One line for files no kind shows. */
export const noViewerLine = (files: readonly OutsideFile[]): string =>
  files.length === 1 ? `No viewer for ${files[0]!.name}` : `No viewer for ${files.length} of these files`;

/** A dropped File as an outside file: its path on this machine when it has one. */
export function outsideOf(file: File, path: string | undefined): OutsideFile {
  return { name: file.name, ...(file.type ? { type: file.type } : {}), file, ...(path ? { path, origin: registry.primary().environmentId } : {}) };
}

/** The draft a new thread starts from, in the window's workspace (a view of it is in front). */
function startDraft(): string | null {
  const start = workStartPort.get();
  if (!start) return null;
  openWorkView(null);
  return start(null);
}

/** The thread whose canvas takes the files: made now for a draft. */
async function threadOf(id: string): Promise<{ env: string; folder: string | null }> {
  const session = sessionStore.get(id);
  const meta = sessionStore.metaOf(id) ?? (session ? await ensureCreated(session) : null);
  if (!meta) throw new Error("That thread is gone");
  const folder = meta.workspaceId ? (workspaceStore.getSnapshot().workspaces.find((w) => w.id === meta.workspaceId)?.path ?? null) : null;
  return { env: meta.environmentId, folder };
}

/** Files no kind shows go in the thread's composer, as any attachment does. */
async function addAsFiles(sessionId: string, files: readonly OutsideFile[]): Promise<void> {
  const dropped = files.flatMap((f) => (f.file && !f.path ? [f.file] : []));
  const byPath = files.filter((f) => f.path && f.origin);
  const attachments = [
    ...(dropped.length ? await attachmentsFromFiles(dropped) : []),
    ...(byPath.length ? await attachmentsFromPaths(byPath[0]!.origin!, byPath.map((f) => f.path!)) : []),
  ];
  giveComposerFiles(sessionId, attachments);
}

/**
 * Opens files from outside in a Work thread's canvas: each a kind shows is kept in the
 * workspace's folder and opened, the first shown; the rest are offered as attachments in
 * one line. The thread's pane says what is opening, with the upload's progress and Cancel
 * (CanvasSeat's `OpeningState`).
 */
export async function openOutside(place: FilePlace, files: readonly OutsideFile[]): Promise<void> {
  if (files.length === 0) return;
  const toast = await loadToast();
  const { shows, unknown } = sortFiles(files);
  // A new thread is started only for something to show, or when he asks for the files as attachments.
  const id = place.at !== "new" ? place.sessionId : shows.length > 0 ? startDraft() : null;
  if (unknown.length > 0) {
    const add = (): void => {
      const to = id ?? startDraft();
      if (to) void addAsFiles(to, unknown).catch((error: unknown) => toast.error(errorText(error)));
    };
    toast(noViewerLine(unknown), { action: { label: "Add to the thread as a file", onClick: add } });
  }
  if (!id || shows.length === 0) return;

  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  const token = {};
  setOpening(id, token, { name: shows[0]!.file.name, sent: 0, total: 0, cancel });
  try {
    const { env, folder } = await threadOf(id);
    await openFiles({
      env,
      sessionId: id,
      files: shows,
      folder,
      signal: controller.signal,
      onProgress: (file, progress) => setOpening(id, token, { name: file.name, ...progress, cancel }),
    });
  } catch (error) {
    if (!controller.signal.aborted) toast.error(shows.length === 1 ? `Couldn't open ${shows[0]!.file.name}` : "Couldn't open the files", { description: errorText(error) });
  } finally {
    setOpening(id, token, null);
  }
}

/** The system's open dialog, then the same as a drop. */
export async function pickAndOpen(place: FilePlace): Promise<void> {
  const paths = await pickFiles("Open");
  if (!paths?.length) return;
  const origin = registry.primary().environmentId;
  await openOutside(
    place,
    paths.map((path) => ({ name: path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1), path, origin })),
  );
}

const errorText = (error: unknown): string => (error instanceof Error && error.message ? error.message : String(error));
