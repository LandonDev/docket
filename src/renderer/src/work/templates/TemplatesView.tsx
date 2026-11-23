import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import type { CanvasSource } from "@shared/work/canvas";
import type { Template } from "@shared/work/templates";
import { Briefcase, Copy, Eye, FilePlus, Layers, Minus, MoreHorizontal, Pencil, TextCursor, Trash2 } from "../../chrome/icons";
import { ConfirmDialog } from "../../chrome/ConfirmDialog";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { BusyLabel, Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { pickFiles } from "../../lib/fs";
import { getPathForFile } from "../../lib/native";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { WorkViewProps } from "../views/registry";
import { ViewStateLine } from "../views/ViewStateLine";
import { makeFrom, moveTemplate, removeTemplate, restoreFiles, saveTemplate, unhideStarters, useTemplates } from "./data";
import { baseName, hiddenLine, refusedLine, shelfGroups, tileMenu, type TileAction, type TileRow } from "./model";
import { askTemplateFields, openMade } from "./open";
import { RenameDialog } from "./RenameDialog";
import { Shelf, ShelfSkeleton } from "./Shelf";

/**
 * A Work workspace's Templates (docs/agents/work-templates.md "The Templates
 * view"): the shelf as a page. A press makes a new file, asking the fields
 * first when the template names some; a tile's menu edits, renames, moves and
 * removes. The header's Add… takes files from this computer onto the shelf,
 * and so does a file dropped on the view, which the view keeps (no thread
 * starts for it); one add runs at a time for a workspace, each file is tried,
 * and one message names those left out. Only a file on the workspace's own
 * host can be added: a window on another machine has no way yet to send one
 * there without a thread.
 */

// What the header shows of the view's state: how many starters are hidden, whether the shelf failed, and an Add in flight.
type HeadState = { hidden: number; failed: boolean; adding: boolean };
const heads = new Map<string, HeadState>();
const headListeners = new Set<() => void>();
const NONE: HeadState = { hidden: 0, failed: false, adding: false };
function setHead(workspaceId: string, next: Partial<HeadState>): void {
  const was = heads.get(workspaceId) ?? NONE;
  const now = { ...was, ...next };
  if (now.hidden === was.hidden && now.failed === was.failed && now.adding === was.adding) return;
  heads.set(workspaceId, now);
  for (const l of headListeners) l();
}
function useHead(workspaceId: string): HeadState {
  return useSyncExternalStore(
    (l) => (headListeners.add(l), () => headListeners.delete(l)),
    () => heads.get(workspaceId) ?? NONE,
    () => NONE,
  );
}

const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const failed = (err: unknown) => void loadToast().then((toast) => toast.error(words(err)));

/** A file to add: its name, and its path on this computer when it has one. */
type Incoming = { name: string; path: string | null };

/**
 * Files from this computer onto the shelf. One add at a time for a workspace,
 * whichever way it came (Add…, a drop); each file is tried, and one message
 * names every file left out, with why.
 */
export async function addFiles(env: string, workspaceId: string, files: readonly Incoming[]): Promise<void> {
  if (files.length === 0 || heads.get(workspaceId)?.adding) return;
  const refused: { name: string; why: string }[] = [];
  if (env !== registry.primary().environmentId) {
    const host = registry.environment(env)?.name ?? "the workspace's host";
    for (const f of files) refused.push({ name: f.name, why: `Only a file on ${host} can be added for now` });
  } else {
    setHead(workspaceId, { adding: true });
    try {
      for (const f of files) {
        if (!f.path) {
          refused.push({ name: f.name, why: "Only a file saved on this computer can be added" });
          continue;
        }
        try {
          await saveTemplate(env, workspaceId, { at: "file", host: env, path: f.path });
        } catch (err) {
          refused.push({ name: f.name, why: words(err) });
        }
      }
    } finally {
      setHead(workspaceId, { adding: false });
    }
  }
  const line = refusedLine(refused);
  if (line) void loadToast().then((toast) => toast.error(line.title, line.description ? { description: line.description } : undefined));
}

const pickAndAdd = async (env: string, workspaceId: string): Promise<void> => {
  if (heads.get(workspaceId)?.adding) return;
  const paths = await pickFiles("Add a template");
  if (paths) await addFiles(env, workspaceId, paths.map((path) => ({ name: baseName(path), path })));
};

export function Head({ env, workspace }: WorkViewProps) {
  const { hidden, failed: down, adding } = useHead(workspace.id);
  return (
    // Add… is the header's last control and never moves: the ⋯ for hidden starters arrives before it.
    <span className="flex items-center gap-1">
      {hidden > 0 && !down ? (
        <RowsMenu
          label="Templates"
          align="end"
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="More">
              <MoreHorizontal />
            </Button>
          }
          rows={[{ kind: "item", id: "unhide", label: "Show hidden", icon: Eye }]}
          onPick={() => void unhideStarters(env, workspace.id).catch(failed)}
        />
      ) : null}
      <Button variant="ghost" size="sm" disabled={adding || down} onClick={() => void pickAndAdd(env, workspace.id)}>
        <BusyLabel busy={adding} label="Add…" />
      </Button>
    </span>
  );
}

