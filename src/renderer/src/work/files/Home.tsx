import { useState, type ReactNode } from "react";
import type { FileSearchFilter, FilesHome } from "@shared/contract-work-files";
import type { EditedWithin } from "@shared/work/docFind";
import { ENTRY_KIND_WORDS, type EntryKind, type FileEntry } from "@shared/work/files";
import { DialogFooter } from "../../chrome/ConfirmDialog";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { Modal, ModalBody } from "../../chrome/Modal";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { dayTime } from "../../lib/duration";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { ViewStateLine } from "../views/ViewStateLine";
import { KindGlyph } from "./KindGlyph";
import { whereWords, type Sidebar } from "./model";
import type { Busy } from "./open";
import { RowState } from "./rowParts";

/**
 * Home (docs/DESIGN.md "The Files place"): the page a new tab opens on. Three short lists from the workspace's
 * own host: what waits on him, what he starred, what he opened last; a list with nothing in it is left out.
 * A row opens on a press, as a link does: Home is for getting somewhere, not for managing files.
 */

/** A held file act's verb, as its row says it. */
const HELD_WORDS: Record<string, string> = { make: "New", rename: "Rename", move: "Move", copy: "Copy" };

function HomeList({ title, entries, busy, onOpen }: { title: string; entries: readonly FileEntry[]; busy: Busy; onOpen(entry: FileEntry): void }) {
  if (!entries.length) return null;
  return (
    <section aria-label={title} className="flex flex-col">
      <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{title}</h2>
      {entries.map((entry) => (
        <Button key={entry.key} variant="ghost" data-files-home-row={entry.key} disabled={busy?.key === entry.key} className="h-9 w-full min-w-0 justify-start gap-2 rounded-md px-2 text-[13px] font-normal" onClick={() => onOpen(entry)}>
          <KindGlyph kind={entry.kind} />
          <span className="min-w-0 flex-1 truncate text-start text-foreground">{entry.name}</span>
          {/* A change a thread holds for his press says its verb; the row opens the held item, not the file. */}
          {entry.held ? <span className="shrink-0 text-xs text-warning">{HELD_WORDS[entry.held.verb] ?? "A change"} waits for you</span> : <RowState entry={entry} />}
          {entry.where ? <span className="hidden max-w-[30%] shrink-0 truncate text-xs text-muted-foreground @[480px]/files-home:block">{whereWords(entry.where)}</span> : null}
          {entry.changed ? <span className="w-28 shrink-0 text-end text-xs text-muted-foreground tabular-nums">{dayTime(entry.changed)}</span> : null}
        </Button>
      ))}
    </section>
  );
}

