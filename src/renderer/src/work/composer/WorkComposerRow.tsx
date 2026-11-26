import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { loadToast } from "../../components/ui/toaster";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { ROW_CONTROL } from "../../chrome/composerRow";
import { Check, ChevronDown, ChevronRight, SlidersHorizontal } from "../../chrome/icons";
import { ModelPicker } from "../../chrome/ModelPicker";
import { ROW_SELECT_TRIGGER } from "../../chrome/ModelSettings";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { cn } from "../../lib/cn";
import { registry } from "../../lib/connection";
import { OPEN_MODEL_PICKER } from "../../lib/modelPickerSignal";
import { modOrCtrl } from "../../lib/keys";
import type { DraftPlace } from "../../lib/projectDrafts";
import { PICKER_RUNTIME_MODES, shownRuntimeMode, type HarnessId, type RuntimeMode } from "../../lib/session";
import { sessionStore } from "../../lib/tcserver/store";
import type { ThreadType, WorkspaceMeta } from "../../lib/tcserver/types";
import { useWorkspaceCatalog } from "../../lib/tcserver/workspaces";
import { workErrorWords } from "../../lib/workErrorWords";
import { useLifeosProjects } from "../../lib/workSwitch";
import { THREAD_LABELS, WORK_THREAD_TYPES } from "../../surfaces/threads/threadTypes";
import { WORK_PROVIDERS } from "@shared/work/providers";
import { openLifeosProject } from "../shell/actions";
import { useColumnProjects } from "../shell/columnProjects";
import { WORK_ACCESS_HINT, WORK_ACCESS_HOLD, WORK_ACCESS_LABEL } from "./access";
import { filingOf, jobLabel, placeOf, type FilingProject } from "./filing";

/**
 * The row under a Work thread's or Work draft's box (docs/DESIGN.md "A Work draft"), in the code row's place and
 * size: 24px, 4px under the box, its edges the box row's. A draft's filing control at the left (job › project ▾);
 * one settings glyph at the right, whose popover holds Chat or Research (a draft), the model among Work's providers
 * and access in Work's words. No context meter, no type picker, no Master thread, no name field.
 */
export type WorkComposerRowProps = {
  sessionId?: string;
  /** Unsent, and the place does not decide where it files (the Files dock does): the filing control shows. */
  draft: boolean;
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
  environmentId: string;
  hotkeys: boolean;
  threadType?: ThreadType | null;
  onThreadTypeChange?: (type: ThreadType) => void;
  onModelChange: (harness: HarnessId, model: string) => void;
  onModelSettingsChange: (settings: Record<string, string>) => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  /** Files the unsent draft elsewhere; absent where nothing can move it. */
  onFile?: (to: DraftPlace) => void;
  /** Runs before a move: the composer writes what the field holds now into the draft's record. */
  beforeFile?: () => void;
  /** The composer's field: a filing pick hands the caret back to it. */
  fieldOf: () => HTMLElement | null;
  /** Told true while a pick waits on its project's mirror, false once the move lands or fails: Send waits for it. */
  onFiling?: (busy: boolean) => void;
};

export function WorkComposerRow(props: WorkComposerRowProps) {
  const { sessionId, draft, onFile } = props;
  return (
    <div data-composer-bar data-work-row className="@container/composer-bar mt-1 flex h-6 min-w-0 items-center gap-1 px-1.5">
      {draft && sessionId && onFile ? <FilingControl sessionId={sessionId} onFile={onFile} beforeFile={props.beforeFile} fieldOf={props.fieldOf} onFiling={props.onFiling} /> : null}
      <div className="ms-auto flex shrink-0 items-center">
        <WorkSettings {...props} />
      </div>
    </div>
  );
}

const hostName = (environmentId: string): string => registry.environments().find((e) => e.id === environmentId)?.name ?? environmentId;

/** A mirror that did not open, in plain words; the draft still files where the control shows. */
const sayNotOpened = (name: string, error: unknown, host: string): void =>
  void loadToast().then((toast) => toast.error(`Couldn't file it under ${name}`, { description: workErrorWords(error, { host, write: true }) || undefined }));

const draftWhere = (id: string) => {
  const s = sessionStore.get(id);
  return `${s?.workspaceId ?? ""}\n${s?.projectId ?? ""}`;
};

