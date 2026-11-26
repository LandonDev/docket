import { createElement, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Spinner } from "@renderer/components/ui/spinner";
import { ArrowLeft, RefreshCw } from "@renderer/chrome/icons";
import { Doc, Project, Table } from "@renderer/work/icons";
import { Face } from "@renderer/work/mail/face";
import { projectionLists, type GuestProjection } from "@shared/work/guestProjection";
import { frameFor, frameOf, keptHash } from "./frame";
import { wipeOffline } from "./offline";
import { tellPhone } from "./phone";
import { endWords, modeOf, OpenFailed, openWhenUp, Session, untilDay, type ChildItem, type Failure, type Opened, type Remembered } from "./session";
// The type alone: the sheet stays in its own lazy chunk.

/**
 * The hosted page (architecture §8.6; docs/DESIGN.md "The guest's page"):
 * one 44px line, the item's name, whose it is, what this person can do and
 * until when, the faces of who else is in it and their own; under it the
 * owner's own editor or grid. No
 * sign-in: the address is the key. Nothing here reaches a thread, an agent
 * or any other item, and no control a link may not use is drawn. A project's
 * link shows the project (ProjectPage.tsx); a document or sheet of it opens
 * in place, read only, with the way back in the line.
 */

const DocPage = lazy(() => import("./DocPage").then((m) => ({ default: m.DocPage })));
const SheetPage = lazy(() => import("./SheetPage").then((m) => ({ default: m.SheetPage })));
const ProjectPage = lazy(() => import("./ProjectPage").then((m) => ({ default: m.ProjectPage })));
const DocText = lazy(() => import("./ProjectPage").then((m) => ({ default: m.DocText })));
/** How often an open document of a project is read again: as often as the project itself. */
const READ_EVERY = 15_000;

const GLYPH = { doc: Doc, sheet: Table, project: Project } as const;

const CAN: Record<Opened["role"], string> = { view: "Can view", comment: "Can comment", edit: "Can edit" };

