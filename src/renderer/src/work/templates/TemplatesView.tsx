import { useEffect, useState, useSyncExternalStore, type DragEvent } from "react";
import type { Template } from "@shared/work/templates";
import { MoreHorizontal } from "../../chrome/icons";
import { ConfirmDialog } from "../../chrome/ConfirmDialog";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { BusyLabel, Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { pickFiles } from "../../lib/fs";
import { getPathForFile } from "../../lib/native";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { WorkViewProps } from "../views/registry";
import { makeFrom, moveTemplate, removeTemplate, restoreFiles, saveTemplate, unhideStarters, useTemplates } from "./data";
import { shelfGroups, tileMenu, type TileAction } from "./model";
import { askTemplateFields, openMade } from "./open";
import { RenameDialog } from "./RenameDialog";
import { Shelf, ShelfSkeleton } from "./Shelf";

/**
 * A Work workspace's Templates (docs/agents/work-templates.md "The Templates
 * view"): the shelf as a page. A press makes a new file, asking the fields
 * first when the template names some; a tile's menu edits, renames, moves and
 * removes. The header's Add… takes a file from this computer onto the shelf,
 * and so does a file dropped on the view, which the view keeps (no thread
 * starts for it). Only a file on the workspace's own host can be added: a
 * window on another machine has no way yet to send one there without a thread.
 */

// What the header shows of the view's state: how many starters are hidden, and an Add in flight.
type HeadState = { hidden: number; adding: boolean };
const heads = new Map<string, HeadState>();
const headListeners = new Set<() => void>();
const NONE: HeadState = { hidden: 0, adding: false };
function setHead(workspaceId: string, next: Partial<HeadState>): void {
  const was = heads.get(workspaceId) ?? NONE;
  const now = { ...was, ...next };
  if (now.hidden === was.hidden && now.adding === was.adding) return;
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

const failed = (err: unknown) => void loadToast().then((toast) => toast.error(err instanceof Error ? err.message : String(err)));

/** Files from this computer onto the shelf, one after another; a refusal is a toast in the host's words. */
async function addFiles(env: string, workspaceId: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  if (env !== registry.primary().environmentId) {
    const host = registry.environment(env)?.name ?? "the workspace's host";
    return failed(new Error(`Only a file on ${host} can be added for now`));
  }
  setHead(workspaceId, { adding: true });
  try {
    for (const path of paths) await saveTemplate(env, workspaceId, { at: "file", host: env, path });
  } catch (err) {
    failed(err);
  } finally {
    setHead(workspaceId, { adding: false });
  }
}

const pickAndAdd = async (env: string, workspaceId: string): Promise<void> => {
  const paths = await pickFiles("Add a template");
  if (paths) await addFiles(env, workspaceId, paths);
};

export function Head({ env, workspace }: WorkViewProps) {
  const { hidden, adding } = useHead(workspace.id);
  return (
    <span className="flex items-center gap-1">
      <Button variant="ghost" size="sm" disabled={adding} onClick={() => void pickAndAdd(env, workspace.id)}>
        <BusyLabel busy={adding} label="Add…" />
      </Button>
      {hidden > 0 ? (
        <RowsMenu
          label="Templates"
          align="end"
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="More">
              <MoreHorizontal />
            </Button>
          }
          rows={[{ kind: "item", id: "unhide", label: "Show hidden" }]}
          onPick={() => void unhideStarters(env, workspace.id).catch(failed)}
        />
      ) : null}
    </span>
  );
}

const carriesFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");

function pathOf(file: File): string | null {
  try {
    return getPathForFile(file).trim() || null;
  } catch {
    return null;
  }
}

export function View({ env, workspace }: WorkViewProps) {
  const [load, retry] = useTemplates(env, workspace.id);
  const [making, setMaking] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Template | null>(null);
  const [removing, setRemoving] = useState<Template | null>(null);
  const [over, setOver] = useState(0);
  const hidden = load.status === "ready" ? load.value.hidden : null;
  useEffect(() => {
    if (hidden !== null) setHead(workspace.id, { hidden });
  }, [workspace.id, hidden]);

  const make = (t: Template) => {
    if (making) return;
    if (t.fields.length) {
      askTemplateFields({ workspaceId: workspace.id, template: t });
      return;
    }
    setMaking(t.id);
    makeFrom(env, workspace.id, t.id)
      .then((made) => openMade({ workspaceId: workspace.id, source: made.source }))
      .catch(failed)
      .finally(() => setMaking(null));
  };

  const remove = async (t: Template) => {
    const answer = await removeTemplate(env, workspace.id, t.id);
    // No Trash yet: nothing was deleted, and the host asks first.
    if (answer.confirm) return setRemoving(t);
    const trashed = answer.trashed;
    if (trashed?.length)
      void loadToast().then((toast) => toast("Moved to Trash", { action: { label: "Undo", onClick: () => void restoreFiles(env, workspace.id, trashed).catch(failed) } }));
  };

  const act = (pick: string, t: Template) => {
    const action = pick as TileAction;
    if (action === "make") return make(t);
    if (action === "rename") return setRenaming(t);
    if (action === "move") return void moveTemplate(env, workspace.id, t.id, t.where === "job").catch(failed);
    if (action === "remove") return void remove(t).catch(failed);
    if (action === "edit") {
      // A starter is ours: Edit makes his own copy and opens that.
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
      const files = Array.from(event.dataTransfer.files);
      const paths = files.map(pathOf).filter((p): p is string => p !== null);
      if (paths.length < files.length) failed(new Error("Only a file saved on this computer can be added"));
      void addFiles(env, workspace.id, paths);
    },
  };

  const groups = load.status === "ready" ? shelfGroups(load.value.templates, workspace.name) : [];
  return (
    <div data-templates-view="" className="relative min-h-full" {...drop}>
      {load.status === "loading" ? (
        <div className="px-4 pt-3 pb-6">
          <ShelfSkeleton layout="page" count={8} />
        </div>
      ) : load.status === "error" ? (
        <EmptyState title="Templates did not load" line={load.error} action={{ label: "Retry", onClick: retry }} />
      ) : groups.length === 0 ? (
        <EmptyState title="No templates" action={{ label: "Add…", onClick: () => void pickAndAdd(env, workspace.id) }} />
      ) : (
        <div className="px-4 pt-3 pb-6">
          <Shelf
            groups={groups}
            layout="page"
            making={making}
            onPress={make}
            menuFor={(t): MenuRow[] => tileMenu(t, workspace.name).map((row) => ({ kind: "item", ...row }))}
            onMenu={act}
          />
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
          title={`Remove ${removing.name}?`}
          body="Its file is deleted."
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={async () => void (await removeTemplate(env, workspace.id, removing.id, true))}
          onDone={() => setRemoving(null)}
        />
      ) : null}
    </div>
  );
}