const GLYPH = { new: FilePlus, edit: Pencil, copy: Copy, rename: TextCursor, everywhere: Layers, job: Briefcase, delete: Trash2, hide: Minus } as const;
const menuRows = (rows: readonly TileRow[]): MenuRow[] =>
  rows.map((row) => (row.kind === "sep" ? row : { kind: "item", id: row.id, label: row.label, icon: GLYPH[row.glyph], ...(row.danger ? { danger: true } : {}) }));

const carriesFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");

function pathOf(file: File): string | null {
  try {
    return getPathForFile(file).trim() || null;
  } catch {
    return null;
  }
}

/** "It goes from every job on this computer." for a template of All jobs; nothing for one of this job. */
function deleteLine(template: Template, env: string): string | undefined {
  if (template.where !== "all") return undefined;
  const here = env === registry.primary().environmentId ? "this computer" : (registry.environment(env)?.name ?? "its host");
  return `It goes from every job on ${here}.`;
}

export function View({ env, workspace }: WorkViewProps) {
  const [load, retry] = useTemplates(env, workspace.id);
  const [making, setMaking] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Template | null>(null);
  const [removing, setRemoving] = useState<Template | null>(null);
  const [over, setOver] = useState(0);
  // A file made whose open failed, by template: a press again opens it and never makes a second.
  const made = useRef(new Map<string, { source: CanvasSource; title: string }>());
  // The header's ⋯ offers Show hidden over a shelf with tiles; an empty one offers it in its own state, once.
  const hidden = load.status === "ready" ? (load.value.templates.length ? load.value.hidden : 0) : null;
  const down = load.status === "error";
  useEffect(() => {
    setHead(workspace.id, { failed: down, ...(hidden !== null ? { hidden } : {}) });
  }, [workspace.id, hidden, down]);

  const open = (templateId: string, file: { source: CanvasSource; title: string }) =>
    openMade({ workspaceId: workspace.id, source: file.source }).then(
      () => void made.current.delete(templateId),
      (err: unknown) => {
        made.current.set(templateId, file);
        void loadToast().then((toast) =>
          toast.error(`${file.title} was made but did not open`, {
            description: words(err),
            action: { label: "Open", onClick: () => void open(templateId, file) },
          }),
        );
      },
    );

  const make = (t: Template) => {
    if (making) return;
    const kept = made.current.get(t.id);
    if (kept) return void open(t.id, kept);
    if (t.fields.length) {
      askTemplateFields({ workspaceId: workspace.id, template: t });
      return;
    }
    setMaking(t.id);
    makeFrom(env, workspace.id, t.id)
      .then(
        (file) => open(t.id, file),
        (err: unknown) => failed(err),
      )
      .finally(() => setMaking(null));
  };

  const remove = async (t: Template) => {
    const answer = await removeTemplate(env, workspace.id, t.id);
    const toast = await loadToast();
    // A starter is hidden: one press brings that one back.
    if (t.where === "starter") return void toast("Hidden", { action: { label: "Undo", onClick: () => void unhideStarters(env, workspace.id, t.id).catch(failed) } });
    // No Trash yet: nothing was deleted, and the host asks first.
    if (answer.confirm) return setRemoving(t);
    const trashed = answer.trashed;
    if (trashed?.length) toast("Moved to Trash", { action: { label: "Undo", onClick: () => void restoreFiles(env, workspace.id, trashed).catch(failed) } });
  };

  const act = (pick: string, t: Template) => {
    const action = pick as TileAction;
    if (action === "make") return make(t);
    if (action === "rename") return setRenaming(t);
    if (action === "move") return void moveTemplate(env, workspace.id, t.id, t.where === "job").catch(failed);
    if (action === "remove") return void remove(t).catch(failed);
    if (action === "edit") {
      // A starter is ours: Edit makes his own copy, which takes its place on the shelf, and opens that.
      const own = t.where === "starter" ? saveTemplate(env, workspace.id, t.source, { name: t.name }).then((saved) => saved.source) : Promise.resolve(t.source);
      void own.then((source) => openMade({ workspaceId: workspace.id, source })).catch(failed);
    }
  };

  // A file dropped here becomes a template: the view takes the drop, so no thread starts for it.
  const drop = {
    onDragEnter: (event: DragEvent) => {
      if (carriesFiles(event)) setOver((n) => n + 1);
    },
    onDragLeave: (event: DragEvent) => {
      if (carriesFiles(event)) setOver((n) => Math.max(0, n - 1));
    },
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setOver(0);
      void addFiles(env, workspace.id, Array.from(event.dataTransfer.files).map((f) => ({ name: f.name, path: pathOf(f) })));
    },
  };

  const groups = load.status === "ready" ? shelfGroups(load.value.templates, workspace.name) : [];
  const narrowed = load.status === "ready" ? hiddenLine(load.value.hidden) : null;
  return (
    <div data-templates-view="" className="relative min-h-full" {...drop}>
      {load.status === "loading" ? (
        <div className="px-4 pt-3 pb-6">
          <ShelfSkeleton layout="page" count={8} />
        </div>
      ) : load.status === "error" ? (
        <ViewStateLine word="Templates did not load" detail={load.error} onRetry={retry} />
      ) : groups.length === 0 ? (
        // Add… is the header's; an empty shelf he narrowed says so and offers the way back.
        <EmptyState
          title="No templates"
          {...(narrowed ? { line: narrowed, action: { label: "Show hidden", onClick: () => void unhideStarters(env, workspace.id).catch(failed) } } : {})}
        />
      ) : (
        <div className="px-4 pt-3 pb-6">
          <Shelf groups={groups} layout="page" making={making} onPress={make} menuFor={(t) => menuRows(tileMenu(t, workspace.name))} onMenu={act} />
        </div>
      )}
      {over > 0 ? (
        <div
          data-drop-wash=""
          className="pointer-events-none absolute inset-3 grid place-items-center rounded-lg border border-border bg-muted/70 transition-opacity duration-(--dur-fast) ease-(--ease-out) starting:opacity-0 motion-reduce:transition-none"
        >
          <span className="text-[13px] text-muted-foreground">Drop to add</span>
        </div>
      ) : null}
      {renaming ? <RenameDialog key={renaming.id} env={env} workspaceId={workspace.id} template={renaming} onClose={() => setRenaming(null)} /> : null}
      {removing ? (
        <ConfirmDialog
          title={`Delete “${removing.name}”?`}
          body={deleteLine(removing, env)}
          confirmLabel="Delete"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={async () => void (await removeTemplate(env, workspace.id, removing.id, true))}
          onDone={() => setRemoving(null)}
        />
      ) : null}
    </div>
  );
}