function useScheme(): "light" | "dark" {
  const q = useMemo(() => window.matchMedia("(prefers-color-scheme: dark)"), []);
  const [dark, setDark] = useState(q.matches);
  useEffect(() => {
    const on = () => setDark(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, [q]);
  useEffect(() => void document.documentElement.classList.toggle("theme-light", !dark), [dark]);
  return dark ? "dark" : "light";
}

const renewStore = {
  get: () => sessionStorage.getItem("tc-open-renew"),
  set: (v: string | null) => (v ? sessionStorage.setItem("tc-open-renew", v) : sessionStorage.removeItem("tc-open-renew")),
};

/** What this browser keeps of a guest's link between visits (session.ts `Remembered`); a browser that keeps nothing still opens the page. */
const memoryOf = (linkId: string) => ({
  get: () => {
    try {
      return localStorage.getItem(`tc-guest:${linkId}`);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) localStorage.setItem(`tc-guest:${linkId}`, v);
      else localStorage.removeItem(`tc-guest:${linkId}`);
    } catch {
      // private browsing: nothing is kept
    }
  },
});

/** Someone else in the file, as the editor or the grid tells of them. */
export interface Person {
  id: string;
  name: string;
  /** their caret's colour: the ring of their face */
  color: string;
}

export function GuestApp() {
  const scheme = useScheme();
  const session = useMemo(() => {
    const mode = modeOf(location.pathname, location.hash);
    return mode.kind === "none" ? null : new Session(mode, location.origin, renewStore, undefined, null, mode.kind === "guest" ? memoryOf(mode.id) : null);
  }, []);
  const [state, setState] = useState<{ at: "loading" } | { at: "open"; opened: Opened } | { at: "failed"; why: Failure }>(session ? { at: "loading" } : { at: "failed", why: "gone" });
  // The phone's own frame (frame.ts): read before the open takes the ticket from the address.
  const [chrome] = useState(() => frameOf(location.pathname, location.hash));
  const frame = useMemo(() => frameFor(chrome, window), [chrome]);

  // What this browser knew of the link before this visit: read before the open writes over it.
  const [kept] = useState<Remembered | null>(() => session?.remembered() ?? null);
  // A link that is over leaves nothing on this device: the copy an Edit link kept is wiped.
  const gone = useCallback(() => {
    if (session?.mode.kind === "guest") void wipeOffline(session.mode.id, (session.remembered() ?? kept)?.doc);
    // His pass ended (a restart of the host forgets them all): the phone around the page opens the file again.
    if (session?.mode.kind === "owner") tellPhone({ kind: "passEnded" });
    setState({ at: "failed", why: "gone" });
  }, [session, kept]);
  // Retry keeps the page that said why in view, its press spinning, until the link answers.
  const [retrying, setRetrying] = useState(false);
  const load = useCallback((again = false) => {
    if (!session) return;
    if (again) setRetrying(true);
    else setState({ at: "loading" });
    // A host that is starting is asked again under the same bones: a start is not an end.
    openWhenUp(() => session.refresh()).then(
      (opened) => {
        // The owner's ticket opens once: it leaves the address as soon as it has.
        if (session.mode.kind === "owner") {
          history.replaceState(null, "", location.pathname + keptHash(chrome));
          tellPhone({ kind: "opened" });
        }
        document.title = opened.title;
        setState({ at: "open", opened });
      },
      (err: unknown) => {
        const why = err instanceof OpenFailed ? err.why : "down";
        if (why === "gone") gone();
        else setState({ at: "failed", why });
      },
    ).finally(() => setRetrying(false));
  }, [session, gone, chrome]);
  useEffect(() => load(), [load]);
  const [people, setPeople] = useState<readonly Person[]>([]);
  // A sheet that never came: out of reach, with Retry. (One that has its sheet keeps trying under its own line.)
  const down = useCallback(() => setState({ at: "failed", why: "down" }), []);
  // A project's link: the document or sheet open over the project, and where the screens' controls go in the line.
  const [child, setChild] = useState<(ChildItem & { title: string }) | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // The line's first place, before the glyph: a task's way back goes there, where a document's does.
  const [lead, setLead] = useState<HTMLElement | null>(null);
  const back = useCallback(() => setChild(null), []);
  // The project stays under a document or sheet it opened: going back gives the focus to the row that opened it.
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback((item: ChildItem & { title: string }) => {
    opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    setChild(item);
  }, []);
  useEffect(() => {
    if (child || !opener.current) return;
    const to = opener.current;
    opener.current = null;
    if (to.isConnected) to.focus();
  }, [child]);
  // A document or sheet the project no longer lists is closed at the page's next read: its socket is already shut.
  const shown = useCallback((p: GuestProjection) => setChild((open) => (open && !projectionLists(p, open.table, open.id) ? null : open)), []);

  // A page that will draw no editor is drawn as it is: the frame shows it at once.
  const failed = state.at === "failed";
  useEffect(() => {
    if (failed) frame?.drawn({ format: false, find: false, undo: false });
  }, [failed, frame]);

  if (state.at === "failed") return <Ended why={state.why} owner={session?.mode.kind === "owner"} kept={session?.remembered() ?? kept} retry={() => load(true)} retrying={retrying} />;
  const opened = state.at === "open" ? state.opened : null;
  const TitleTag = opened?.kind === "doc" ? "h1" : "span";
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {chrome === "full" ? (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
          {opened ? (
            <>
              {child ? (
                <Button variant="ghost" size="icon-xs" aria-label={`Back to ${opened.title}`} className="-ms-1.5 text-muted-foreground" onClick={back}>
                  <ArrowLeft />
                </Button>
              ) : null}
              {opened.kind === "project" && !child ? <span ref={setLead} data-project-lead className="flex shrink-0 items-center empty:hidden" /> : null}
              <span className="shrink-0 text-muted-foreground">{createElement(GLYPH[child ? (child.table === "docs" ? "doc" : "sheet") : opened.kind], { className: "size-3.5" })}</span>
              <TitleTag className="min-w-0 truncate text-sm font-semibold">{child ? child.title || "Untitled" : opened.title}</TitleTag>
              {opened.owner ? <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{opened.owner}</span> : null}
              {opened.kind === "project" && !child ? <span ref={setSlot} data-project-bar className="flex min-w-0 flex-1 items-center justify-between gap-2" /> : null}
              {opened.name || people.length ? (
                <span className="ms-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {opened.name ? (
                    <>
                      <span className="hidden sm:inline">{CAN[opened.role]}</span>
                      <span className="hidden tabular-nums sm:inline">until {untilDay(opened.expiresAt)}</span>
                    </>
                  ) : null}
                  <Faces people={people} />
                  {opened.name ? (
                    <span role="img" aria-label={opened.name} title={opened.name} className="grid">
                      <Face name={opened.name} size="bar" />
                    </span>
                  ) : null}
                </span>
              ) : null}
            </>
          ) : (
            <Skeleton className="h-4 w-48" />
          )}
        </header>
      ) : null}
      {/* Where a document is drawn as sheets (DocPage.tsx), the page under the header is their stage, to its edges and its foot. */}
      <main className="relative flex min-h-0 flex-1 flex-col overflow-auto has-[.te-pages-stage]:bg-(--stage)">
        {opened ? (
          <Suspense fallback={<Bones />}>
            {opened.kind === "project" ? (
              <>
                <ProjectPage session={session!} opened={opened} slot={slot} lead={lead} hidden={!!child} onOpen={open} onShown={shown} onGone={gone} />
                {child ? <ChildPage key={`${child.table}:${child.id}`} session={session!} item={child} onBack={back} onGone={gone} /> : null}
              </>
            ) : opened.kind === "doc" ? (
              <DocPage session={session!} opened={opened} scheme={scheme} onGone={gone} onPeople={setPeople} bare={chrome === "none"} frame={frame} />
            ) : (
              <SheetPage session={session!} opened={opened} onGone={gone} onDown={down} onPeople={setPeople} frame={frame} />
            )}
          </Suspense>
        ) : (
          <Bones />
        )}
      </main>
    </div>
  );
}