function FilingControl({
  sessionId,
  onFile,
  beforeFile,
  fieldOf,
  onFiling,
}: {
  sessionId: string;
  onFile: (to: DraftPlace) => void;
  beforeFile?: () => void;
  fieldOf: () => HTMLElement | null;
  onFiling?: (busy: boolean) => void;
}) {
  // One string of the two ids, so a push that moves anything else renders nothing here.
  const where = useSyncExternalStore(sessionStore.subscribe, () => draftWhere(sessionId));
  const [workspaceId, projectId] = where.split("\n");
  const { workspaces, projects: catalog } = useWorkspaceCatalog();
  const jobRow = workspaces.find((w) => w.id === workspaceId && w.kind === "work");
  const lifeos = useLifeosProjects(jobRow?.sector ? jobRow.id : null);
  // The targets the column sorts by, where its head keeps them; the menu lists the projects in the column's order.
  const targets = useColumnProjects(jobRow?.id ?? "");
  const filing = filingOf({ workspaceId: workspaceId || null, projectId: projectId || null }, workspaces, catalog, lifeos, targets);
  const { job, project } = filing;
  // A LifeOS project with no mirror yet is made at the pick (`work.project.open`, as the column does): its name shows,
  // with a spinner after the control, until the mirror lands; Send waits until the move lands or fails.
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => {
    if (!opening || !onFiling) return;
    onFiling(true);
    return () => onFiling(false);
  }, [opening, onFiling]);

  // A filing picked hands the caret to the field (a Work draft goes on being written); Escape gives the button its focus back.
  const picked = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const file = (to: DraftPlace) => {
    picked.current = true;
    beforeFile?.();
    onFile(to);
  };
  const pickProject = (p: FilingProject | null) => {
    if (!job) return;
    picked.current = true;
    if (!p) return file(placeOf(job, null));
    if (!p.card || !p.lifeosProjectId) return file(placeOf(job, p.id));
    setOpening(p.name);
    void openLifeosProject(job, p.lifeosProjectId, p.name)
      .then(
        (mirror) => file(placeOf(job, mirror.id)),
        (error) => sayNotOpened(p.name, error, hostName(job.environmentId)),
      )
      .finally(() => setOpening(null));
  };

  const label = job ? jobLabel(job, workspaces, hostName) : "Work Chats";
  const shownProject = opening ?? project?.name ?? null;
  return (
    <DropdownMenu onOpenChange={(open) => void (open && (picked.current = false))}>
      <DropdownMenuTrigger
        render={
          <Button
            ref={trigger}
            variant="ghost"
            size="xs"
            data-filing
            aria-label={`Files in ${label}${shownProject ? `, ${shownProject}` : ""}`}
            disabled={!!opening}
            className={cn("min-w-0 shrink gap-0 px-2 disabled:opacity-100", ROW_CONTROL)}
          />
        }
      >
        {job ? <SectorDot sector={job.sector} className="size-3.5" /> : null}
        <span className={cn("min-w-0 truncate", job && "ms-1")}>{label}</span>
        {shownProject ? (
          <>
            <ChevronRight aria-hidden className="mx-1 size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{shownProject}</span>
          </>
        ) : null}
        <ChevronDown aria-hidden className="ms-2 size-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      {opening ? <Spinner role="status" aria-label={`Opening ${opening}`} className="size-3 text-muted-foreground" /> : null}
      <DropdownMenuContent side="top" align="start" finalFocus={() => (picked.current ? fieldOf() : trigger.current)} className="w-60" aria-label="Where it files">
        {job ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="truncate">{label}</DropdownMenuLabel>
              {filing.projects.map((p) => (
                <FilingItem key={p.id} checked={p.id === project?.id} onClick={() => pickProject(p)}>
                  {p.name}
                </FilingItem>
              ))}
              <FilingItem checked={!project} onClick={() => pickProject(null)}>
                No project
              </FilingItem>
            </DropdownMenuGroup>
            {filing.others.length ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Another job</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56" aria-label="Another job">
                    <JobItems jobs={filing.others} all={workspaces} onPick={(w) => file(placeOf(w, null))} />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            ) : null}
          </>
        ) : (
          <DropdownMenuGroup>
            <DropdownMenuLabel>File in a job</DropdownMenuLabel>
            <JobItems jobs={filing.others} all={workspaces} onPick={(w) => file(placeOf(w, null))} />
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilingItem({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <DropdownMenuItem data-checked={checked || undefined} onClick={onClick}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked ? <Check aria-hidden className="ms-auto size-3.5" /> : null}
    </DropdownMenuItem>
  );
}

