import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import type { CanvasSource } from "@shared/work";
import type { DocOpen, FindAnswer } from "@shared/contract-work-docs";
import {
  DEFAULT_SPEC,
  EDITED_WITHIN,
  EDITED_WITHIN_WORDS,
  FIND_BY,
  FIND_BY_WORDS,
  FIND_KINDS,
  FIND_KIND_WORDS,
  FIND_WHERE,
  FIND_WHERE_WORDS,
  filterCount,
  findIn,
  groupRows,
  type FindEntry,
  type FindFilter,
  type FindGroup,
  type FindKind,
  type FindSort,
  type FindSpec,
  type SavedFindView,
} from "@shared/work/docFind";
import { ChevronLeft, ListChecks, ListFilter, Search, SlidersHorizontal, X } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Tip } from "../../components/tip";
import { BusyLabel, Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { GroupInput, Input, InputGroup } from "../../components/ui/input";
import { ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { reveal } from "../../components/ui/reveal";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { cn } from "../../lib/cn";
import { dayTime } from "../../lib/duration";
import { chordKey, modKey } from "../../lib/keys";
import { refusalWords } from "../../lib/settingsHome";
import { workOpenPort } from "../../lib/workSwitch";
import { EmptyState, LoadingLine } from "../../surfaces/SurfaceSkeleton";
import { Dashboard, Doc, Media, Mic, Pdf, Slides, Table as SheetIcon } from "../icons";
import { useLifeosQuery } from "../shell/lifeos";
import type { WorkViewProps } from "../views/registry";
import { SEARCH_FIELD } from "../views/searchField";
import { ViewStateLine } from "../views/ViewStateLine";
import { DocumentFrame, MARGIN_FROM, Scroller, useDocument, useOpened } from "./DocumentCanvas";
import { chipOf, finderOf, opensHere, pick, sameSpec, setFinder, setFound, setSpec, useFinder, useFound } from "./finder";
import type { DocHost } from "./host";

/**
 * The Docs view of a linked Work workspace (docs/agents/work-docs.md "The
 * Docs view" and "Finding documents"): everything the workspace holds, in
 * LifeOS, its folder, Google, Microsoft and its threads, one line each. The
 * header searches titles at once and what is written inside as he types,
 * filters by any mix of facets, and groups, orders and lays out the list
 * (a list, or a denser table); a spec can be saved by name with the
 * workspace. A document opens right here in the shared editor; an item a
 * thread holds opens that thread; anything else starts a thread about it.
 * Picked rows start one thread about them all.
 */

/** How long typing rests before the host is asked what is written inside. */
const SEARCH_REST_MS = 150;

/** Which document each workspace's view has open: the header and the body read it. */
type Opened = { source: CanvasSource; title: string };
const opened = new Map<string, Opened | null>();
const listeners = new Set<() => void>();
function setOpened(workspaceId: string, doc: Opened | null): void {
  opened.set(workspaceId, doc);
  for (const l of listeners) l();
}
function useOpenedDoc(workspaceId: string): Opened | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => opened.get(workspaceId) ?? null,
  );
}

const KIND_ICON: Record<FindKind, typeof Doc> = { document: Doc, sheet: SheetIcon, pdf: Pdf, slides: Slides, media: Media, meeting: Mic, form: ListChecks, dashboard: Dashboard };

/** A call to the host; a host this window does not know is a refusal like any other, not a throw mid-render. */
const request = async <T,>(env: string, method: string, params: Record<string, unknown>): Promise<T> => registry.linkOf(env).request<T>(method, params);

/** The list as the spec in hand shows it. */
function useShown(workspaceId: string): { rows: FindEntry[]; projects: ReadonlyMap<string, string> } | null {
  const { spec } = useFinder(workspaceId);
  const found = useFound(workspaceId);
  return useMemo(() => {
    if (!found.answer) return null;
    const hits = found.hitsFor === spec.query.trim() ? found.hits : new Map<string, string>();
    return { rows: findIn(found.answer.entries, spec, hits), projects: new Map(found.answer.projects.map((p) => [p.id, p.name])) };
  }, [found, spec]);
}

/** Opens an entry where it lives: a document here, a thread's item in its thread, else a new thread about it. */
function openEntry(props: WorkViewProps, e: FindEntry): void {
  if (opensHere(e)) return setOpened(props.workspace.id, { source: e.source, title: e.title });
  if (e.sessionId && workOpenPort.get()) return workOpenPort.get()!(e.sessionId);
  const chip = chipOf(e);
  if (chip) props.startThread(chip);
}

