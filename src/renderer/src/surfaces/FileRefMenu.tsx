import type { ReactNode } from "react";
import { Copy, ExternalLink, FileText, FolderOpen } from "../chrome/icons";
import { RowsContextMenu, type MenuRow } from "../chrome/menuRows";
import { copyText } from "../lib/clipboard";
import { useEditorConfig } from "../lib/editorConfig";
import { fileRefTarget } from "../lib/fileRef";
import { revealPath } from "../lib/fs";
import { editorLabelFor, openInEditor } from "../lib/openInEditor";
import type { OpenFileFn } from "../lib/search";
import { useTranscriptHost, useTranscriptSession } from "./transcriptSession";
import { isWebMode } from "../lib/nativeWeb";
import { sessionStore } from "../lib/tcserver/store";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { isWorkThread } from "../lib/workRow";

/**
 * The job a Work thread's file opens in: its workspace, or its project's. Null for a code thread, a Work Chat
 * (no job, so no Files place) or a thread this window does not know.
 */
export function workFilesHome(sessionId: string | undefined): { id: string; environmentId: string } | null {
  const meta = sessionId ? sessionStore.metaOf(sessionId) : null;
  if (!meta || !isWorkThread(meta)) return null;
  const { projects, workspaces } = workspaceStore.getSnapshot();
  const workspaceId = meta.workspaceId ?? projects.find((p) => p.id === meta.projectId)?.workspaceId ?? null;
  const workspace = workspaceId ? workspaces.find((w) => w.id === workspaceId) : undefined;
  return workspace ? { id: workspace.id, environmentId: workspace.environmentId } : null;
}

/**
 * Right-click on any file link in the transcript: Open in Files first in a
 * Work thread of a job (a tab in the job's Files place), Open in <editor> (Open
 * on the Mac for a thread on another host), Reveal in Finder, Copy path,
 * Copy file name. Left-click stays with the wrapped child. Relative
 * targets resolve against the transcript's cwd; without one, Reveal hides
 * and Copy path copies the path as written.
 */
export function FileRefMenu({
  target,
  cwd,
  onOpenFile,
  children,
}: {
  /** the path as rendered — may be relative and carry a :line(:col) tail */
  target: string;
  cwd?: string;
  /** Where the host's version lands when the editor cannot take the file. */
  onOpenFile?: OpenFileFn;
  children: ReactNode;
}) {
  const editorConfig = useEditorConfig();
  // The thread's host: a path outside every catalog root is on it (lib/pathHost.ts).
  const threadHost = useTranscriptHost();
  const sessionId = useTranscriptSession();
  if (!target) return <>{children}</>;
  const ref = fileRefTarget(target, cwd);
  const editorLabel = editorLabelFor(ref.abs, editorConfig, threadHost);
  // Read at the right-click, so a thread whose job lands later still offers it.
  const filesHome = () => (ref.abs && threadHost ? workFilesHome(sessionId) : null);
  const rowsFor = (): MenuRow[] => [
    ...(filesHome() ? [{ kind: "item", id: "files", label: "Open in Files", icon: FolderOpen } as const] : []),
    ...(editorLabel ? [{ kind: "item", id: "editor", label: editorLabel, icon: ExternalLink } as const] : []),
    ...(ref.abs && !isWebMode() ? [{ kind: "item", id: "reveal", label: "Reveal in Finder", icon: FolderOpen } as const] : []),
    { kind: "item", id: "path", label: "Copy path", icon: Copy },
    { kind: "item", id: "name", label: "Copy file name", icon: FileText },
  ];
  const pick = (id: string) => {
    const home = id === "files" ? filesHome() : null;
    if (home && ref.abs && threadHost) {
      void import("../work/files/openFrom").then((m) => m.openInFiles(home, { ref: { at: "file", host: threadHost, path: ref.abs! }, name: ref.name }));
    } else if (id === "editor" && ref.abs) {
      const tail = /:(\d+)(?::(\d+))?\s*$/.exec(target);
      void openInEditor(
        {
          path: ref.abs,
          cwd,
          threadHost,
          line: tail ? Number(tail[1]) : undefined,
          column: tail?.[2] ? Number(tail[2]) : undefined,
        },
        onOpenFile ?? (() => {}),
      );
    } else if (id === "reveal" && ref.abs) void revealPath(ref.abs);
    else if (id === "path") void copyText(ref.abs ?? ref.clean);
    else if (id === "name") void copyText(ref.name);
  };
  return (
    <RowsContextMenu label="File link actions" lazyMount rowsFor={rowsFor} onPick={pick}>
      <span className="contents">{children}</span>
    </RowsContextMenu>
  );
}
