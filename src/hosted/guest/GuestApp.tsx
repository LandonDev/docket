import { createElement, lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { ArrowLeft, RefreshCw } from "@renderer/chrome/icons";
import { Doc, Project, Table } from "@renderer/work/icons";
import { projectionLists, type GuestProjection } from "@shared/work/guestProjection";
import { initials, modeOf, OpenFailed, Session, untilDay, type ChildItem, type Failure, type Opened } from "./session";
// The type alone: the sheet stays in its own lazy chunk.
import type { Refusal } from "./SheetPage";

/**
 * The hosted page (architecture §8.6; docs/DESIGN.md "The guest's page"):
 * one 44px line, the item's name, whose it is, what this person can do and
 * until when, their avatar; under it the owner's own editor or grid. No
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

export function GuestApp() {
  const scheme = useScheme();
  const session = useMemo(() => {
    const mode = modeOf(location.pathname, location.hash);
    return mode.kind === "none" ? null : new Session(mode, location.origin, renewStore);
  }, []);
  const [state, setState] = useState<{ at: "loading" } | { at: "open"; opened: Opened } | { at: "failed"; why: Failure }>(session ? { at: "loading" } : { at: "failed", why: "gone" });

  const load = useCallback(() => {
    if (!session) return;
    setState({ at: "loading" });
    session.refresh().then(
      (opened) => {
        // The owner's ticket opens once: it leaves the address as soon as it has.
        if (session.mode.kind === "owner") history.replaceState(null, "", location.pathname);
        document.title = opened.title;
        setState({ at: "open", opened });
      },
      (err: unknown) => setState({ at: "failed", why: err instanceof OpenFailed ? err.why : "down" }),
    );
  }, [session]);
  useEffect(load, [load]);
  const gone = useCallback(() => setState({ at: "failed", why: "gone" }), []);
  // A sheet that ran out of tries hands over the refusal that stood: the screen keeps its warning, and so does the grid after Retry.
  const [left, setLeft] = useState<Refusal | null>(null);
  const down = useCallback((standing: Refusal | null = null) => {
    setLeft(standing);
    setState({ at: "failed", why: "down" });
  }, []);
  // A project's link: the document or sheet open over the project, and where the screens' controls go in the line.
  const [child, setChild] = useState<(ChildItem & { title: string }) | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const back = useCallback(() => setChild(null), []);
  // A document or sheet the project no longer lists is closed at the page's next read: its socket is already shut.
  const shown = useCallback((p: GuestProjection) => setChild((open) => (open && !projectionLists(p, open.table, open.id) ? null : open)), []);

  if (state.at === "failed") return <Ended why={state.why} left={left} owner={session?.mode.kind === "owner"} retry={load} />;
  const opened = state.at === "open" ? state.opened : null;
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
        {opened ? (
          <>
            {child ? (
              <Button variant="ghost" size="icon-xs" aria-label={`Back to ${opened.title}`} className="-ms-1.5 text-muted-foreground" onClick={back}>
                <ArrowLeft />
              </Button>
            ) : null}
            <span className="shrink-0 text-muted-foreground">{createElement(GLYPH[child ? (child.table === "docs" ? "doc" : "sheet") : opened.kind], { className: "size-3.5" })}</span>
            <span className="min-w-0 truncate text-sm font-semibold">{child ? child.title || "Untitled" : opened.title}</span>
            {opened.owner ? <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{opened.owner}</span> : null}
            {opened.kind === "project" && !child ? <span ref={setSlot} data-project-bar className="flex min-w-0 flex-1 items-center justify-between gap-2" /> : null}
            {opened.name ? (
              <span className="ms-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <span className="hidden sm:inline">{CAN[opened.role]}</span>
                <span className="hidden tabular-nums sm:inline">until {untilDay(opened.expiresAt)}</span>
                <span
                  aria-label={opened.name}
                  role="img"
                  className="grid size-6 place-items-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground outline-1 -outline-offset-1 outline-(--image-outline)"
                >
                  {initials(opened.name)}
                </span>
              </span>
            ) : null}
          </>
        ) : (
          <Skeleton className="h-4 w-48" />
        )}
      </header>
      <main className="relative flex min-h-0 flex-1 flex-col overflow-auto">
        {opened ? (
          <Suspense fallback={<Bones />}>
            {opened.kind === "project" ? (
              <>
                <ProjectPage session={session!} opened={opened} slot={slot} hidden={!!child} onOpen={setChild} onShown={shown} onGone={gone} />
                {child ? <ChildPage key={`${child.table}:${child.id}`} session={session!} item={child} onBack={back} onGone={gone} /> : null}
              </>
            ) : opened.kind === "doc" ? (
              <DocPage session={session!} opened={opened} scheme={scheme} onGone={gone} />
            ) : (
              <SheetPage session={session!} opened={opened} onGone={gone} onDown={down} carried={left} />
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
  useEffect(() => load(), [load]);
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
            <EmptyTitle>It did not open</EmptyTitle>
          </EmptyHeader>
          <Button variant="secondary" size="sm" onClick={() => load()}>
            <RefreshCw />
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

const ENDED: Record<Failure, { title: string; detail: string }> = {
  gone: { title: "This link no longer opens anything", detail: "Ask the person who sent it if you still need it." },
  busy: { title: "Too many tries from here", detail: "Try again in a few minutes." },
  // Says nothing of what was written: the page cannot know whether the last edit reached the item.
  down: { title: "This page cannot be reached right now", detail: "Try again in a minute." },
};

/** The unreachable screen with an edit the item refused: the warning the grid showed stays. */
const DOWN_UNSAVED = { title: "This page cannot be reached right now", detail: "Your last edit was not saved. Try again in a minute, then make it again." };
/** With an edit whose answer never came: it may or may not have landed. */
const DOWN_UNCONFIRMED = { title: "This page cannot be reached right now", detail: "Your last edit could not be confirmed. Try again in a minute, then check the cell." };

export function Ended({ why, left = null, owner, retry }: { why: Failure; left?: Refusal | null; owner: boolean; retry(): void }) {
  const downWords = left ? (left.unconfirmed ? DOWN_UNCONFIRMED : DOWN_UNSAVED) : ENDED.down;
  const words = owner && why === "gone" ? { title: "This page has already been opened, or it ran out", detail: "Open it again from TempCode." } : why === "down" ? downWords : ENDED[why];
  return (
    <main className="grid h-dvh place-items-center bg-background px-6 text-foreground">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <h1>{words.title}</h1>
          </EmptyTitle>
          <EmptyDescription>{words.detail}</EmptyDescription>
        </EmptyHeader>
        {why === "down" ? (
          <Button variant="secondary" size="sm" onClick={retry}>
            <RefreshCw />
            Retry
          </Button>
        ) : null}
      </Empty>
    </main>
  );
}