export function HomePage({ panelId, home, error, busy, bar, onRetry, onOpen }: { panelId: string; home: FilesHome | null; error: string | null; busy: Busy; bar: ReactNode; onRetry(): void; onOpen(entry: FileEntry): void }) {
  const empty = !!home && !home.waiting.length && !home.starred.length && !home.recent.length;
  return (
    <div role="tabpanel" id={panelId} data-files-home className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {bar}
      {error ? <ViewStateLine word="Home did not load" detail={error} onRetry={onRetry} /> : null}
      <div className="@container/files-home flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        {!home ? (
          error ? null : (
            <div role="status" aria-label="Loading" aria-busy className="mx-auto flex w-full max-w-3xl flex-col gap-1 p-4">
              {["w-[42%]", "w-[58%]", "w-[36%]", "w-[50%]"].map((w, i) => (
                <div key={i} className="flex h-9 items-center gap-2 px-2">
                  <Skeleton className="size-4 shrink-0 rounded-sm" />
                  <Skeleton className={`h-3 ${w}`} />
                </div>
              ))}
            </div>
          )
        ) : empty ? (
          <EmptyState title="Nothing here yet" line="Files you open and star show here." />
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
            <HomeList title="Waiting on you" entries={home.waiting} busy={busy} onOpen={onOpen} />
            <HomeList title="Starred" entries={home.starred} busy={busy} onOpen={onOpen} />
            <HomeList title="Recent" entries={home.recent} busy={busy} onOpen={onOpen} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── a search's filters ────────────────────────────────────────────────

const KINDS: readonly EntryKind[] = ["folder", "document", "sheet", "deck", "pdf", "picture", "video", "audio", "text", "archive"];
/** When it changed: a span before now, kept as its word so a saved search stays current. */
const WHEN: { id: EditedWithin | "any"; label: string }[] = [
  { id: "any", label: "Any time" },
  { id: "day", label: "Past day" },
  { id: "week", label: "Past 7 days" },
  { id: "month", label: "Past 30 days" },
  { id: "quarter", label: "Past 3 months" },
  { id: "year", label: "Past year" },
];

/** What a filter says, on its button: "Kind", or the kinds chosen. */
export const kindsWords = (kinds: readonly EntryKind[] | undefined): string => (!kinds?.length ? "Kind" : kinds.length === 1 ? ENTRY_KIND_WORDS[kinds[0]!] : `${kinds.length} kinds`);
/** Which of the When rows a filter is: its span, "dates" for fixed times (an older saved search's), else "any". */
export function whenOf(filter: Pick<FileSearchFilter, "within" | "after" | "before">): string {
  return filter.within ?? (filter.after !== undefined || filter.before !== undefined ? "dates" : "any");
}
const dateWords = (t: number): string => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
/** The When button's words: the span, or the fixed times a saved search holds. */
export function whenWords(filter: Pick<FileSearchFilter, "within" | "after" | "before">): string {
  const when = whenOf(filter);
  if (when !== "dates") return WHEN.find((row) => row.id === when)!.label;
  if (filter.after !== undefined && filter.before !== undefined) return `${dateWords(filter.after)} to ${dateWords(filter.before)}`;
  return filter.after !== undefined ? `Since ${dateWords(filter.after)}` : `Before ${dateWords(filter.before!)}`;
}

/** What a search can be narrowed to in More: the places the search reads, and the sector's projects. */
export interface FilterChoices {
  places: readonly { id: string; name: string }[];
  projects: readonly { id: string; name: string }[];
}

/** The places and projects More offers, from the sidebar: each place the search's host answers for, once. */
export function filterChoices(sidebar: Pick<Sidebar, "folder" | "lifeos" | "drives" | "rows" | "projects">, link: string | null): FilterChoices {
  const places = new Map<string, string>();
  for (const copy of [sidebar.folder, sidebar.lifeos, ...sidebar.drives]) if (copy && copy.link === link) places.set(copy.place.id, copy.place.name);
  for (const row of sidebar.rows) {
    const copy = row.copies.find((c) => c.link === link);
    if (copy && !places.has(copy.place.id)) places.set(copy.place.id, row.name);
  }
  const projects = sidebar.projects.flatMap((copy) => (copy.place.id.startsWith("project:") ? [{ id: copy.place.id.slice("project:".length), name: copy.place.name }] : []));
  return { places: [...places].map(([id, name]) => ({ id, name })), projects };
}

/** Who changed it, as More offers it: anyone, he, or a thread. A name an older saved search holds is shown as itself. */
const WHO: { id: string; label: string }[] = [
  { id: "", label: "Anyone" },
  { id: "me", label: "Me" },
  { id: "agent", label: "An agent" },
];

/** How many of More's parts are set: its button's count. */
export const moreCount = (f: FileSearchFilter): number => Number(!!f.places?.length) + Number(!!f.project) + Number(!!f.who) + Number(!!f.review);

/**
 * More's rows: Place, Project and Who as submenus (each offering what the search can read, and anything a saved
 * search already holds), Needs review, and Clear while any is set.
 */
export function moreRows(f: FileSearchFilter, choices: FilterChoices): MenuRow[] {
  const check = (id: string, label: string, on: boolean, keepOpen = true): MenuRow => ({ kind: "item", id, label, checked: on, keepOpen });
  const sub = (id: string, label: string, items: MenuRow[], set: number): MenuRow[] =>
    items.length ? [{ kind: "sub", id, label, items, ...(set ? { trailing: <span className="text-xs text-muted-foreground tabular-nums">{set}</span> } : {}) }] : [];
  const known = new Set(choices.places.map((p) => p.id));
  const places = [...choices.places, ...(f.places ?? []).filter((id) => !known.has(id)).map((id) => ({ id, name: "A place no longer listed" }))];
  const projects = f.project && !choices.projects.some((p) => p.id === f.project) ? [...choices.projects, { id: f.project, name: "A project no longer listed" }] : choices.projects;
  const who = f.who && !WHO.some((w) => w.id === f.who) ? [...WHO, { id: f.who, label: f.who }] : WHO;
  return [
    ...sub("place", "Place", places.map((p) => check(`place:${p.id}`, p.name, !!f.places?.includes(p.id))), f.places?.length ?? 0),
    ...sub("project", "Project", projects.map((p) => check(`project:${p.id}`, p.name, f.project === p.id, false)), f.project ? 1 : 0),
    ...sub("who", "Changed by", who.map((w) => check(`who:${w.id}`, w.label, (f.who ?? "") === w.id, false)), f.who ? 1 : 0),
    check("review", "Needs review", !!f.review),
    ...(moreCount(f) ? ([{ kind: "sep" }, { kind: "item", id: "clear", label: "Clear" }] satisfies MenuRow[]) : []),
  ];
}

/** A row of More picked: the filter it makes. A place toggles; a project, or who, is one at a time and a second press clears it. */
export function pickMore(f: FileSearchFilter, id: string): FileSearchFilter {
  const { places: _places, project: _project, who: _who, review: _review, ...rest } = f;
  if (id === "clear") return rest;
  const [part, value = ""] = id.split(/:(.*)/s);
  const next: FileSearchFilter = { ...f };
  if (part === "place") next.places = f.places?.includes(value) ? f.places.filter((p) => p !== value) : [...(f.places ?? []), value];
  else if (part === "project") next.project = f.project === value ? undefined : value;
  else if (part === "who") next.who = value || undefined;
  else if (part === "review") next.review = f.review ? undefined : true;
  return bare(next);
}

/** Drops the parts a filter holds as nothing (undefined, an empty list), so what is kept says only what is set. */
const bare = (f: FileSearchFilter): FileSearchFilter => {
  const next = { ...f };
  for (const key of Object.keys(next) as (keyof FileSearchFilter)[]) if (next[key] === undefined || (Array.isArray(next[key]) && !(next[key] as unknown[]).length)) delete next[key];
  return next;
};

/**
 * The bar under a page of search results: the kinds, when it changed, whether others can open it, More (the
 * place, the project, who changed it, and what needs review), and Save search… (a saved search is a row under
 * Starred; here it is Remove instead).
 */
export function SearchFilters({ filter, choices, saved, onFilter, onSave, onRemove }: { filter: FileSearchFilter; choices: FilterChoices; saved: boolean; onFilter(next: FileSearchFilter): void; onSave(): void; onRemove(): void }) {
  const kinds = filter.kinds ?? [];
  const when = whenOf(filter);
  const more = moreCount(filter);
  const kindRows: MenuRow[] = KINDS.map((kind) => ({ kind: "item", id: kind, label: ENTRY_KIND_WORDS[kind], checked: kinds.includes(kind), keepOpen: true }));
  const whenRows: MenuRow[] = WHEN.map((row) => ({ kind: "item", id: row.id, label: row.label, checked: when === row.id }));
  const set = (patch: Partial<FileSearchFilter>): void => onFilter(bare({ ...filter, ...patch }));
  return (
    <div data-files-filters className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
      <RowsMenu
        label="Kind"
        rows={kindRows}
        onPick={(id) => set({ kinds: kinds.includes(id as EntryKind) ? kinds.filter((k) => k !== id) : [...kinds, id as EntryKind] })}
        trigger={
          <Button variant="ghost" size="xs" className={kinds.length ? "text-foreground" : "text-muted-foreground"}>
            {kindsWords(kinds)}
          </Button>
        }
      />
      <RowsMenu
        label="When it changed"
        rows={whenRows}
        onPick={(id) => set({ within: id === "any" ? undefined : (id as EditedWithin), after: undefined, before: undefined })}
        trigger={
          <Button variant="ghost" size="xs" className={when !== "any" ? "text-foreground" : "text-muted-foreground"}>
            {whenWords(filter)}
          </Button>
        }
      />
      <Button variant="ghost" size="xs" aria-pressed={filter.shared === true} className={filter.shared ? "bg-muted text-foreground" : "text-muted-foreground"} onClick={() => set({ shared: filter.shared ? undefined : true })}>
        Others can open
      </Button>
      <RowsMenu
        label="More filters"
        rows={() => moreRows(filter, choices)}
        onPick={(id) => onFilter(pickMore(filter, id))}
        trigger={
          <Button variant="ghost" size="xs" aria-label={more ? `More filters, ${more} set` : "More filters"} className={more ? "text-foreground" : "text-muted-foreground"}>
            More
            {more ? <span className="text-muted-foreground tabular-nums">{more}</span> : null}
          </Button>
        }
      />
      <span className="flex-1" />
      {saved ? (
        <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onRemove}>
          Remove Saved Search
        </Button>
      ) : (
        <Button variant="ghost" size="xs" onClick={onSave}>
          Save Search…
        </Button>
      )}
    </div>
  );
}

/** Save search…: one field for its name. */
export function SaveSearchDialog({ query, onSave, onClose }: { query: string; onSave(name: string): Promise<void>; onClose(): void }) {
  const [name, setName] = useState(query);
  const [pending, setPending] = useState(false);
  const save = (): void => {
    if (!name.trim() || pending) return;
    setPending(true);
    void onSave(name.trim())
      .then(onClose)
      .finally(() => setPending(false));
  };
  return (
    <Modal
      onClose={onClose}
      title="Save search"
      size="sm"
      busy={pending}
      onKeyDown={(event) => {
        if (event.key === "Enter") save();
      }}
    >
      <ModalBody>
        <Input aria-label="Name" autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} disabled={!name.trim()} onConfirm={save} />
    </Modal>
  );
}