export function View(props: WorkViewProps) {
  const doc = useOpenedDoc(props.workspace.id);
  return doc ? <OpenDoc {...props} doc={doc} /> : <DocList {...props} />;
}

// ── The header ──

/** The header's controls: the search, Filter and View on the list with New, or the picked rows' Ask; Ask alone on a document. */
export function Head(props: WorkViewProps) {
  const doc = useOpenedDoc(props.workspace.id);
  const { selected } = useFinder(props.workspace.id);
  if (doc)
    return (
      <Button variant="ghost" size="sm" onClick={() => props.startThread({ kind: "selection", label: doc.title, ref: doc.source })}>
        Ask
      </Button>
    );
  return (
    <div className="flex min-w-0 items-center gap-1">
      <SearchField workspaceId={props.workspace.id} />
      <FilterMenu workspaceId={props.workspace.id} />
      <ViewMenu env={props.env} workspaceId={props.workspace.id} />
      {selected.size ? <Picked {...props} /> : <NewDoc {...props} />}
    </div>
  );
}

function SearchField({ workspaceId }: { workspaceId: string }) {
  const { spec } = useFinder(workspaceId);
  const input = useRef<HTMLInputElement>(null);
  // "/" anywhere in the view puts the caret in the search, as in every list he searches.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || chordKey(e)) return;
      const at = document.activeElement as HTMLElement | null;
      if (at && (at.tagName === "INPUT" || at.tagName === "TEXTAREA" || at.isContentEditable)) return;
      // Only while nothing else holds focus, or focus is in this view: "/" elsewhere is that place's own.
      if (at && at !== document.body && !input.current?.closest('[role="region"]')?.contains(at)) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <InputGroup
      role="search"
      className={SEARCH_FIELD}
      leading={<Search />}
      trailing={
        spec.query ? (
          <Button variant="ghost" size="icon-xs" aria-label="Clear search" onClick={() => setSpec(workspaceId, { query: "" })}>
            <X />
          </Button>
        ) : null
      }
    >
      <GroupInput
        ref={input}
        aria-label="Search documents"
        placeholder="Search"
        value={spec.query}
        onChange={(e) => setSpec(workspaceId, { query: e.currentTarget.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (spec.query) setSpec(workspaceId, { query: "" });
            else input.current?.blur();
            e.preventDefault();
          } else if (e.key === "ArrowDown" || e.key === "Enter") {
            const first = document.querySelector<HTMLElement>(`[data-find-list="${CSS.escape(workspaceId)}"] [data-find-row]`);
            if (first) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      />
    </InputGroup>
  );
}

const toggled = <T,>(list: readonly T[] | undefined, v: T): T[] => (list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v]);

/** The filter menu's rows: a facet each, offering only what the list holds (and anything already picked). */
export function filterRows(f: FindFilter, entries: readonly FindEntry[], projects: readonly { id: string; name: string }[]): MenuRow[] {
  const present = <T extends string>(all: readonly T[], of: (e: FindEntry) => T | undefined, picked: readonly T[] | undefined) =>
    all.filter((v) => picked?.includes(v) || entries.some((e) => of(e) === v));
  const check = (facet: string, value: string, label: string, on: boolean): MenuRow => ({ kind: "item", id: `${facet}:${value}`, label, checked: on, keepOpen: true });
  const sub = (id: string, label: string, items: MenuRow[]): MenuRow[] => (items.length ? [{ kind: "sub", id, label, items, ...(items.some((i) => i.kind === "item" && i.checked) ? { trailing: <span className="text-xs text-muted-foreground tabular-nums">{items.filter((i) => i.kind === "item" && i.checked).length}</span> } : {}) }] : []);
  const loose = entries.some((e) => !e.projectId) || f.projects?.includes("");
  return [
    ...sub("kind", "Kind", present(FIND_KINDS, (e) => e.kind, f.kinds).map((k) => check("kind", k, FIND_KIND_WORDS[k], !!f.kinds?.includes(k)))),
    ...sub("project", "Project", [
      ...projects.map((p) => check("project", p.id, p.name, !!f.projects?.includes(p.id))),
      ...(loose ? [check("project", "", "No project", !!f.projects?.includes(""))] : []),
    ]),
    ...sub("where", "Place", present(FIND_WHERE, (e) => e.where, f.where).map((w) => check("where", w, FIND_WHERE_WORDS[w], !!f.where?.includes(w)))),
    ...sub("by", "Last edited by", present(FIND_BY, (e) => e.lastBy, f.by).map((b) => check("by", b, FIND_BY_WORDS[b], !!f.by?.includes(b)))),
    ...sub("within", "Edited", [
      { kind: "item", id: "within:", label: "Any time", checked: !f.within },
      ...EDITED_WITHIN.map((w): MenuRow => ({ kind: "item", id: `within:${w}`, label: EDITED_WITHIN_WORDS[w], checked: f.within === w })),
    ]),
    { kind: "sep" },
    check("flag", "shared", "Shared", !!f.shared),
    check("flag", "review", "Needs review", !!f.review),
    check("flag", "held", "Held", !!f.held),
    ...(filterCount(f) ? ([{ kind: "sep" }, { kind: "item", id: "clear", label: "Clear filters" }] satisfies MenuRow[]) : []),
  ];
}

/** A filter row picked: the filter it makes. */
export function applyFilterPick(f: FindFilter, id: string): FindFilter {
  if (id === "clear") return {};
  const [facet, value = ""] = id.split(/:(.*)/s);
  if (facet === "kind") return { ...f, kinds: toggled(f.kinds, value as FindKind) };
  if (facet === "project") return { ...f, projects: toggled(f.projects, value) };
  if (facet === "where") return { ...f, where: toggled(f.where, value as FindEntry["where"]) };
  if (facet === "by") return { ...f, by: toggled(f.by, value as NonNullable<FindEntry["lastBy"]>) };
  if (facet === "within") {
    const { within: _, ...rest } = f;
    return value ? { ...rest, within: value as FindFilter["within"] } : rest;
  }
  if (facet === "flag") return { ...f, [value]: !f[value as "shared" | "review" | "held"] };
  return f;
}

function FilterMenu({ workspaceId }: { workspaceId: string }) {
  const { spec } = useFinder(workspaceId);
  const { answer } = useFound(workspaceId);
  const n = filterCount(spec.filter);
  return (
    <RowsMenu
      label="Filter"
      align="end"
      className="w-56"
      trigger={
        <Button variant="ghost" size="sm" aria-label={n ? `Filter, ${n} set` : "Filter"}>
          <ListFilter />
          Filter
          {n ? <span className="text-muted-foreground tabular-nums">{n}</span> : null}
        </Button>
      }
      rows={() => filterRows(spec.filter, answer?.entries ?? [], answer?.projects ?? [])}
      onPick={(id) => setSpec(workspaceId, { filter: applyFilterPick(finderOf(workspaceId).spec.filter, id) })}
    />
  );
}

const GROUP_WORDS: Record<FindGroup, string> = { project: "Project", kind: "Kind", edited: "Date edited", where: "Place", none: "None" };
const SORT_WORDS: Record<FindSort, string> = { edited: "Date edited", created: "Date created", name: "Name" };

/** The view menu's rows: grouping, order, layout, then the saved views and what can be done with the one in hand. */
export function viewRows(spec: FindSpec, views: readonly SavedFindView[], viewId: string | null): MenuRow[] {
  const active = views.find((v) => v.id === viewId) ?? null;
  const changed = active ? !sameSpec(active.spec, spec) : !sameSpec(DEFAULT_SPEC, spec);
  return [
    { kind: "sub", id: "group", label: "Group by", items: (Object.keys(GROUP_WORDS) as FindGroup[]).map((g) => ({ kind: "item", id: `group:${g}`, label: GROUP_WORDS[g], checked: spec.group === g })) },
    { kind: "sub", id: "sort", label: "Sort by", items: (Object.keys(SORT_WORDS) as FindSort[]).map((s) => ({ kind: "item", id: `sort:${s}`, label: SORT_WORDS[s], checked: spec.sort === s })) },
    { kind: "sep" },
    { kind: "item", id: "layout:list", label: "List", checked: spec.layout === "list" },
    { kind: "item", id: "layout:table", label: "Table", checked: spec.layout === "table" },
    { kind: "sep" },
    { kind: "item", id: "view:", label: "All documents", checked: !viewId && !changed },
    ...views.map((v): MenuRow => ({ kind: "item", id: `view:${v.id}`, label: v.name, checked: v.id === viewId })),
    { kind: "sep" },
    ...(active && changed ? ([{ kind: "item", id: "save", label: `Save changes to ${active.name}` }] satisfies MenuRow[]) : []),
    ...(changed || !active ? ([{ kind: "item", id: "saveAs", label: "Save as view…", disabled: !changed }] satisfies MenuRow[]) : []),
    ...(active
      ? ([
          { kind: "item", id: "rename", label: "Rename view…" },
          { kind: "item", id: "drop", label: "Delete view", danger: true },
        ] satisfies MenuRow[])
      : []),
  ];
}

function useViews(env: string, workspaceId: string): [SavedFindView[], (views: SavedFindView[]) => void] {
  const [views, setViews] = useState<SavedFindView[]>([]);
  useEffect(() => {
    let live = true;
    request<{ views: SavedFindView[] }>(env, "work.docs.views", { workspaceId }).then(
      (got) => live && setViews(got.views),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [env, workspaceId]);
  return [views, setViews];
}

function ViewMenu({ env, workspaceId }: { env: string; workspaceId: string }) {
  const { spec, viewId } = useFinder(workspaceId);
  const [views, setViews] = useViews(env, workspaceId);
  const [naming, setNaming] = useState<{ id?: string; name: string } | null>(null);
  const active = views.find((v) => v.id === viewId) ?? null;
  const fail = (what: string) => (err: unknown) => void loadToast().then((toast) => toast.error(what, { description: refusalWords(err) || undefined }));
  const save = async (v: { id?: string; name: string; spec: FindSpec }) => {
    const done = await request<SavedFindView>(env, "work.docs.saveView", { workspaceId, ...v });
    setViews(v.id ? views.map((x) => (x.id === done.id ? done : x)) : [...views, done]);
    setFinder(workspaceId, { viewId: done.id });
  };
  const onPick = (id: string) => {
    const [verb, value = ""] = id.split(/:(.*)/s);
    if (verb === "group") setSpec(workspaceId, { group: value as FindGroup });
    else if (verb === "sort") setSpec(workspaceId, { sort: value as FindSort });
    else if (verb === "layout") setSpec(workspaceId, { layout: value as FindSpec["layout"] });
    else if (verb === "view") {
      const v = views.find((x) => x.id === value);
      setFinder(workspaceId, { spec: v ? v.spec : DEFAULT_SPEC, viewId: v?.id ?? null, selected: new Set(), anchor: null });
    } else if (verb === "save" && active) void save({ id: active.id, name: active.name, spec }).catch(fail("The view was not saved"));
    else if (verb === "saveAs") setNaming({ name: "" });
    else if (verb === "rename" && active) setNaming({ id: active.id, name: active.name });
    else if (verb === "drop" && active)
      void request(env, "work.docs.dropView", { workspaceId, id: active.id }).then(() => {
        setViews(views.filter((x) => x.id !== active.id));
        setFinder(workspaceId, { viewId: null });
      }, fail("The view was not deleted"));
  };
  return (
    <>
      <RowsMenu
        label="View"
        align="end"
        className="w-56"
        trigger={
          <Button variant="ghost" size="sm" className="min-w-0 shrink">
            <SlidersHorizontal />
            <span className="max-w-32 truncate">{active?.name ?? "View"}</span>
          </Button>
        }
        rows={() => viewRows(spec, views, viewId)}
        onPick={onPick}
      />
      {naming ? (
        <NameDialog
          title={naming.id ? "Rename view" : "Save view"}
          name={naming.name}
          confirm={naming.id ? "Rename" : "Save"}
          onSave={(name) => save({ ...(naming.id ? { id: naming.id } : {}), name, spec: naming.id ? (views.find((v) => v.id === naming.id)?.spec ?? spec) : spec })}
          onClose={() => setNaming(null)}
        />
      ) : null}
    </>
  );
}

function NameDialog({ title, name, confirm, onSave, onClose }: { title: string; name: string; confirm: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title={title} size="sm" busy={pending}>
      <NameBody name={name} confirm={confirm} onSave={onSave} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function NameBody(p: { name: string; confirm: string; onSave: (name: string) => Promise<void>; onClose: () => void; pending: boolean; setPending: (b: boolean) => void }) {
  const close = useModalClose();
  const [name, setName] = useState(p.name);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const words = name.trim();
        if (!words) return setError("Name the view");
        setError(null);
        p.setPending(true);
        p.onSave(words).then(
          () => {
            p.setPending(false);
            close ? close(p.onClose) : p.onClose();
          },
          (err: unknown) => {
            p.setPending(false);
            setError(refusalWords(err) || "It was not saved");
          },
        );
      }}
    >
      <ModalBody>
        <Field label="Name">
          <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Budgets this quarter" autoComplete="off" />
        </Field>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={p.onClose} confirmLabel={p.confirm} pending={p.pending} />
    </form>
  );
}

/** The composer takes this many chips. */
const ASK_MOST = 8;

function Picked(props: WorkViewProps) {
  const { selected } = useFinder(props.workspace.id);
  const { answer } = useFound(props.workspace.id);
  const chips = (answer?.entries ?? []).filter((e) => selected.has(e.key)).flatMap((e) => chipOf(e) ?? []);
  const over = chips.length > ASK_MOST;
  const ask = (
    <Button variant="ghost" size="sm" disabled={!chips.length || over} onClick={() => props.startThread(chips)}>
      Ask
    </Button>
  );
  return (
    <>
      <span className="ps-2 text-xs text-muted-foreground tabular-nums">{selected.size} selected</span>
      {over ? <Tip label={`Ask takes up to ${ASK_MOST}`}>{ask}</Tip> : ask}
      <Tip label="Clear selection">
        <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={() => setFinder(props.workspace.id, { selected: new Set(), anchor: null })}>
          <X />
        </Button>
      </Tip>
    </>
  );
}

function NewDoc({ env, workspace, sector }: WorkViewProps) {
  const [making, setMaking] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={making}
      onClick={async () => {
        setMaking(true);
        try {
          const made = await request<{ source: CanvasSource; title: string }>(env, "work.docs.create", { sector, title: "Untitled" });
          setOpened(workspace.id, { source: made.source, title: made.title });
        } catch (err) {
          void loadToast().then((toast) => toast.error("The document was not made", { description: refusalWords(err) || undefined }));
        } finally {
          setMaking(false);
        }
      }}
    >
      <BusyLabel busy={making} label="New" />
    </Button>
  );
}

// ── The list ──

/**
 * Reads the workspace's list from its host: at once, again when LifeOS's catalog changes (its live
 * query is the signal) or the window comes back, and the text matches as he types, once typing rests.
 */
/** Per workspace, the last reply asked and the last applied: a slower, older reply never puts back an older list. */
const replies = new Map<string, { asked: number; applied: number }>();

function useLoad({ env, workspace, sector, lifeos }: WorkViewProps, attempt: number): void {
  const workspaceId = workspace.id;
  const { spec } = useFinder(workspaceId);
  const query = spec.query.trim();
  // A cheap signal (the sector's newest edit), not the catalog itself: the host reads the catalog.
  const live = useLifeosQuery<unknown>(lifeos, "catalog:stamp", { sector });
  const changed = live.status === "ready" ? JSON.stringify(live.value) : null;
  const read = useCallback(
    (q: string, refresh: boolean) => {
      const order = replies.get(workspaceId) ?? { asked: 0, applied: 0 };
      replies.set(workspaceId, order);
      const n = ++order.asked;
      return request<FindAnswer>(env, "work.docs.find", { workspaceId, ...(q ? { query: q } : {}), ...(refresh ? { refresh: true } : {}) }).then(
        (answer) => {
          const now = finderOf(workspaceId).spec.query.trim();
          const newest = n > order.applied;
          if (newest) order.applied = n;
          setFound(workspaceId, {
            ...(newest ? { answer, error: null } : {}),
            // The matches of the query in hand are kept whatever order replies come in.
            ...(q && q === now ? { hits: new Map(answer.hits.map((h) => [h.key, h.snippet])), hitsFor: q, searching: false } : {}),
          });
        },
        (err: unknown) => setFound(workspaceId, (f) => ({ error: f.answer ? f.error : refusalWords(err) || "The host did not answer", searching: false })),
      );
    },
    [env, workspaceId],
  );
  useEffect(() => {
    void read(finderOf(workspaceId).spec.query.trim(), true);
    const again = () => void read(finderOf(workspaceId).spec.query.trim(), true);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [read, workspaceId, attempt, changed]);
  useEffect(() => {
    if (!query) {
      setFound(workspaceId, { searching: false, hits: new Map(), hitsFor: "" });
      return;
    }
    setFound(workspaceId, { searching: true });
    const t = setTimeout(() => void read(query, false), SEARCH_REST_MS);
    return () => clearTimeout(t);
  }, [query, read, workspaceId]);
}

function DocList(props: WorkViewProps) {
  const workspaceId = props.workspace.id;
  const [attempt, setAttempt] = useState(0);
  useLoad(props, attempt);
  const found = useFound(workspaceId);
  const { spec, selected } = useFinder(workspaceId);
  const shown = useShown(workspaceId);
  const groups = useMemo(() => (shown ? groupRows(shown.rows, spec.group, shown.projects) : null), [shown, spec.group]);
  const order = useMemo(() => (groups ? groups.flatMap((g) => g.rows.map((r) => r.key)) : []), [groups]);
  // A row the search or a filter hides leaves the pick: Ask is about what he sees picked.
  useEffect(() => {
    if (!groups) return;
    const { selected: picked } = finderOf(workspaceId);
    const shownKeys = new Set(order);
    if ([...picked].some((k) => !shownKeys.has(k))) setFinder(workspaceId, { selected: new Set([...picked].filter((k) => shownKeys.has(k))) });
  }, [groups, order, workspaceId]);

  const retry = () => {
    setFound(workspaceId, { error: null });
    setAttempt((n) => n + 1);
  };
  if (!found.answer && found.error) return <EmptyState title="Docs did not load" line={found.error} action={{ label: "Retry", onClick: retry }} />;
  if (!groups || !shown)
    return (
      <div aria-busy className="mx-auto flex max-w-[720px] flex-col gap-3 px-6 py-5">
        <Skeleton className="h-3 w-[18%]" />
        <Skeleton className="h-3 w-[70%]" />
        <Skeleton className="h-3 w-[56%]" />
        <Skeleton className="h-3 w-[62%]" />
      </div>
    );
  const searched = !!spec.query.trim();
  const filtered = filterCount(spec.filter) > 0;
  const narrowed = searched || filtered;
  // The host listed what it could and says LifeOS did not answer for the rest. While the frame's own line says LifeOS did
  // not answer, that is the one line and its Retry: the view draws none of its own (DESIGN.md: never a second banner).
  const frameSays = props.lifeos.state === "unreachable";
  const lifeosLine = found.answer?.lifeos && !frameSays ? <ViewStateLine word="LifeOS did not answer" detail={found.answer.lifeos} onRetry={retry} /> : null;
  if (!shown.rows.length) {
    if (found.searching) return <LoadingLine label="Searching…" />;
    // Nothing listed because LifeOS did not answer is not "no documents": the line says it, once, over nothing.
    if (!narrowed) return found.answer?.lifeos ? lifeosLine : <EmptyState title="No documents" />;
    // The action names what it clears: the search, the filters, or both.
    const clear = searched && filtered ? "Clear" : searched ? "Clear search" : "Clear filters";
    return (
      <>
        {lifeosLine}
        <EmptyState title="No matches" action={{ label: clear, onClick: () => setSpec(workspaceId, { query: "", filter: {} }) }} />
      </>
    );
  }

  const onPick = (key: string, range: boolean) => setFinder(workspaceId, (s) => pick(order, s, key, range));
  const byKey = new Map(shown.rows.map((r) => [r.key, r]));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-find-row]");
    const key = row?.dataset.findRow;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-find-row]")];
    const at = row ? rows.indexOf(row) : -1;
    const mod = modKey(e);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[at + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) next.focus();
      else if (e.key === "ArrowUp") (e.currentTarget.closest('[role="region"]') ?? document).querySelector<HTMLInputElement>('[role="search"] input')?.focus();
      if (e.shiftKey && key && next?.dataset.findRow) {
        if (!finderOf(workspaceId).anchor) onPick(key, false);
        onPick(next.dataset.findRow, true);
      }
    } else if ((e.key === " " || e.key === "x") && key) {
      e.preventDefault();
      onPick(key, e.shiftKey);
    } else if (mod && e.key === "a") {
      e.preventDefault();
      setFinder(workspaceId, { selected: new Set(order), anchor: null });
    } else if (e.key === "Escape" && selected.size) {
      e.preventDefault();
      setFinder(workspaceId, { selected: new Set(), anchor: null });
    } else if (e.key === "Enter" && key && byKey.get(key)) {
      e.preventDefault();
      openEntry(props, byKey.get(key)!);
    }
  };
  const list = { workspaceId, groups, selected, projects: shown.projects, spec, onPick, onOpen: (e: FindEntry) => openEntry(props, e) };
  return (
    <>
      {lifeosLine}
      <div data-find-list={workspaceId} onKeyDown={onKeyDown} className={`mx-auto w-full py-5 ${spec.layout === "table" ? "max-w-[1040px] px-6" : "max-w-[720px] ps-7 pe-6"}`}>
        {spec.layout === "table" ? <TableLayout {...list} /> : <ListLayout {...list} />}
        {found.answer && !found.answer.complete ? <p className="mt-4 text-xs text-muted-foreground">Older items are not listed.</p> : null}
      </div>
    </>
  );
}

