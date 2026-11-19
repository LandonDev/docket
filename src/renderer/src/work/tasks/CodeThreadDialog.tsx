import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ContextChip } from "@shared/work";
import { DialogFooter } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Search } from "../../chrome/icons";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { PickerNote } from "../../chrome/PickerDialog";
import { WorkspaceGlyph, workspaceLook } from "../../chrome/WorkspaceGlyph";
import { ChoiceSelect } from "../../components/choice-select";
import { GroupInput, InputGroup } from "../../components/ui/input";
import { MENU_ROW } from "../../components/ui/menu-row";
import { ROW_PRESS } from "../../components/ui/press";
import { useLockOverscroll } from "../../hooks/useLockOverscroll";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../lib/connection/status";
import { aliasKeys, mergeRailSections, splitWorkRows } from "../../lib/linkedRail";
import { loadPinnedProjects, loadProjectRailOrder, projectRailSections } from "../../lib/recents";
import { useWorkspaceCatalog } from "../../lib/tcserver/workspaces";
import { useWorkHosts } from "../../lib/workSwitch";
import { useRailRecents } from "../../stores/project";
import type { Task } from "./client";
import { codeThreadChip, codeWorkspaces, pickedProject, type CodeWorkspace } from "./codeThread";

/**
 * Open a code thread… on a task: pick a code workspace, as the rail lists
 * it, and optionally a project in it; Start opens a new thread's composer
 * there with the task as its chip, and the host links the thread to the
 * task once it is sent. What the thread reads of the task follows the
 * workspace's own LifeOS link (codeThreadChip).
 */

type Detail = { task: { description?: string } } | null;
const get = makeFunctionReference<"query">("tasks:get");

export type CodeThreadStart = (about: ContextChip, at: { cwd: string; projectId: string | null }) => void;

export function CodeThreadDialog({ task, sector, onStart, onClose }: { task: Task; sector: string | null; onStart: CodeThreadStart; onClose: () => void }) {
  return (
    <Modal onClose={onClose} title="Open a code thread" description={task.title} size="sm">
      <Body task={task} sector={sector} onStart={onStart} onClose={onClose} />
    </Modal>
  );
}

/** The rail's code rows, joined across hosts, in its order. */
function useCodeWorkspaces(): CodeWorkspace[] {
  const recents = useRailRecents();
  const { workspaces, projects } = useWorkspaceCatalog();
  const workHosts = useWorkHosts();
  return useMemo(() => {
    const rows = splitWorkRows(mergeRailSections(projectRailSections(recents, null, loadProjectRailOrder(), loadPinnedProjects()), workspaces), workspaces, false);
    return codeWorkspaces([...rows.pinned, ...rows.projects], workspaces, projects, workHosts);
  }, [recents, workspaces, projects, workHosts]);
}

function Body({ task, sector, onStart, onClose }: { task: Task; sector: string | null; onStart: CodeThreadStart; onClose: () => void }) {
  const close = useModalClose();
  const all = useCodeWorkspaces();
  const detail = useQuery(get, { id: task._id }) as Detail | undefined;
  const [query, setQuery] = useState("");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [projectPick, setProjectPick] = useState("");
  // Start pressed before the notes came: it goes once they do, the verb spinning.
  const [waiting, setWaiting] = useState(false);
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return words ? all.filter((w) => w.name.toLowerCase().includes(words)) : all;
  }, [all, query]);
  // The pick stays while it is listed; otherwise the first row is the pick.
  const chosen = shown.find((w) => w.id === chosenId) ?? shown[0] ?? null;
  // A project belongs to the workspace it was picked in: a pick that moves (a search) drops it.
  const projectId = pickedProject(chosen, projectPick);
  const reads = sector !== null && chosen?.sector === sector;
  const choose = (w: CodeWorkspace) => setChosenId(w.id);
  const start = () => {
    if (!chosen) return;
    // A workspace that cannot read LifeOS is handed the notes: Start waits for them.
    if (!reads && detail === undefined) return setWaiting(true);
    onStart(codeThreadChip(task, detail?.task.description, reads), { cwd: chosen.path, projectId: projectId || null });
    close ? close(onClose) : onClose();
  };
  const go = useRef(start);
  go.current = start;
  useEffect(() => {
    if (waiting && detail !== undefined) go.current();
  }, [waiting, detail]);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!shown.length) return;
    const at = chosen ? shown.indexOf(chosen) : -1;
    choose(shown[Math.min(shown.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]!);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <ModalBody>
        <div className="flex min-w-0 flex-col gap-1">
          <InputGroup leading={<Search className="size-3.5" />}>
            <GroupInput
              autoFocus
              value={query}
              placeholder="Find a workspace"
              aria-label="Workspace"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
            />
          </InputGroup>
          <WorkspaceList rows={shown} chosen={chosen} onChoose={choose} empty={all.length ? "No workspace matches" : "No code workspace on a host with Work on"} />
        </div>
        {chosen?.projects.length ? (
          <Field label="Project">
            <ChoiceSelect label="Project" value={projectId} onChange={setProjectPick} options={[{ value: "", label: "None" }, ...chosen.projects.map((p) => ({ value: p.id, label: p.name }))]} />
          </Field>
        ) : null}
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Start" pending={waiting} disabled={!chosen} />
    </form>
  );
}

function WorkspaceList({ rows, chosen, onChoose, empty }: { rows: CodeWorkspace[]; chosen: CodeWorkspace | null; onChoose: (w: CodeWorkspace) => void; empty: string }) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  // The pick is the list's one highlight, moved by a click or the arrows; the arrows bring it into view.
  const pickRef = useRef<HTMLDivElement>(null);
  useEffect(() => pickRef.current?.scrollIntoView({ block: "nearest" }), [chosen]);
  const { workspaces } = useWorkspaceCatalog();
  const environments = useEnvironments();
  const keyOf = useMemo(() => aliasKeys(workspaces).workspaceId, [workspaces]);
  // A host's name only where two rows share a name: otherwise it says nothing new.
  const hostOf = (w: CodeWorkspace): string | null =>
    rows.some((o) => o !== w && o.name === w.name) ? (environments.find((e) => e.id === w.environmentId)?.name ?? null) : null;
  if (!rows.length) return <PickerNote>{empty}</PickerNote>;
  return (
    <div
      ref={lockOverscroll}
      role="listbox"
      aria-label="Workspaces"
      className="max-h-[196px] overflow-x-hidden overflow-y-auto overscroll-none [--scrollbar-inset:var(--radius-lg)]"
    >
      {rows.map((w) => {
        const picked = w === chosen;
        const key = keyOf(w.id);
        const look = workspaceLook(key);
        const host = hostOf(w);
        return (
          <div
            key={w.id}
            ref={picked ? pickRef : undefined}
            role="option"
            aria-selected={picked}
            data-workspace={w.id}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChoose(w)}
            className={cn("flex w-full cursor-default items-center rounded-lg text-left", MENU_ROW, picked ? "bg-muted" : ROW_PRESS)}
          >
            <WorkspaceGlyph logoPath={look.logoPath} mascotName={look.mascotName} color={look.color} projectKey={key} workspaceId={w.id} className="size-3.5 shrink-0" mascotClassName="size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{w.name}</span>
            {host ? <span className="shrink-0 text-xs text-muted-foreground">{host}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
