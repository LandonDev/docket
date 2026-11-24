import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import type { CanvasSource } from "@shared/work/canvas";
import type { Template } from "@shared/work/templates";
import { Briefcase, Copy, Eye, FilePlus, Globe, Minus, MoreHorizontal, Pencil, TextCursor, Trash2 } from "../../chrome/icons";
import { ConfirmDialog } from "../../chrome/ConfirmDialog";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { TruncateTip } from "../../components/tip";
import { BusyLabel, Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { pickFiles } from "../../lib/fs";
import { getPathForFile } from "../../lib/native";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { WorkViewProps } from "../views/registry";
import { ViewStateLine } from "../views/ViewStateLine";
import { makeFrom, moveTemplate, removeTemplate, restoreFiles, saveTemplate, unhideStarters, useTemplates } from "./data";
import { baseName, editsACopy, hiddenLine, refusedLine, shelfGroups, tileMenu, unfilledLine, type TileAction, type TileRow } from "./model";
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

/** A file made, with the fields still in it as written. */
type MadeFile = { source: CanvasSource; title: string; unfilled: readonly string[] };

const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** One toast shape for every failed press on this page: what failed as its title, then why, in the host's words. */
const failed = (title: string) => (err: unknown) => void loadToast().then((toast) => toast.error(title, { description: words(err) }));

/** Why this window cannot add a file to the shelf: the workspace lives on another host. Null when it can. */
function farReason(env: string): string | null {
  if (env === registry.primary().environmentId) return null;
  return `Only a file on ${registry.environment(env)?.name ?? "the workspace's host"} can be added for now`;
}

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
  const far = farReason(env);
  if (far) {
    for (const f of files) refused.push({ name: f.name, why: far });
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
  // From another host's window the picker would only offer files that must then be refused: say why at once.
  const far = farReason(env);
  if (far) return void loadToast().then((toast) => toast.error(far));
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
          onPick={() => void unhideStarters(env, workspace.id).catch(failed("Starters were not shown"))}
        />
      ) : null}
      <Button variant="ghost" size="sm" disabled={adding || down} onClick={() => void pickAndAdd(env, workspace.id)}>
        <BusyLabel busy={adding} label="Add…" />
      </Button>
    </span>
  );
}

