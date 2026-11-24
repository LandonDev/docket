import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { SEARCH_TEXT_MAX, searchLabel, type SearchHit } from "@shared/work/search";
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
import { markOverflowEdges, OVERFLOW_FADE_Y, useOverflowEdges } from "../../hooks/useOverflowEdges";
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
import { holdStill, outOfSight } from "./hold";
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

/** The dot's place, empty: the scope's first row has no job to show. */
const NO_DOT: MenuIcon = function NoDot() {
  return <span aria-hidden className="-mx-px size-4 shrink-0" />;
};

const ALL_JOBS = "all";
/** The list's id and an option's, for the field to name the row the arrows are on (a combobox's `aria-activedescendant`). */
export const LIST_ID = "work-search-list";
export const optionId = (rowId: string): string => `work-search-option-${rowId.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** Two asks with no seed closer than this are one press of the key, heard by the window and by the menu. */
export const SAME_PRESS_MS = 80;

/** The list's cap where the page gives no measure (a test): the class below says the same. */
const LIST_CAP = 380;

/** A row the arrows bring into view stops clear of the list's faded edges (32px, `OVERFLOW_FADE_Y`): the highlighted row is never the dimmed one. */
const CLEAR_OF_FADE = "scroll-my-8";

/** A fact of this many characters or fewer is narrower than the 72px a long one keeps. */
const SHORT_FACT = 10;

/** A row of the list itself; what could not be searched stands under the list, outside its scroller. */
const isListed = (row: Row): boolean => !(row.type === "note" && row.cause);

/** The spinner waits this long for an answer before it shows, and once shown stays this long: an answer in a few frames never flickers it. */
export const SPIN_AFTER_MS = 150;
export const SPIN_FOR_MS = 300;

/** `out`, steadied: true only once it has been true for `SPIN_AFTER_MS`, and then for at least `SPIN_FOR_MS`. */
export function useSteadySpin(out: boolean): boolean {
  const [spin, setSpin] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    if (out === spin) return;
    const wait = out ? SPIN_AFTER_MS : Math.max(0, SPIN_FOR_MS - (performance.now() - since.current));
    const timer = setTimeout(() => {
      if (out) since.current = performance.now();
      setSpin(out);
    }, wait);
    return () => clearTimeout(timer);
  }, [out, spin]);
  return spin;
}

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
  // One kind, said to a reader that cannot see it stand in the field: on the way in and on the way out, never at the open.
  const [said, setSaid] = useState("");
  const kindWas = useRef(kind);
  useEffect(() => {
    if (kindWas.current === kind) return;
    kindWas.current = kind;
    setSaid(kind ? `${searchLabel(kind)} only` : "Every kind");
  }, [kind]);

  const [controller] = useState(() => new SearchController(liveDeps(askHost)));
  const model = useSyncExternalStore(controller.subscribe, controller.read, controller.read);
  useEffect(() => () => controller.close(), [controller]);
  useEffect(() => {
    const { hosts, offline } = searchHosts(job, { workspaces: () => workspaces });
    controller.search(query, kind, hosts, offline, job?.key ?? null, job?.ids ?? null);
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
  // One press can arrive both ways at once: the second, within a press's length, is the same press.
  const flipNow = useRef(flip);
  flipNow.current = flip;
  useEffect(() => {
    let last = Number.NEGATIVE_INFINITY;
    return onWorkSearch((asked) => {
      if (!isBareSeed(asked) || performance.now() - last < SAME_PRESS_MS) return;
      last = performance.now();
      flipNow.current();
    });
  }, []);

  const rows = useMemo(() => rowsOf(model, { scoped: job !== null, jobOf: (id) => jobOfWorkspace(jobs, id)?.key ?? id ?? "" }), [model, job, jobs]);
  const options = useMemo(() => rows.filter(isOption), [rows]);
  const active = activeOf(model, rows);
  const spin = useSteadySpin(busy(model));
  const told = busy(model)
    ? ""
    : rows
        .flatMap((row) => (row.type === "note" ? [/[.!?]$/.test(row.text) ? row.text : `${row.text}.`] : []))
        .join(" ");
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
    // While he composes a word (an input method's candidates), every key is the composition's: Return takes a candidate, the arrows move among them.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey) {
      e.preventDefault();
      controller.step(rows, e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = options.find((option) => option.id === active);
      if (!row) return;
      // He scrolled the list by the trackpad and the highlighted row went out of sight: this Return brings it back,
      // and the next one opens it. Return never opens a row he cannot see.
      const box = document.getElementById(LIST_ID);
      const el = box?.querySelector<HTMLElement>(`[data-row="${CSS.escape(row.id)}"]`);
      if (box && el && outOfSight({ top: el.offsetTop, height: el.offsetHeight }, { scrollTop: box.scrollTop, height: box.clientHeight })) {
        el.scrollIntoView({ block: "nearest" });
        return;
      }
      take(row, { thread: modOrCtrl(e) });
      return;
    }
    // The key in the field goes out by the door, as the menu's accelerator does: one press, one flip.
    if (modOrCtrl(e) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openWorkSearch();
      return;
    }
    // The scope by keys: the field's own menu, as a select opens.
    if (e.altKey && e.key === "ArrowDown" && jobs.length > 1) {
      e.preventDefault();
      setScopeOpen(true);
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
      listId={rows.some(isListed) ? LIST_ID : undefined}
      activeId={active ? optionId(active) : null}
      rule={rows.length > 0}
      maxLength={SEARCH_TEXT_MAX}
      trailing={
        <FieldEnd
          busy={spin}
          jobs={jobs}
          job={job}
          open={scopeOpen}
          onOpenChange={setScopeOpen}
          onPick={setJobKey}
          finalFocus={search}
        />
      }
    >
      {/* `data-out` is the truth the spinner steadies: something asked has not answered (the live proof waits on it). */}
      <span role="status" data-out={busy(model) || undefined} className="sr-only">
        {said}
      </span>
      {/* What the list's foot says in muted words, a reader is told once the search has settled: nothing found, and what could not be searched. */}
      <span role="status" data-work-search-told className="sr-only">
        {told}
      </span>
      <Results
        rows={rows}
        options={options}
        active={active}
        moved={model.moved}
        text={model.text}
        mixed={mixed}
        jobOf={jobOf}
        label={kind ? `${searchLabel(kind)} results` : undefined}
        asked={`${model.text}\n${model.kind ?? ""}\n${model.scope ?? ""}`}
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
    // An empty glyph, so "All jobs" starts on the names' own edge.
    { kind: "item", id: ALL_JOBS, label: "All jobs", icon: NO_DOT, checked: job === null },
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
            // 4px in from the field's end, so the scope ends over the rows' own end (their strip lies past it).
            <Button variant="ghost" size="xs" data-work-search-scope aria-label={`Search in ${job?.name ?? "all jobs"}`} className="mr-1 gap-1 px-1.5 font-normal text-muted-foreground hover:text-foreground aria-expanded:text-foreground">
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
  label = "Work search results",
  asked,
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
  /** the list's name for a reader: the kind it is held to, when it is */
  label?: string;
  /** what was asked (his words, the kind, the scope): when it changes the list stands at its top again, where the highlight is */
  asked?: string;
  onPoint: (id: string) => void;
  onTake: (row: Option, o?: { thread?: boolean }) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const overflowEdges = useOverflowEdges<HTMLDivElement>("y");
  const list = useRef<HTMLDivElement | null>(null);
  const setList = useCallback(
    (el: HTMLDivElement | null) => {
      list.current = el;
      lockOverscroll(el);
      overflowEdges(el);
    },
    [lockOverscroll, overflowEdges],
  );
  // A new ask puts the highlight back on the first row: the list goes back to its top with it, wherever he had scrolled,
  // so Return never takes a row above what he sees. (The same first row keeps its name, so nothing else would bring it into view.)
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [asked]);
  // More rows landed, or fewer: the cut edge fades only while there is more past it.
  useLayoutEffect(() => {
    if (list.current) markOverflowEdges(list.current, "y");
  });
  // The time column stands whenever he has typed, whichever rows have landed: people and tasks answer first and have no
  // time, and the job column must not jump when the mail lands. Recent, which has none, gives the room to its titles.
  const timed = text !== "";
  const listed = rows.filter(isListed);
  const causes = rows.filter((row) => !isListed(row));
  // The row's menu holds the keys it shows: ⌘↩ starts the thread from the menu too, while it is open on a row.
  const [menuRow, setMenuRow] = useState<string | null>(null);
  useEffect(() => {
    if (!menuRow) return;
    const onKey = (e: KeyboardEvent): void => {
      const row = options.find((option) => option.id === menuRow);
      if (e.key !== "Enter" || !modOrCtrl(e) || !row || row.type !== "hit" || !canStartAbout(row.hit)) return;
      e.preventDefault();
      e.stopPropagation();
      onTake(row, { thread: true });
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuRow, options, onTake]);
  const activeIndex = options.findIndex((option) => option.id === active);
  const { activeRef, onMouseMove, onRowEnter, pointAt } = usePointerHighlight<HTMLDivElement>({
    active: activeIndex,
    // By its name: a row he chose that only stands further down, because more landed above, is held where it is and not scrolled to.
    activeKey: active,
    items: options,
    onActive: (index) => {
      const row = options[index];
      if (row) onPoint(row.id);
    },
  });

  // Holding still: the highlighted row's place in the box, as it was last drawn or scrolled to.
  const place = useRef<{ id: string; top: number } | null>(null);
  const rowOf = (el: HTMLElement): HTMLElement | null => (active ? el.querySelector<HTMLElement>(`[data-row="${CSS.escape(active)}"]`) : null);
  /**
   * Stands the scroller at `scrollTop`, its box no taller than the rows from there down, and notes where the highlighted row now is.
   * Nothing is let go to be measured: the rows' own height is read from the rows, and the box and the scroller are written only
   * where they differ. A box let go even for a moment is pulled back to its top by the browser, and each such move is a scroll
   * event that would come back here.
   */
  const stand = (el: HTMLElement, at: (stood: number) => number): void => {
    const cap = Number.parseFloat(getComputedStyle(el).maxHeight) || LIST_CAP;
    const first = el.firstElementChild as HTMLElement | null;
    const last = el.lastElementChild as HTMLElement | null;
    const all = first && last ? last.offsetTop + last.offsetHeight - first.offsetTop : 0;
    const held = holdStill({ rowTop: at(el.scrollTop), was: 0, scrollHeight: all, cap });
    const height = held.height === null ? "" : `${held.height}px`;
    if (el.style.height !== height) el.style.height = height;
    if (el.scrollTop !== held.scrollTop) el.scrollTop = held.scrollTop;
    const row = rowOf(el);
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
    stand(el, (stood) => {
      const row = rowOf(el);
      return row && was !== null ? Math.max(0, row.offsetTop - was) : stood;
    });
  });
  // He scrolled (or an arrow brought a row into view): the box grows back as what was above the fold comes down.
  const onScroll = (): void => {
    const el = list.current;
    if (!el) return;
    // His own scroll, or the one the hold above just made: either way the scroller stays where it is.
    if (moved) stand(el, (stood) => stood);
    else {
      const row = rowOf(el);
      place.current = row && active ? { id: active, top: row.offsetTop - el.scrollTop } : null;
    }
  };

  const menuRows = (id: string | null): MenuRow[] | null => {
    const row = options.find((option) => option.id === id);
    if (!row || row.type !== "hit") return null;
    return [
      { kind: "item", id: "open", label: "Open", shortcut: shortcutFor("Work", "Open Result") },
      ...(canStartAbout(row.hit) ? [{ kind: "item" as const, id: "thread", label: "New thread about this", shortcut: shortcutFor("Work", "New Thread About Result") }] : []),
    ];
  };

  const foot =
    causes.length > 0 ? (
      // What could not be searched stands apart from what was found, under the list and outside its scroller: a full list never hides it.
      <div data-work-search-causes className={listed.length > 0 ? "pt-1" : undefined}>
        {causes.map((row) => (
          <PickerNote key={row.id}>
            <span className="min-w-0 truncate">{row.type === "note" ? row.text : null}</span>
          </PickerNote>
        ))}
      </div>
    ) : null;
  if (listed.length === 0) return foot;

  return (
    <>
      <RowsContextMenu
        lazyMount
        label="Search result"
        rowsFor={menuRows}
        // The menu's row is the highlighted one while the menu is open, however the highlight stood before.
        onOpenChange={(open, id) => {
          const on = open && id && menuRows(id) ? id : null;
          setMenuRow(on);
          // The pointer's own choice: the highlight goes to the row, and the list is not scrolled under the menu.
          if (on) {
            pointAt(options.findIndex((option) => option.id === on));
            // And his choice even when the row was lit already (the first row, not yet moved to): what lands above must not take the highlight from under the menu.
            onPoint(on);
          }
        }}
        onPick={(pick, id) => {
          const row = options.find((option) => option.id === id);
          if (row) onTake(row, { thread: pick === "thread" });
        }}
      >
        <div
          ref={setList}
          id={LIST_ID}
          role="listbox"
          aria-label={label}
          data-work-search-list
          onMouseMove={onMouseMove}
          onScroll={onScroll}
          // The strip is kept from the start, so the columns do not shift when the list first overflows; it lies in the
          // frame's own right inset (-mr-1), so a row ends 10px from the frame's edge and not 14. A cut edge fades.
          className={cn("-mr-1 max-h-[min(380px,50vh)] overflow-x-hidden overflow-y-auto overscroll-none [scrollbar-gutter:stable] [--scrollbar-inset:var(--radius-xl)]", OVERFLOW_FADE_Y)}
        >
          {listed.map((row, index) => {
            if (row.type === "heading") {
              return (
                <div key={row.id} role="presentation" className={cn("px-3 pb-1 text-[11px] leading-4 font-medium text-muted-foreground", index === 0 ? "pt-1" : "pt-2")}>
                  {row.label}
                </div>
              );
            }
            if (row.type === "note") {
              return (
                <PickerNote key={row.id}>
                  {/* One line, whatever he typed: the field holds his words whole. */}
                  <span className="min-w-0 truncate">{row.text}</span>
                </PickerNote>
              );
            }
            const highlighted = row.id === active;
            const option = options.indexOf(row);
            const common = {
              ref: highlighted ? activeRef : undefined,
              id: optionId(row.id),
              role: "option" as const,
              "aria-selected": highlighted,
              "data-row": row.id,
              onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
              onMouseEnter: () => onRowEnter(option),
              onClick: () => onTake(row),
            };
            if (row.type !== "hit") {
              return (
                // A quiet row at rest; the one Return will take reads as any highlighted row does.
                <div key={row.id} {...common} className={cn(pickerRowClass(highlighted), CLEAR_OF_FADE, !highlighted && "text-muted-foreground")}>
                  {/* "All mail for …" stands under its group's titles; "Search all jobs" under the line it answers. */}
                  {row.type === "all" ? <span aria-hidden className="size-4 shrink-0" /> : null}
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
              <div key={row.id} {...common} data-menu-id={row.id} data-kind={hit.kind} className={cn(pickerRowClass(highlighted), CLEAR_OF_FADE)}>
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
                {/* In a window too narrow for it the fact goes, rather than stand as a stub. */}
                {/* A long fact keeps 72px and is cut first; a short one keeps only its own width, so it never holds room a long title needs. */}
                <span className={cn("flex-[1_1_0] truncate text-xs text-muted-foreground", fact ? cn(fact.length > SHORT_FACT ? "min-w-[4.5rem]" : "min-w-max", "max-[480px]:hidden") : "min-w-0")}>
                  {fact ? <MatchText text={fact} query={text} active={Boolean(text)} /> : null}
                </span>
                {/* The row's end: the job and the time, each a column of one width, at the right whatever stands before them. */}
                {mixed || timed ? (
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {mixed ? (
                      // In a window too narrow for the names the job is its dot alone, and the title keeps its words.
                      <span data-job className="flex w-20 items-center gap-1 text-xs text-muted-foreground max-[480px]:w-auto">
                        {job ? <SectorDot sector={job.sector} /> : <span aria-hidden className="size-4 shrink-0" />}
                        <span className="min-w-0 truncate max-[480px]:sr-only">{job ? job.name : hit.workspaceId === null ? "Work Chats" : ""}</span>
                      </span>
                    ) : null}
                    {timed ? <span data-time className="w-14 text-right text-xs whitespace-nowrap tabular-nums text-muted-foreground">{time}</span> : null}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </RowsContextMenu>
      {foot}
    </>
  );
}