function JobItems({ jobs, all, onPick }: { jobs: readonly WorkspaceMeta[]; all: readonly WorkspaceMeta[]; onPick: (job: WorkspaceMeta) => void }) {
  return jobs.map((w) => (
    <DropdownMenuItem key={w.id} onClick={() => onPick(w)}>
      <SectorDot sector={w.sector} className="-ms-0.5 size-3.5" />
      <span className="min-w-0 flex-1 truncate">{jobLabel(w, all, hostName)}</span>
    </DropdownMenuItem>
  ));
}

const ACCESS_ITEMS = PICKER_RUNTIME_MODES.map((mode) => ({ value: mode, label: WORK_ACCESS_LABEL[mode] }));

function WorkSettings({
  draft,
  harness,
  model,
  modelSettings,
  runtimeMode,
  environmentId,
  hotkeys,
  threadType,
  onThreadTypeChange,
  onModelChange,
  onModelSettingsChange,
  onRuntimeModeChange,
}: WorkComposerRowProps) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const typed = draft && !!threadType && !!onThreadTypeChange && WORK_THREAD_TYPES.includes(threadType);
  const access = shownRuntimeMode(runtimeMode);

  // The model picker lives in this popover, so ⌘. and a failure card's "Continue on another model" open the
  // popover first, then ask the picker inside it, as they would ask the code row's.
  useEffect(() => {
    if (!hotkeys) return;
    const ask = (event: Event) => {
      setOpen(true);
      requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(event)));
    };
    const onKey = (e: KeyboardEvent) => {
      if (openRef.current || e.isComposing || !modOrCtrl(e) || e.altKey || e.shiftKey) return;
      if (e.key !== "." && e.code !== "Period") return;
      e.preventDefault();
      e.stopPropagation();
      ask(new Event("open_model_picker"));
    };
    const onRequest = (event: Event) => {
      if (openRef.current) return;
      const detail = (event as CustomEvent).detail;
      ask(new CustomEvent(OPEN_MODEL_PICKER, { detail }));
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(OPEN_MODEL_PICKER, onRequest);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(OPEN_MODEL_PICKER, onRequest);
    };
  }, [hotkeys]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label="Thread settings" data-work-settings-trigger className={cn("size-6", ROW_CONTROL)} />}
            />
          }
        >
          <SlidersHorizontal className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>Thread settings</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" data-work-settings aria-label="Thread settings" className="w-72 gap-0 p-1">
        {typed ? (
          <ToggleGroup
            spacing={0}
            size="sm"
            aria-label="Thread type"
            value={[threadType]}
            onValueChange={(next: unknown[]) => {
              const type = next[0] as ThreadType | undefined;
              if (type && type !== threadType) onThreadTypeChange?.(type);
            }}
            className="mb-1 w-full"
          >
            {WORK_THREAD_TYPES.map((type) => (
              <ToggleGroupItem key={type} value={type} className="flex-1">
                {THREAD_LABELS[type]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
        <SettingRow label="Model">
          <ModelPicker
            harness={harness}
            model={model}
            environmentId={environmentId}
            hotkeys={hotkeys && open}
            providers={WORK_PROVIDERS as readonly HarnessId[]}
            onChange={onModelChange}
            settings={{ values: modelSettings, onChange: onModelSettingsChange }}
          />
        </SettingRow>
        {harness !== "fx" ? (
          <SettingRow label="Access">
            <Select
              items={ACCESS_ITEMS}
              value={access}
              onValueChange={(next) => {
                if (next !== null && next !== access) onRuntimeModeChange(next as RuntimeMode);
              }}
            >
              <SelectTrigger size="sm" aria-label={`Access: ${WORK_ACCESS_LABEL[access]}`} className={ROW_SELECT_TRIGGER}>
                <SelectValue>{WORK_ACCESS_LABEL[access]}</SelectValue>
              </SelectTrigger>
              <SelectContent side="top" align="end" alignItemWithTrigger={false} data-access-picker className="w-72 p-1">
                {PICKER_RUNTIME_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode} label={WORK_ACCESS_LABEL[mode]} className="items-start py-1.5">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span>{WORK_ACCESS_LABEL[mode]}</span>
                      <span className="whitespace-normal text-xs text-muted-foreground">{WORK_ACCESS_HINT[mode]}</span>
                    </span>
                  </SelectItem>
                ))}
                <p data-access-hold className="px-2 pt-2 pb-1.5 text-xs text-muted-foreground">
                  {WORK_ACCESS_HOLD}
                </p>
              </SelectContent>
            </Select>
          </SettingRow>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** One of the popover's rows, as the model menu's foot draws them (ModelSettings `SettingRow`). */
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-2 ps-3 pe-1">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="ms-auto flex min-w-0 items-center">{children}</span>
    </div>
  );
}