const GLYPH = { new: FilePlus, edit: Pencil, copy: Copy, rename: TextCursor, everywhere: Globe, job: Briefcase, delete: Trash2, hide: Minus } as const;
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
  // What he is asked to delete, with the file's version as the host saw it then: a file put in its place since is not deleted.
  const [removing, setRemoving] = useState<{ template: Template; version: string } | null>(null);
  const [over, setOver] = useState(0);
  const { adding } = useHead(workspace.id);
  // A file made whose open failed, by template: a press again opens it and never makes a second.
  const made = useRef(new Map<string, MadeFile>());
  // The header's ⋯ offers Show hidden over a shelf with tiles; an empty one offers it in its own state, once.
  const hidden = load.status === "ready" ? (load.value.templates.length ? load.value.hidden : 0) : null;
  const down = load.status === "error";
  useEffect(() => {
    setHead(workspace.id, { failed: down, ...(hidden !== null ? { hidden } : {}) });
  }, [workspace.id, hidden, down]);

  const open = (templateId: string, file: MadeFile) =>
    openMade({ workspaceId: workspace.id, source: file.source }).then(
      () => {
        made.current.delete(templateId);
        // Once it is open, the fields still in it as written, said once.
        const line = unfilledLine(file.unfilled);
        if (line) void loadToast().then((toast) => toast(line));
      },
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
        // What failed, then why, in the host's words: the open-failed toast names the file the same way.
        (err: unknown) => void loadToast().then((toast) => toast.error(`${t.name} was not made`, { description: words(err) })),
      )
      .finally(() => setMaking(null));
  };

  const remove = async (t: Template) => {
    const answer = await removeTemplate(env, workspace.id, t.id);
    const toast = await loadToast();
    // A starter is hidden: one press brings that one back.
    if (t.where === "starter") return void toast("Hidden", { action: { label: "Undo", onClick: () => void unhideStarters(env, workspace.id, t.id).catch(failed(`${t.name} was not shown`)) } });
    // No Trash yet: nothing was deleted, and the host asks first.
    if (answer.confirm) return setRemoving({ template: t, version: answer.version ?? "" });
    const trashed = answer.trashed;
    // Undo puts the file back through Files, then asks for the shelf again; a refusal says it in Files' words.
    if (trashed?.length)
      toast("Moved to Trash", { action: { label: "Undo", onClick: () => void restoreFiles(env, workspace.id, trashed).then(retry, failed("It was not put back")) } });
  };

  const act = (pick: string, t: Template) => {
    const action = pick as TileAction;
    if (action === "make") return make(t);
    if (action === "rename") return setRenaming(t);
    if (action === "move") return void moveTemplate(env, workspace.id, t.id, t.where === "job").catch(failed(`${t.name} was not moved`));
    if (action === "remove") return void remove(t).catch(failed(`${t.name} was not removed`));
    if (action === "edit") {
      // One at a time, the tile busy as a make's is: a second pick while the first runs does nothing.
      if (making) return;
      setMaking(t.id);
      // A starter, or one for all jobs (in the host's own data, which Files does not open): Edit a copy makes his own
      // for this job, which takes its place on the shelf, and opens that.
      const own = editsACopy(t)
        ? saveTemplate(env, workspace.id, t.source, { name: t.name }).then(
            (saved) => saved.source,
            (err: unknown) => {
              failed(`${t.name} was not copied`)(err);
              return null;
            },
          )
        : Promise.resolve(t.source);
      void own
        .then((source) => (source ? openMade({ workspaceId: workspace.id, source }).catch(failed(`${t.name} did not open`)) : undefined))
        .finally(() => setMaking(null));
    }
  };

  // A file dropped here becomes a template: the view takes the drop, so no thread starts for it.
  // While an add runs, or from a window away from the workspace's host, it refuses a drop where he can see it:
  // no wash, no copy cursor, and the drop itself is kept and does nothing.
  const refuses = adding || farReason(env) !== null;
  const drop = {
    onDragEnter: (event: DragEvent) => {
      if (carriesFiles(event) && !refuses) setOver((n) => n + 1);
    },
    onDragLeave: (event: DragEvent) => {
      if (carriesFiles(event)) setOver((n) => Math.max(0, n - 1));
    },
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Kept from the document's drop either way, which would start a thread.
      event.preventDefault();
      event.dataTransfer.dropEffect = refuses ? "none" : "copy";
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setOver(0);
      if (refuses) return;
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
        // The shared line cuts its detail to one line; while it is cut, the whole of it is the line's tip.
        <TruncateTip text={load.error}>
          <div data-state-tip="">
            <ViewStateLine word="Templates did not load" detail={load.error} onRetry={retry} />
          </div>
        </TruncateTip>
      ) : groups.length === 0 ? (
        // Add… is the header's; an empty shelf he narrowed says so and offers the way back.
        <EmptyState
          title="No templates"
          {...(narrowed ? { line: narrowed, action: { label: "Show hidden", onClick: () => void unhideStarters(env, workspace.id).catch(failed("Starters were not shown")) } } : {})}
        />
      ) : (
        <div className="px-4 pt-3 pb-6">
          <Shelf groups={groups} layout="page" making={making} onPress={make} menuFor={(t) => menuRows(tileMenu(t, workspace.name))} onMenu={act} />
        </div>
      )}
      {over > 0 && !refuses ? (
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
          title={`Delete “${removing.template.name}”?`}
          body={deleteLine(removing.template, env)}
          confirmLabel="Delete"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={async () => void (await removeTemplate(env, workspace.id, removing.template.id, removing.version))}
          onDone={() => setRemoving(null)}
        />
      ) : null}
    </div>
  );
}
