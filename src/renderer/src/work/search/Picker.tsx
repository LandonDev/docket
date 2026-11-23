import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { searchLabel, type SearchHit } from "@shared/work/search";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { ChevronDown, Clock, Layers, MessageMultiple, MessageSquare, Outbox, type IconComponent } from "../../chrome/icons";
import { MatchText } from "../../chrome/MatchText";
import { RowsContextMenu, RowsMenu, type MenuIcon, type MenuRow } from "../../chrome/menuRows";
import { PickerDialog, PickerNote, pickerRowClass } from "../../chrome/PickerDialog";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { loadToast } from "../../components/ui/toaster";
import { useLockOverscroll } from "../../hooks/useLockOverscroll";
import { usePointerHighlight } from "../../hooks/usePointerHighlight";
import { cn } from "../../lib/cn";
import { modOrCtrl } from "../../lib/keys";
import { shortcutFor } from "../../lib/settings";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { isBareSeed, onWorkSearch, openWorkSearch, type WorkSearchSeed } from "../../lib/workSearchPort";
import { useWorkHosts } from "../../lib/workSwitch";
import { useSelectedWorkspaceIds } from "../../stores/project";
import { Calendar, Card, Chat, Cloud, Doc, Mail, Person, Project, Table, Task } from "../icons";
import { liveDeps, SearchController } from "./controller";
import { holdStill } from "./hold";
import { askHost, jobOfWorkspace, jobsOf, searchHosts, type Job } from "./hosts";
import { activeOf, busy, isOption, rowsOf, type Option, type Row } from "./model";
import { canStartAbout, openHit, startAbout } from "./open";
import { factOf, timeOf } from "./words";

/**
 * Work search (docs/DESIGN.md "Work search"; docs/agents/work-search.md):
 * one field over everything in Work, in the Go to File shell. The list is
 * the model's rows (model.ts) and nothing here decides their order.
 */

const GLYPH: Record<string, IconComponent> = {
  person: Person,
  mail: Mail,
  message: Chat,
  chat: MessageMultiple,
  task: Task,
  event: Calendar,
  doc: Doc,
  project: Project,
  thread: MessageSquare,
  item: Layers,
  held: Outbox,
  routine: Clock,
  card: Card,
  // a ledger's row: the ledger is a sheet
  money: Table,
};

/** A sector's dot as a menu row's glyph, one stable component a sector. */
const DOTS = new Map<string, MenuIcon>();
function dotIcon(sector: string | null): MenuIcon {
  const key = sector ?? "none";
  let icon = DOTS.get(key);
  if (!icon) {
    icon = function Dot() {
      return <SectorDot sector={sector} className="-mx-px" />;
    };
    DOTS.set(key, icon);
  }
  return icon;
}

const ALL_JOBS = "all";
/** The list's cap where the page gives no measure (a test): the class below says the same. */
const LIST_CAP = 380;