interface LayoutProps {
  workspaceId: string;
  groups: ReturnType<typeof groupRows>;
  selected: ReadonlySet<string>;
  projects: ReadonlyMap<string, string>;
  spec: FindSpec;
  onPick: (key: string, range: boolean) => void;
  onOpen: (e: FindEntry) => void;
}

/** What waits on it, as one comma sentence: "2 to review, held". */
export function waitWords(e: FindEntry): string {
  const out: string[] = [];
  if (e.comments + e.waiting) out.push(`${e.comments + e.waiting} to review`);
  if (e.held) out.push("held");
  return out.join(", ");
}

const at = (e: FindEntry, spec: FindSpec) => (spec.sort === "created" ? e.createdAt : e.editedAt);

function Pick({ e, on, onPick, shown }: { e: FindEntry; on: boolean; onPick: LayoutProps["onPick"]; shown: boolean }) {
  return (
    <span
      className={cn("flex size-4 shrink-0 items-center", !shown && reveal("row", { row: true, overlay: true }))}
      onClickCapture={(ev) => {
        // Shift reaches through Base UI's checkbox as a range.
        if (ev.shiftKey) {
          ev.preventDefault();
          ev.stopPropagation();
          onPick(e.key, true);
        }
      }}
    >
      <Checkbox tabIndex={-1} aria-label={`Select ${e.title}`} checked={on} onCheckedChange={() => onPick(e.key, false)} />
    </span>
  );
}