/**
 * A document or sheet of a project's link, read only, asked for with the link's secret and
 * answered only while the project lists it: a document as its text now, read again every 15
 * seconds and when the window comes forward; a sheet on its own socket. One that is gone (it left
 * the project, or the link ended) goes back to the project, or to the end when the link itself is gone.
 */
function ChildPage({ session, item, onBack, onGone }: { session: Session; item: ChildItem; onBack(): void; onGone(): void }) {
  const own = useMemo(() => session.child(item), [session, item]);
  const [got, setGot] = useState<{ opened: Opened } | { failed: true } | null>(null);
  // Retry keeps the failure in view, its press spinning, until the read answers.
  const [retrying, setRetrying] = useState(false);
  // Gone: the link itself may have ended. The project's own answer says which, at once.
  const left = useCallback(() => void session.refresh().then(onBack, (err: unknown) => (err instanceof OpenFailed && err.why === "gone" ? onGone() : onBack())), [session, onBack, onGone]);
  const load = useCallback(
    (quiet = false) => {
      if (!quiet) setGot(null);
      own.refresh().then(
        (opened) => setGot({ opened }),
        // A read that fails after one landed keeps what is shown.
        (err: unknown) => (err instanceof OpenFailed && err.why === "gone" ? left() : quiet ? undefined : setGot({ failed: true })),
      );
    },
    [own, left],
  );
  const retry = (): void => {
    setRetrying(true);
    void own
      .refresh()
      .then(
        (opened) => setGot({ opened }),
        (err: unknown) => (err instanceof OpenFailed && err.why === "gone" ? left() : setGot({ failed: true })),
      )
      .finally(() => setRetrying(false));
  };
  useEffect(() => load(), [load]);
  // Escape goes back to the project, as from a task's page; never from a field, a dialog or a menu that takes it.
  useEffect(() => {
    const listen = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if ((event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu], [role=listbox]")) return;
      event.preventDefault();
      onBack();
    };
    // Ahead of the hidden project's own keys (a task's page under it listens for Escape too).
    window.addEventListener("keydown", listen, true);
    return () => window.removeEventListener("keydown", listen, true);
  }, [onBack]);
  const isDoc = item.table === "docs";
  useEffect(() => {
    if (!isDoc) return;
    const again = () => document.visibilityState === "visible" && load(true);
    const timer = setInterval(again, READ_EVERY);
    window.addEventListener("focus", again);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", again);
    };
  }, [isDoc, load]);
  if (!got) return <Bones />;
  if ("failed" in got)
    return (
      <div className="grid flex-1 place-items-center px-6">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{isDoc ? "Couldn't open this document" : "Couldn't open this sheet"}</EmptyTitle>
            <EmptyDescription>Try again in a minute.</EmptyDescription>
          </EmptyHeader>
          {/* The spinner stands in the glyph's place, so the press keeps its width, as the page's own Retry looks. */}
          <Button variant="secondary" size="sm" disabled={retrying} aria-busy={retrying || undefined} onClick={retry}>
            {retrying ? <Spinner aria-hidden /> : <RefreshCw />}
            Retry
          </Button>
        </Empty>
      </div>
    );
  if (got.opened.kind === "sheet") return <SheetPage session={own} opened={got.opened} onGone={left} onDown={() => setGot({ failed: true })} />;
  return <DocText id={item.id} title={got.opened.title} markdown={got.opened.markdown ?? ""} />;
}