export function WorkSearch({ seed, onClose }: { seed: WorkSearchSeed; onClose: () => void }) {
  const search = useRef<HTMLInputElement>(null);
  const workspaces = useWorkspaces();
  const workHosts = useWorkHosts();
  const jobs = useMemo(() => jobsOf(workspaces), [workspaces]);
  const windowIds = useSelectedWorkspaceIds();
  const windowJob = useMemo(() => jobs.find((job) => windowIds?.some((id) => job.ids.includes(id))) ?? null, [jobs, windowIds]);

  const [query, setQuery] = useState(seed.text ?? "");
  const [kind, setKind] = useState<string | null>(seed.kind ?? null);
  // All jobs on every open, unless the screen that opened it named one.
  const [jobKey, setJobKey] = useState<string | null>(() => jobOfWorkspace(jobs, seed.workspaceId)?.key ?? null);
  const job = jobs.find((j) => j.key === jobKey) ?? null;
  const [scopeOpen, setScopeOpen] = useState(false);

  const [controller] = useState(() => new SearchController(liveDeps(askHost)));
  const model = useSyncExternalStore(controller.subscribe, controller.read, controller.read);
  useEffect(() => () => controller.close(), [controller]);
  useEffect(() => {
    const { hosts, offline } = searchHosts(job, { workspaces: () => workspaces });
    controller.search(query, kind, hosts, offline);
    // The hosts follow the Work switches and the catalog; a job is its key.
  }, [controller, query, kind, job?.key, workHosts, workspaces]);

  // The search key pressed again: all jobs, or the job the window is in. With no job to narrow to, the menu.
  const flip = (): void => {
    if (jobs.length < 2) return;
    if (jobKey !== null) setJobKey(null);
    else if (windowJob) setJobKey(windowJob.key);
    else setScopeOpen(true);
  };
  // The key reaches here through the door, whichever way it came (the field below, the menu's accelerator through App).
  const flipNow = useRef(flip);
  flipNow.current = flip;
  useEffect(() => onWorkSearch((asked) => (isBareSeed(asked) ? flipNow.current() : undefined)), []);

  const rows = useMemo(() => rowsOf(model, { scoped: job !== null }), [model, job]);
  const options = useMemo(() => rows.filter(isOption), [rows]);
  const active = activeOf(model, rows);
  const mixed = job === null && jobs.length > 1;
  const jobOf = (hit: SearchHit): Job | null => jobOfWorkspace(jobs, hit.workspaceId);

  const take = (row: Option, o: { thread?: boolean } = {}): void => {
    if (row.type === "all") return setKind(row.kind);
    if (row.type === "widen") return setJobKey(null);
    if (o.thread) {
      if (startAbout(row.hit)) onClose();
      return;
    }
    onClose();
    void openHit(row.hit, row.host).then(async (result) => {
      if (result === "opened") return;
      const toast = await loadToast();
      toast.error(result === "gone" ? "That job is no longer here" : `Couldn't open ${row.hit.title}`);
    });
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      controller.step(rows, e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = options.find((option) => option.id === active);
      if (row) take(row, { thread: modOrCtrl(e) });
      return;
    }
    // The key in the field goes out by the door, as the menu's accelerator does: one press, one flip.
    if (modOrCtrl(e) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openWorkSearch();
      return;
    }
    // The kind stands before his words like a word of them: Backspace at the field's start takes it away.
    if (e.key === "Backspace" && kind && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      e.preventDefault();
      setKind(null);
      return;
    }
    if (e.key === "Tab") e.preventDefault();
  };

  return (
    <PickerDialog
      label="Search Work"
      data-work-search
      search={search}
      query={query}
      onQuery={setQuery}
      onSearchKey={onSearchKey}
      // Escape steps out of one kind first; a second Escape closes.
      onClose={(reason) => (reason === "escape-key" && kind ? setKind(null) : onClose())}
      leading={kind ? searchLabel(kind) : undefined}
      trailing={
        <FieldEnd
          busy={busy(model)}
          jobs={jobs}
          job={job}
          open={scopeOpen}
          onOpenChange={setScopeOpen}
          onPick={setJobKey}
          finalFocus={search}
        />
      }
    >
      <Results
        rows={rows}
        options={options}
        active={active}
        moved={model.moved}
        text={model.text}
        mixed={mixed}
        jobOf={jobOf}
        onPoint={(id) => controller.point(id)}
        onTake={take}
      />
    </PickerDialog>
  );
}