function GroupHead({ label, first }: { label: string; first: boolean }): ReactNode {
  return label ? <h2 className={`mb-1 text-xs font-medium text-muted-foreground ${first ? "" : "mt-5"}`}>{label}</h2> : null;
}

function ListLayout({ groups, selected, spec, onPick, onOpen }: LayoutProps) {
  const picking = selected.size > 0;
  return (
    <div role="list" aria-label="Documents">
      {groups.map((g, i) => (
        <section key={g.key} aria-label={g.label || undefined}>
          <GroupHead label={g.label} first={i === 0} />
          {g.rows.map((e) => {
            const Icon = KIND_ICON[e.kind];
            const wait = waitWords(e);
            return (
              <div key={e.key} role="listitem" className="group/row relative">
                {/* The box hangs in the gutter, so titles keep their line under the group's name, 4px clear of a picked row's fill. */}
                <span className="absolute -start-7 top-2">
                  <Pick e={e} on={selected.has(e.key)} onPick={onPick} shown={picking} />
                </span>
                <ItemButton
                  data-find-row={e.key}
                  size="xs"
                  onClick={(ev) => (ev.shiftKey || modKey(ev) ? onPick(e.key, ev.shiftKey) : onOpen(e))}
                  className={`-mx-2 min-h-8 w-[calc(100%+16px)] min-w-0 flex-nowrap rounded-md py-1.5 text-[13px] ${selected.has(e.key) ? "bg-muted" : ""} ${ROW_PRESS}`}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 self-start text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-foreground">{e.title}</span>
                    {e.snippet ? <span className="truncate text-xs text-muted-foreground">{e.snippet}</span> : null}
                  </span>
                  {wait ? <span className="mt-0.5 shrink-0 self-start text-xs text-muted-foreground tabular-nums">{wait}</span> : null}
                  <span className="mt-0.5 shrink-0 self-start text-xs text-muted-foreground tabular-nums">{dayTime(at(e, spec))}</span>
                </ItemButton>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function TableLayout({ groups, selected, projects, spec, onPick, onOpen }: LayoutProps) {
  const picking = selected.size > 0;
  // A column the grouping already names says nothing new.
  const cols = { kind: spec.group !== "kind", project: spec.group !== "project", where: spec.group !== "where" };
  const span = 4 + Number(cols.kind) + Number(cols.project) + Number(cols.where);
  return (
    <Table aria-label="Documents">
      <TableHeader>
        <TableRow>
          <TableHead className="w-6" aria-label="Select" />
          <TableHead>Name</TableHead>
          {cols.kind ? <TableHead>Kind</TableHead> : null}
          {cols.project ? <TableHead>Project</TableHead> : null}
          {cols.where ? <TableHead>Place</TableHead> : null}
          <TableHead>Edited by</TableHead>
          <TableHead className="text-end">{spec.sort === "created" ? "Created" : "Edited"}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.flatMap((g) => [
          ...(g.label
            ? [
                <TableRow key={`g:${g.key}`} className="border-0">
                  <TableHead colSpan={span} scope="colgroup" className="h-9 pt-3 align-bottom">
                    {g.label}
                  </TableHead>
                </TableRow>,
              ]
            : []),
          ...g.rows.map((e) => {
            const Icon = KIND_ICON[e.kind];
            const wait = waitWords(e);
            return (
              <TableRow key={e.key} data-state={selected.has(e.key) ? "selected" : undefined} className="group/row">
                <TableCell className="w-6">
                  <Pick e={e} on={selected.has(e.key)} onPick={onPick} shown={picking} />
                </TableCell>
                <TableCell className="max-w-0 w-[40%]">
                  <ItemButton
                    data-find-row={e.key}
                    size="xs"
                    onClick={(ev) => (ev.shiftKey || modKey(ev) ? onPick(e.key, ev.shiftKey) : onOpen(e))}
                    className={`-mx-2 h-8 w-[calc(100%+16px)] min-w-0 flex-nowrap rounded-md py-0 text-[13px] ${ROW_PRESS}`}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-foreground">{e.title}</span>
                    {wait ? <span className="shrink-0 text-xs text-muted-foreground">{wait}</span> : null}
                  </ItemButton>
                </TableCell>
                {cols.kind ? <TableCell className="text-muted-foreground">{FIND_KIND_WORDS[e.kind]}</TableCell> : null}
                {cols.project ? <TableCell className="max-w-40 truncate text-muted-foreground">{(e.projectId && projects.get(e.projectId)) || ""}</TableCell> : null}
                {cols.where ? <TableCell className="text-muted-foreground">{FIND_WHERE_WORDS[e.where]}</TableCell> : null}
                <TableCell className="text-muted-foreground">{e.lastBy ? FIND_BY_WORDS[e.lastBy] : ""}</TableCell>
                <TableCell className="text-end text-muted-foreground">{dayTime(at(e, spec))}</TableCell>
              </TableRow>
            );
          }),
        ])}
      </TableBody>
    </Table>
  );
}

// ── A document opened here ──

function OpenDoc({ env, workspace, doc }: WorkViewProps & { doc: Opened }) {
  const [attempt, setAttempt] = useState(0);
  const got = useOpened(env, doc.source, attempt);
  const [scrollTop, setScrollTop] = useState(0);
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-2">
        <Button variant="ghost" size="xs" onClick={() => setOpened(workspace.id, null)}>
          <ChevronLeft className="size-3.5" />
          Docs
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <Scroller scrollTop={scrollTop} onScroll={setScrollTop}>
          {(width) =>
            got && "open" in got ? (
              <ViewDoc key={got.open.doc} host={got.host} open={got.open} margin={width >= MARGIN_FROM} />
            ) : got && "error" in got ? (
              <EmptyState title="It did not open" line={got.error} action={{ label: "Retry", onClick: () => setAttempt((n) => n + 1) }} />
            ) : (
              <div aria-busy className="mx-auto flex max-w-[724px] flex-col gap-2.5 pl-[52px]">
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="mt-4 h-3 w-[92%]" />
                <Skeleton className="h-3 w-[78%]" />
              </div>
            )
          }
        </Scroller>
      </div>
    </div>
  );
}

function ViewDoc({ host, open, margin }: { host: DocHost; open: DocOpen; margin: boolean }) {
  const doc = useDocument(host, open);
  return <DocumentFrame doc={doc} open={open} margin={margin} />;
}

/** For tests: the opened documents forgotten. */
export function resetOpened(): void {
  opened.clear();
}
