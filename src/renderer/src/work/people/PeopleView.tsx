import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { makeFunctionReference } from "convex/server";
import type { ContextChip } from "@shared/work";
import { formatDue, formatStamp, formatTime } from "work-kit/views/lib/format";
import { ArrowLeft, Search, X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { GroupInput, InputGroup } from "../../components/ui/input";
import { ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { chordKey } from "../../lib/keys";
import { openWorkView, useWorkView, workSwitch } from "../../lib/workSwitch";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { guestsCall, type GuestLinkRow } from "../guests/api";
import { openDocInFiles, openInFiles } from "../files/openFrom";
import { sayError } from "../canvas/frame";
import { readAnswered, type AnsweredForm } from "../msforms/answered";
import { Face } from "../mail/face";
import { mailTo, writeMail } from "../mail/mailto";
import { sessionWaits, useLifeosQuery, type LifeosSession } from "../shell/lifeos";
import { downOf } from "../shell/lifeosDown";
import { keepPlace, keptPlace } from "../shell/place";
import type { WorkViewProps } from "../views/registry";
import { SEARCH_FIELD } from "../views/searchField";
import { useMinute } from "../tasks/minute";
import { useKeptRows, WindowedRows, type RowPlace } from "../windowed";
import { faceMap, findPeople, linksFor, linkWords, pageIsQuiet, personFor, pictureOf, type DirectoryPerson, type FaceRow, type PageEvent, type PersonPage, type SharedTable } from "./model";

/**
 * The People view of a linked Work workspace (docs/agents/work-people.md):
 * the sector's people from LifeOS, newest contact first, and one person's
 * page: who they are, then what is live with them here (mail, events, the
 * tasks that name them, what is shared with them). Every row opens where
 * that thing already opens. Nothing here sends: Write opens Mail's own
 * composer, whose send is held as always.
 */

// ── Where each workspace's view stands: the list (with its search) or a person's page ──

type Place = { person: string | null; query: string };
const places = new Map<string, Place>();
const placeListeners = new Set<() => void>();
const NOWHERE: Place = { person: null, query: "" };

/** The person's page as the record gave it (lib/workReturn.ts), by workspace, until the view moves off it: a gone one gives way to the list. */
const keptPerson = new Map<string, string>();

/** A workspace's place, first read from the record a window before this one left: the person's page; a search is not kept. */
export function placeOf(workspaceId: string): Place {
  let place = places.get(workspaceId);
  if (!place) {
    place = { ...NOWHERE, person: keptPlace<Place>(workspaceId, "people", { person: "string" }).person ?? null };
    places.set(workspaceId, place);
    if (place.person) keptPerson.set(workspaceId, place.person);
  }
  return place;
}
export function setPlace(workspaceId: string, patch: Partial<Place>): void {
  const place = { ...placeOf(workspaceId), ...patch };
  places.set(workspaceId, place);
  if (place.person !== keptPerson.get(workspaceId)) keptPerson.delete(workspaceId);
  keepPlace(workspaceId, "people", { person: place.person });
  for (const l of placeListeners) l();
}
function usePlace(workspaceId: string): Place {
  return useSyncExternalStore(
    (l) => {
      placeListeners.add(l);
      return () => placeListeners.delete(l);
    },
    () => placeOf(workspaceId),
  );
}

// ── LifeOS reads ──

const useDirectory = (lifeos: LifeosSession, sector: string) => useLifeosQuery<DirectoryPerson[]>(lifeos, "people:directory", { sector });

/** Address to picture, from Mail's own index, so a person has the face Mail gives them. */
function useFaces(lifeos: LifeosSession): ReadonlyMap<string, string> {
  const rows = useLifeosQuery<FaceRow[]>(lifeos, "mail:faces", {});
  const base = (lifeos.client as { url?: string } | null)?.url;
  const value = rows.status === "ready" ? rows.value : undefined;
  return useMemo(() => faceMap(value, base ? `${base}/api/storage/` : null), [value, base]);
}

/** The person's chip, as the composer's `@` makes it. */
export const personChip = (p: { _id: string; name: string }): ContextChip => ({ kind: "person", label: p.name, ref: { at: "lifeos", table: "people", id: p._id } });

// ── The header ──

/** In place of the view's name on a person's page: the way back to the list, then whose page it is. */
export function Title(props: WorkViewProps) {
  const { person } = usePlace(props.workspace.id);
  const directory = useDirectory(props.lifeos, props.sector);
  if (!person) return <span className="font-medium text-foreground">People</span>;
  const name = directory.status === "ready" ? directory.value.find((p) => p._id === person)?.name : undefined;
  return <BackTitle name={name} onBack={() => setPlace(props.workspace.id, { person: null })} />;
}

/** The way back, one shape on every Work screen (docs/DESIGN.md "Project screens"): a 24px arrow, where it goes, then where he is, muted. */
export function BackTitle({ name, onBack }: { name: string | undefined; onBack: () => void }) {
  return (
    <span className="flex min-w-0 items-center gap-1 font-medium text-foreground">
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Back to People" className="-ms-1.5 shrink-0 text-muted-foreground" onClick={onBack}>
        <ArrowLeft />
      </Button>
      <span className="min-w-0 truncate">People</span>
      {name ? <span className="min-w-0 truncate font-normal text-muted-foreground">{name}</span> : null}
    </span>
  );
}

/** The list's search; on a page, Write (when they have an address) and New thread. */
export function Head(props: WorkViewProps) {
  const { person } = usePlace(props.workspace.id);
  const directory = useDirectory(props.lifeos, props.sector);
  // The search and a page's verbs act on what LifeOS read: a session that is down has no list or page under them.
  if (downOf(props.lifeos)) return null;
  if (!person) return <SearchField workspaceId={props.workspace.id} />;
  const who = directory.status === "ready" ? directory.value.find((p) => p._id === person) : undefined;
  if (!who) return null;
  return (
    <PageVerbs
      canWrite={who.emails.length > 0}
      onWrite={() => {
        writeMail(mailTo(who.emails.slice(0, 1)));
        openWorkView({ workspaceId: props.workspace.id, view: "mail" });
      }}
      onThread={() => props.startThread(personChip(who))}
    />
  );
}

/** A page's two verbs: Write (a new mail to them, in Mail's own composer) when they have an address, and New thread about them. */
export function PageVerbs({ canWrite, onWrite, onThread }: { canWrite: boolean; onWrite: () => void; onThread: () => void }) {
  return (
    <div className="flex items-center gap-1">
      {canWrite ? (
        <Button variant="ghost" size="sm" onClick={onWrite}>
          Write
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" onClick={onThread}>
        New thread
      </Button>
    </div>
  );
}

function SearchField({ workspaceId }: { workspaceId: string }) {
  const { query } = usePlace(workspaceId);
  const input = useRef<HTMLInputElement>(null);
  // "/" puts the caret in the search, as in every list he searches; never while typing elsewhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || chordKey(e)) return;
      const at = document.activeElement as HTMLElement | null;
      if (at && (at.tagName === "INPUT" || at.tagName === "TEXTAREA" || at.isContentEditable)) return;
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
        query ? (
          <Button variant="ghost" size="icon-xs" aria-label="Clear search" onClick={() => setPlace(workspaceId, { query: "" })}>
            <X />
          </Button>
        ) : null
      }
    >
      <GroupInput
        ref={input}
        aria-label="Search people"
        placeholder="Search"
        value={query}
        onChange={(e) => setPlace(workspaceId, { query: e.currentTarget.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (query) setPlace(workspaceId, { query: "" });
            else input.current?.blur();
            e.preventDefault();
          } else if (e.key === "ArrowDown" || e.key === "Enter") {
            const first = document.querySelector<HTMLElement>(`[data-people-list="${CSS.escape(workspaceId)}"] [data-person-row]`);
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

// ── The body ──

/**
 * A LifeOS read that failed, with Retry: his press asks LifeOS once while the failure stays, Retry spinning in place;
 * an answer starts the live read again (`onBack`), a failure says its own words where the old ones stood.
 */
function ReadFailed({ title, error, session, name, args, onBack }: { title: string; error: string; session: LifeosSession; name: string; args: Record<string, unknown>; onBack(): void }) {
  const [retrying, setRetrying] = useState(false);
  const [failedAgain, setFailedAgain] = useState(false);
  const retry = (): void => {
    const client = session.client;
    if (!client) return;
    setRetrying(true);
    void client
      .query(makeFunctionReference<"query">(name), args)
      .then(onBack, () => setFailedAgain(true))
      .finally(() => setRetrying(false));
  };
  return <EmptyState title={title} line={failedAgain ? undefined : error} action={{ label: "Retry", busy: retrying, onClick: retry }} />;
}

/** The view, read anew (its live reads too) once a Retry's own read has answered. */
export function View(props: WorkViewProps) {
  const [round, setRound] = useState(0);
  return <PeopleBody key={round} {...props} again={() => setRound((n) => n + 1)} />;
}

function PeopleBody({ again, ...props }: WorkViewProps & { again(): void }) {
  const workspaceId = props.workspace.id;
  const { person } = usePlace(workspaceId);
  const directory = useDirectory(props.lifeos, props.sector);
  const faces = useFaces(props.lifeos);
  // A page asked for from elsewhere (a sender in Mail, an attendee in Agenda, a sent chip): an id, or an address
  // read against the list once it is here. Taken once, then cleared; an address no one here has is put in the search.
  const wanted = useWorkView();
  const ask = wanted?.workspaceId === workspaceId && wanted.view === "people" ? wanted.person : undefined;
  const rows = directory.status === "ready" ? directory.value : null;
  useEffect(() => {
    if (!ask) return;
    if (ask.includes("@") && !rows) return;
    const found = rows ? personFor(rows, ask) : undefined;
    if (found || !ask.includes("@")) setPlace(workspaceId, { person: found?._id ?? ask });
    else setPlace(workspaceId, { person: null, query: ask });
    openWorkView({ workspaceId, view: "people" });
  }, [ask, rows, workspaceId]);

  // A session that cannot read is the frame's to say (its sign-in or its line), never a second banner here, a kept
  // person's page included: the person stays chosen, and their page comes back once Retry brings the session.
  if (!props.lifeos.client && !sessionWaits(props.lifeos)) return null;
  if (person) return <PersonPageView {...props} person={person} faces={faces} />;
  if (!props.lifeos.client) return <ListSkeleton />;
  if (directory.status === "failed") return <ReadFailed title="People did not load" error={directory.error} session={props.lifeos} name="people:directory" args={{ sector: props.sector }} onBack={again} />;
  if (!rows) return <ListSkeleton />;
  return <PeopleList workspaceId={workspaceId} rows={rows} faces={faces} />;
}

function ListSkeleton() {
  return (
    // At the list's own insets, so the names do not step sideways when the list lands.
    <div aria-busy className="mx-auto flex w-full max-w-[720px] flex-col gap-2 px-6 py-5">
      {[44, 32, 52, 38, 46].map((w, i) => (
        <div key={i} className="flex h-8 items-center gap-2">
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-3" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Up and down between rows; up from the first goes back to the search. */
function moveBetweenRows(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-person-row], [data-page-row]");
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-person-row], [data-page-row]")];
  const at = row ? all.indexOf(row) : -1;
  const next = all[at + (e.key === "ArrowDown" ? 1 : -1)];
  e.preventDefault();
  if (next) next.focus();
  else if (e.key === "ArrowUp") (e.currentTarget.closest('[role="region"]') ?? document).querySelector<HTMLInputElement>('[role="search"] input')?.focus();
}

export function PeopleList({ workspaceId, rows, faces, now }: { workspaceId: string; rows: readonly DirectoryPerson[]; faces: ReadonlyMap<string, string>; now?: number }) {
  const { query } = usePlace(workspaceId);
  // A push answers the whole directory again: each person who holds what they held stays the same object (M12).
  const kept = useKeptRows(rows, idOfPerson)!;
  const shown = useMemo(() => findPeople(kept, query), [kept, query]);
  const minute = useMinute();
  const at = now ?? minute;
  if (!rows.length) return <EmptyState title="No people" />;
  if (!shown.length) return <EmptyState title="No matches" action={{ label: "Clear search", onClick: () => setPlace(workspaceId, { query: "" }) }} />;
  return (
    <div role="list" aria-label="People" data-people-list={workspaceId} onKeyDown={moveBetweenRows} className="mx-auto w-full max-w-[720px] px-6 py-5">
      <WindowedRows
        count={shown.length}
        rowHeight={32}
        getKey={(index) => shown[index]!._id}
        sizeKey="work-people-list"
        render={(index, place) => {
          const p = shown[index]!;
          return <PersonRow key={p._id} workspaceId={workspaceId} person={p} picture={pictureOf(p.emails, faces)} stamp={p.lastAt ? formatStamp(p.lastAt, at) : null} place={place} />;
        }}
      />
    </div>
  );
}

const idOfPerson = (p: DirectoryPerson): string => p._id;

/** One person's row, drawn again only when what it shows changed: the minute's tick hands it the same stamp words. */
const PersonRow = memo(function PersonRow({ workspaceId, person: p, picture, stamp, place }: { workspaceId: string; person: DirectoryPerson; picture: string | undefined; stamp: string | null; place: RowPlace }) {
  return (
    <div role="listitem" {...place}>
      <ItemButton data-person-row={p._id} size="xs" onClick={() => setPlace(workspaceId, { person: p._id })} className={cn("-mx-2 h-8 w-[calc(100%+16px)] min-w-0 flex-nowrap gap-2 rounded-md text-[13px]", ROW_PRESS)}>
        <Face name={p.name} picture={picture} size="row" />
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className="shrink-0 truncate text-foreground">{p.name}</span>
          {p.emails[0] ? <span className="min-w-0 truncate text-xs text-muted-foreground">{p.emails[0]}</span> : null}
        </span>
        {stamp ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{stamp}</span> : null}
      </ItemButton>
    </div>
  );
});

// ── A person's page ──

/** The host's guest links as last read, by host: one read serves the people he opens one after another. */
const guestLinksKept = new Map<string, { at: number; rows: GuestLinkRow[] }>();
/** How long a read of the guest links serves another person's page before the host is asked again. */
export const GUEST_LINKS_KEEP_MS = 30_000;

/** The guest links the host keeps: read at most once in GUEST_LINKS_KEEP_MS a host; a host that cannot answer lists none (and is asked again next time). */
function useGuestLinks(env: string, person: string): GuestLinkRow[] | null {
  const fresh = (): GuestLinkRow[] | null => {
    const kept = guestLinksKept.get(env);
    return kept && Date.now() - kept.at < GUEST_LINKS_KEEP_MS ? kept.rows : null;
  };
  const [links, setLinks] = useState<{ person: string; rows: GuestLinkRow[] } | null>(() => {
    const rows = fresh();
    return rows ? { person, rows } : null;
  });
  useEffect(() => {
    const rows = fresh();
    if (rows) return void setLinks((was) => (was?.person === person && was.rows === rows ? was : { person, rows }));
    let live = true;
    guestsCall<GuestLinkRow[]>(env, "work.guests.list", {}).then(
      ({ value }) => {
        guestLinksKept.set(env, { at: Date.now(), rows: value });
        if (live) setLinks({ person, rows: value });
      },
      () => live && setLinks({ person, rows: [] }),
    );
    return () => {
      live = false;
    };
  }, [env, person]);
  return links?.person === person ? links.rows : null;
}

/** Tests and Work off: nothing kept. */
export function forgetGuestLinks(): void {
  guestLinksKept.clear();
}
// Work off on every host: no guest link of any host stays kept.
workSwitch.subscribe(() => {
  if (!workSwitch.anyOn()) forgetGuestLinks();
});

const NO_ANSWERS: AnsweredForm[] = [];

/** The job's Microsoft forms they answered, by their addresses. It may take a while (a form not read yet is read first): the section joins the page when it comes. */
function useAnswered(env: string, workspaceId: string, emails: readonly string[] | undefined): AnsweredForm[] {
  const key = emails?.join("\n") ?? "";
  const [got, setGot] = useState<{ key: string; rows: AnsweredForm[] } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    void readAnswered(env, workspaceId, key.split("\n")).then((rows) => {
      if (live) setGot({ key, rows });
    });
    return () => {
      live = false;
    };
  }, [env, workspaceId, key]);
  return got?.key === key ? got.rows : NO_ANSWERS;
}

function GoneToList({ workspaceId }: { workspaceId: string }) {
  useEffect(() => setPlace(workspaceId, { person: null }), [workspaceId]);
  return <PageSkeleton />;
}

function PersonPageView(props: WorkViewProps & { person: string; faces: ReadonlyMap<string, string> }) {
  const directory = useDirectory(props.lifeos, props.sector);
  const name = directory.status === "ready" ? directory.value.find((p) => p._id === props.person)?.name : undefined;
  const links = useGuestLinks(props.env, props.person);
  // The page is asked of LifeOS once, with the links in hand: asked before them, it was asked twice (no links, then the links).
  // Read anew (its live read too) once a Retry's own read has answered.
  const [round, setRound] = useState(0);
  if (links === null) return <PageSkeleton />;
  return <PersonPageRead key={round} {...props} directory={directory} name={name} links={links} again={() => setRound((n) => n + 1)} />;
}

function PersonPageRead(
  props: WorkViewProps & { person: string; faces: ReadonlyMap<string, string>; directory: ReturnType<typeof useDirectory>; name: string | undefined; links: GuestLinkRow[]; again(): void },
) {
  const { directory, name, links } = props;
  // The links made for them, by the name the list knows; LifeOS keeps those of this sector and says their titles now.
  const mine = useMemo(() => (name ? linksFor(links, name, Date.now()) : []), [links, name]);
  // LifeOS takes at most 50.
  const shared = useMemo(() => mine.slice(0, 50).map((l) => ({ table: l.source.table, id: l.source.id })), [mine]);
  const page = useLifeosQuery<PersonPage | null>(props.lifeos, "people:page", { id: props.person, sector: props.sector, shared });
  const answered = useAnswered(props.env, props.workspace.id, page.status === "ready" ? page.value?.person.emails : undefined);
  if (page.status === "failed")
    return <ReadFailed title="This page did not load" error={page.error} session={props.lifeos} name="people:page" args={{ id: props.person, sector: props.sector, shared }} onBack={props.again} />;
  // Held until the links are read too, so the page lands once rather than growing a section.
  if (page.status === "loading" || (directory.status === "loading" && !name)) return <PageSkeleton />;
  // A page kept from a window before this one whose person is gone: the list, quietly.
  if (!page.value && keptPerson.get(props.workspace.id) === props.person) return <GoneToList workspaceId={props.workspace.id} />;
  if (!page.value)
    return <EmptyState title="Not in People here" action={{ label: "Back to People", onClick: () => setPlace(props.workspace.id, { person: null }) }} />;
  return <PersonPageBody {...props} page={page.value} links={mine} answered={answered} />;
}

function PageSkeleton() {
  return (
    <div aria-busy className="mx-auto flex w-full max-w-[720px] flex-col px-6 py-6">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-[28%]" />
          <Skeleton className="h-3 w-[40%]" />
        </div>
      </div>
      <div className="mt-8 flex flex-col gap-3">
        <Skeleton className="h-3 w-[12%]" />
        <Skeleton className="h-3 w-[64%]" />
        <Skeleton className="h-3 w-[52%]" />
      </div>
    </div>
  );
}

/** When an event is: its day and time, or its day alone for one that lasts the day. */
const eventWhen = (e: PageEvent, now: number): string => (e.allDay ? formatDue(e.startsAt, now) : `${formatDue(e.startsAt, now)}, ${formatTime(e.startsAt)}`);

export function PersonPageBody({
  workspace,
  faces,
  page,
  links,
  answered = NO_ANSWERS,
  startThread,
  now = Date.now(),
}: Pick<WorkViewProps, "workspace" | "startThread"> & { faces: ReadonlyMap<string, string>; page: PersonPage; links: readonly GuestLinkRow[]; answered?: readonly AnsweredForm[]; now?: number }) {
  const { person } = page;
  const workspaceId = workspace.id;
  const go = (view: string, target: Record<string, unknown>) => openWorkView({ workspaceId, view, ...target });
  const linkOf = new Map(links.map((l) => [`${l.source.table}:${l.source.id}`, l]));
  const openShared = (table: SharedTable, id: string, title: string) => {
    if (table === "docs") void openDocInFiles(workspaceId, { id, title });
    else if (table === "projects") go("projects", { project: id });
    // A sheet opens in a thread about it.
    else startThread({ kind: "selection", label: title, ref: { at: "lifeos", table: "sheets", id } });
  };
  const openForm = (f: AnsweredForm) =>
    void openInFiles(workspace, { ref: { at: "msform", host: workspace.environmentId, workspaceId, formId: f.formId, tenant: f.tenant }, name: f.title }).catch((err: unknown) => sayError(err, "Couldn't open the form"));
  const asked = page.tasks.filter((t) => t.relation === "asked");
  const waiting = page.tasks.filter((t) => t.relation === "waiting");
  const contact = [...person.emails, ...person.phones];
  return (
    <div onKeyDown={moveBetweenRows} className="mx-auto w-full max-w-[720px] px-6 py-6">
      <header className="flex items-center gap-3">
        <Face name={person.name} picture={pictureOf(person.emails, faces)} size="page" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="truncate text-base leading-6 font-semibold tracking-[-0.01em] text-foreground">{person.name}</h1>
          {contact.length ? (
            <p className="truncate text-xs text-muted-foreground">
              {contact.map((c, i) => (
                <span key={c} className="select-text">
                  {c}
                  {i < contact.length - 1 ? ", " : null}
                </span>
              ))}
            </p>
          ) : null}
        </div>
      </header>
      {person.notes.trim() ? <p className="mt-4 max-w-[65ch] text-sm leading-[22px] whitespace-pre-line text-foreground select-text">{person.notes.trim()}</p> : null}
      {pageIsQuiet(page) && !answered.length ? <p className="mt-6 text-[13px] text-muted-foreground">Nothing live with them here.</p> : null}

      <Section label="Mail" show={page.mail.length > 0}>
        {page.mail.map((m) => (
          <PageRow key={m._id} title={m.subject || "(no subject)"} strong={m.unread} line={m.snippet} trail={formatStamp(m.lastMessageAt, now)} onOpen={() => go("mail", { mail: m._id })} />
        ))}
      </Section>
      <Section label="Coming up" show={page.coming.length > 0}>
        {page.coming.map((e) => (
          <PageRow key={e._id} title={e.title} line={e.location} trail={eventWhen(e, now)} onOpen={() => go("agenda", { event: e._id })} />
        ))}
      </Section>
      <Section label="Asked for by them" show={asked.length > 0}>
        {asked.map((t) => (
          <PageRow key={t._id} title={t.title} trail={t.dueAt !== undefined ? formatDue(t.dueAt, now) : undefined} onOpen={() => go("tasks", { task: t._id })} />
        ))}
      </Section>
      <Section label="Waiting on them" show={waiting.length > 0}>
        {waiting.map((t) => (
          <PageRow key={t._id} title={t.title} trail={t.dueAt !== undefined ? formatDue(t.dueAt, now) : undefined} onOpen={() => go("tasks", { task: t._id })} />
        ))}
      </Section>
      <Section label="Shared with them" show={page.shared.length > 0}>
        {page.shared.map((s) => {
          const link = linkOf.get(`${s.table}:${s.id}`);
          return <PageRow key={`${s.table}:${s.id}`} title={s.title || "Untitled"} line={link ? linkWords(link.role, link.expiresAt) : undefined} onOpen={() => openShared(s.table, s.id, s.title)} />;
        })}
      </Section>
      <Section label="Past meetings" show={page.recent.length > 0}>
        {page.recent.map((e) => (
          <PageRow key={e._id} title={e.title} line={e.location} trail={eventWhen(e, now)} onOpen={() => go("agenda", { event: e._id })} />
        ))}
      </Section>
      {/* Last: it may come after the page has landed, and grows nothing above it. */}
      <Section label="Answered" show={answered.length > 0}>
        {answered.map((f) => (
          <PageRow key={f.formId} title={f.title} trail={f.at !== null ? formatStamp(f.at, now) : undefined} onOpen={() => openForm(f)} />
        ))}
      </Section>
    </div>
  );
}

function Section({ label, show, children }: { label: string; show: boolean; children: ReactNode }) {
  if (!show) return null;
  return (
    <section aria-label={label} className="mt-6">
      <h2 className="mb-1 text-xs font-medium text-muted-foreground">{label}</h2>
      <div role="list">{children}</div>
    </section>
  );
}

/** One thing live with them: its title, a muted second line, its time at the end; a press opens it where it lives. */
function PageRow({ title, line, trail, strong, onOpen }: { title: string; line?: string | undefined; trail?: string | undefined; strong?: boolean; onOpen: () => void }) {
  return (
    <div role="listitem">
      <ItemButton data-page-row="" size="xs" onClick={onOpen} className={cn("-mx-2 min-h-8 w-[calc(100%+16px)] min-w-0 flex-nowrap rounded-md py-1.5 text-[13px]", ROW_PRESS)}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("truncate text-foreground", strong && "font-medium")}>{title}</span>
          {line ? <span className="truncate text-xs text-muted-foreground">{line}</span> : null}
        </span>
        {trail ? <span className="mt-0.5 shrink-0 self-start text-xs text-muted-foreground tabular-nums">{trail}</span> : null}
      </ItemButton>
    </div>
  );
}