/** The field's own end: the spinner while a source is out, then the scope. Nothing while there is one job. */
export function FieldEnd({
  busy: out,
  jobs,
  job,
  open,
  onOpenChange,
  onPick,
  finalFocus,
}: {
  busy: boolean;
  jobs: readonly Job[];
  job: Job | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** a job's key, or null for all jobs */
  onPick: (jobKey: string | null) => void;
  finalFocus?: RefObject<HTMLInputElement | null>;
}) {
  const rows = (): MenuRow[] => [
    { kind: "item", id: ALL_JOBS, label: "All jobs", checked: job === null },
    { kind: "sep" },
    ...jobs.map((j): MenuRow => ({ kind: "item", id: j.key, label: j.name, icon: dotIcon(j.sector), checked: j.key === job?.key })),
  ];
  return (
    <>
      {out ? <Spinner data-work-search-busy className="mr-1.5 size-3.5 text-muted-foreground" /> : null}
      {jobs.length > 1 ? (
        <RowsMenu
          label="Search in"
          align="end"
          open={open}
          onOpenChange={onOpenChange}
          finalFocus={finalFocus as RefObject<HTMLElement | null> | undefined}
          rows={rows}
          onPick={(id) => onPick(id === ALL_JOBS ? null : id)}
          trigger={
            <Button variant="ghost" size="xs" data-work-search-scope aria-label={`Search in ${job?.name ?? "all jobs"}`} className="gap-1 px-1.5 font-normal text-muted-foreground hover:text-foreground aria-expanded:text-foreground">
              {job ? <SectorDot sector={job.sector} className="-mx-0.5" /> : null}
              <span className="max-w-32 truncate">{job?.name ?? "All jobs"}</span>
              <ChevronDown />
            </Button>
          }
        />
      ) : null}
    </>
  );
}