function Bones() {
  return (
    <div className="mx-auto flex w-full max-w-[672px] flex-col gap-3 px-4 pt-6 sm:px-8" aria-busy="true">
      <Skeleton className="h-5 w-[46%]" />
      <Skeleton className="mt-3 h-4 w-[20%]" />
      <Skeleton className="h-4 w-[86%]" />
      <Skeleton className="h-4 w-[78%]" />
      <Skeleton className="h-4 w-[60%]" />
    </div>
  );
}

/**
 * Who else is in the file, before the guest's own face: 20px faces lapped 6px over a 2px ring of the page's ground,
 * each ringed in the hue of their caret, three at most and a count after (docs/DESIGN.md "The guest's page").
 */
export function Faces({ people }: { people: readonly Person[] }) {
  if (people.length === 0) return null;
  const shown = people.length > 4 ? people.slice(0, 3) : people;
  const more = people.length - shown.length;
  return (
    <span role="group" aria-label={`Also here: ${people.map((p) => p.name).join(", ")}`} data-guest-faces className="flex shrink-0 items-center">
      {shown.map((p, i) => (
        <span
          key={p.id}
          title={p.name}
          data-person={p.id}
          className={`grid rounded-full [--face-ring:var(--image-outline)] ${i > 0 ? "-ms-1.5 shadow-[0_0_0_2px_var(--background)]" : ""}`}
          style={p.color ? ({ "--face-ring": p.color } as React.CSSProperties) : undefined}
        >
          <Face name={p.name} size="bar" className="outline-[1.5px] -outline-offset-[1.5px] outline-(--face-ring)" />
        </span>
      ))}
      {more > 0 ? <span className="ms-1 tabular-nums">+{more}</span> : null}
    </span>
  );
}

const ENDED: Record<Exclude<Failure, "gone" | "starting">, { title: string; detail: string }> = {
  busy: { title: "Too many tries from here", detail: "Try again in a few minutes." },
  // Says nothing of what was written: the page cannot know whether the last edit reached the item.
  down: { title: "This page cannot be reached right now", detail: "Try again in a minute." },
};

export function Ended({ why, owner, kept = null, retry, retrying = false }: { why: Failure; owner: boolean; kept?: Remembered | null; retry(): void; retrying?: boolean }) {
  // A host that is still starting after the wait is out of reach, said as that: never as an end.
  const out = why === "down" || why === "starting";
  const words = out ? ENDED.down : why === "busy" ? ENDED.busy : owner ? { title: "This page has already been opened, or it ran out", detail: "Open it again from Docket." } : endWords(kept);
  return (
    <main className="grid h-dvh place-items-center bg-background px-6 text-foreground">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <h1>{words.title}</h1>
          </EmptyTitle>
          <EmptyDescription>{words.detail}</EmptyDescription>
        </EmptyHeader>
        {out ? (
          <Button variant="secondary" size="sm" disabled={retrying} aria-busy={retrying || undefined} onClick={retry}>
            {retrying ? <Spinner aria-hidden /> : <RefreshCw />}
            Retry
          </Button>
        ) : null}
      </Empty>
    </main>
  );
}