export function Results({
  rows,
  options,
  active,
  moved,
  text,
  mixed,
  jobOf,
  now,
  onPoint,
  onTake,
}: {
  rows: Row[];
  options: Option[];
  active: string | null;
  moved: boolean;
  text: string;
  mixed: boolean;
  jobOf: (hit: SearchHit) => Job | null;
  /** the clock the rows' times are worded by; a design page fixes it */
  now?: number;
  onPoint: (id: string) => void;
  onTake: (row: Option, o?: { thread?: boolean }) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const list = useRef<HTMLDivElement | null>(null);
  const setList = useCallback(
    (el: HTMLDivElement | null) => {
      list.current = el;
      lockOverscroll(el);
    },
    [lockOverscroll],
  );
  const activeIndex = options.findIndex((option) => option.id === active);
  const { activeRef, onMouseMove, onRowEnter } = usePointerHighlight<HTMLDivElement>({
    active: activeIndex,
    items: options,
    onActive: (index) => {
      const row = options[index];
      if (row) onPoint(row.id);
    },
  });

  // Holding still: the highlighted row's place in the box, as it was last drawn or scrolled to.
  const place = useRef<{ id: string; top: number } | null>(null);
  const rowOf = (el: HTMLElement): HTMLElement | null => (active ? el.querySelector<HTMLElement>(`[data-row="${CSS.escape(active)}"]`) : null);
  /** Stands the scroller at `scrollTop`, its box no taller than the rows from there down, and notes where the highlighted row now is. */
  const stand = (el: HTMLElement, at: (natural: HTMLElement) => number): void => {
    const cap = Number.parseFloat(getComputedStyle(el).maxHeight) || LIST_CAP;
    el.style.height = "";
    const row = rowOf(el);
    const held = holdStill({ rowTop: at(el), was: 0, scrollHeight: el.scrollHeight, cap });
    el.style.height = held.height === null ? "" : `${held.height}px`;
    if (el.scrollTop !== held.scrollTop) el.scrollTop = held.scrollTop;
    place.current = row && active ? { id: active, top: row.offsetTop - el.scrollTop } : null;
  };
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (!moved) {
      // Until he moves the highlight the list is as tall as its rows and stands where it is.
      el.style.height = "";
      const row = rowOf(el);
      place.current = row && active ? { id: active, top: row.offsetTop - el.scrollTop } : null;
      return;
    }
    const was = place.current?.id === active ? place.current.top : null;
    // The row he chose keeps its place: the scroller takes up what landed above it. Any other change leaves the scroller where it is.
    stand(el, (natural) => {
      const row = rowOf(natural);
      return row && was !== null ? Math.max(0, row.offsetTop - was) : natural.scrollTop;
    });
  });
  // He scrolled (or an arrow brought a row into view): the box grows back as what was above the fold comes down.
  const onScroll = (): void => {
    const el = list.current;
    if (!el) return;
    if (moved) stand(el, (natural) => natural.scrollTop);
    else {
      const row = rowOf(el);
      place.current = row && active ? { id: active, top: row.offsetTop - el.scrollTop } : null;
    }
  };

  if (rows.length === 0) return null;
  const menuRows = (id: string | null): MenuRow[] | null => {
    const row = options.find((option) => option.id === id);
    if (!row || row.type !== "hit") return null;
    return [
      { kind: "item", id: "open", label: "Open", shortcut: shortcutFor("Work", "Open a search result") },
      ...(canStartAbout(row.hit) ? [{ kind: "item" as const, id: "thread", label: "New Thread About This", shortcut: shortcutFor("Work", "Start a thread about a search result") }] : []),
    ];
  };

  return (
    <RowsContextMenu
      lazyMount
      label="Search result"
      rowsFor={menuRows}
      onPick={(pick, id) => {
        const row = options.find((option) => option.id === id);
        if (row) onTake(row, { thread: pick === "thread" });
      }}
    >
      <div
        ref={setList}
        role="listbox"
        aria-label="Work search results"
        data-work-search-list
        onMouseMove={onMouseMove}
        onScroll={onScroll}
        className="max-h-[min(380px,50vh)] overflow-x-hidden overflow-y-auto overscroll-none [--scrollbar-inset:var(--radius-xl)]"
      >
        {rows.map((row, index) => {
          if (row.type === "heading") {
            return (
              <div key={row.id} role="presentation" className={cn("px-3 pb-1 text-[11px] font-medium text-muted-foreground", index === 0 ? "pt-1" : "pt-2")}>
                {row.label}
              </div>
            );
          }
          if (row.type === "note") {
            return (
              // What could not be searched stands apart from what was found: one step of the grid above its first line.
              <div key={row.id} className={index > 0 && rows[index - 1].type !== "note" ? "pt-1" : undefined}>
                <PickerNote>{row.text}</PickerNote>
              </div>
            );
          }
          const highlighted = row.id === active;
          const option = options.indexOf(row);
          const common = {
            ref: highlighted ? activeRef : undefined,
            role: "option" as const,
            "aria-selected": highlighted,
            "data-row": row.id,
            onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
            onMouseEnter: () => onRowEnter(option),
            onClick: () => onTake(row),
          };
          if (row.type !== "hit") {
            return (
              <div key={row.id} {...common} className={cn(pickerRowClass(highlighted), "text-muted-foreground")}>
                <span aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 truncate">{row.label}</span>
              </div>
            );
          }
          const { hit } = row;
          const Glyph = GLYPH[hit.kind] ?? Layers;
          const fact = factOf(hit, now);
          const time = timeOf(hit, now);
          const job = mixed ? jobOf(hit) : null;
          return (
            <div key={row.id} {...common} data-menu-id={row.id} data-kind={hit.kind} className={pickerRowClass(highlighted)}>
              {hit.kind === "file" ? (
                <span className="shrink-0">
                  <FileTypeIcon name={hit.title} isDir={false} />
                </span>
              ) : (
                <Glyph className="size-4 shrink-0 text-muted-foreground" />
              )}
              {/* The `@` list's own row: the title as wide as its words, then the fact in what is left, cut first. */}
              <span className="min-w-0 flex-[0_1_auto] truncate">
                <MatchText text={hit.title} query={text} active={Boolean(text)} />
                {hit.cloud ? <Cloud aria-label="Kept in the cloud" className="ml-1.5 inline size-3.5 align-[-2px] text-muted-foreground" /> : null}
              </span>
              <span className={cn("flex-[1_1_0] truncate text-xs text-muted-foreground", fact ? "min-w-[4.5rem] max-[480px]:min-w-0" : "min-w-0")}>{fact}</span>
              {mixed ? (
                <span data-job className="flex w-28 shrink-0 items-center gap-1 text-xs text-muted-foreground max-[480px]:w-20">
                  {job ? <SectorDot sector={job.sector} /> : <span aria-hidden className="size-4 shrink-0" />}
                  <span className="min-w-0 truncate">{job ? job.name : hit.workspaceId === null ? "Work Chats" : ""}</span>
                </span>
              ) : null}
              <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground max-[480px]:w-9">{time}</span>
            </div>
          );
        })}
      </div>
    </RowsContextMenu>
  );
}
