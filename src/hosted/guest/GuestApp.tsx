import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { RefreshCw } from "@renderer/chrome/icons";
import { Doc, Table } from "@renderer/work/icons";
import { initials, modeOf, OpenFailed, Session, untilDay, type Failure, type Opened } from "./session";

/**
 * The hosted page (architecture §8.6; docs/DESIGN.md "The guest's page"):
 * one 44px line, the item's name, whose it is, what this person can do and
 * until when, their avatar; under it the owner's own editor or grid. No
 * sign-in: the address is the key. Nothing here reaches a thread, an agent
 * or any other item, and no control a link may not use is drawn.
 */

const DocPage = lazy(() => import("./DocPage").then((m) => ({ default: m.DocPage })));
const SheetPage = lazy(() => import("./SheetPage").then((m) => ({ default: m.SheetPage })));

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
  const down = useCallback(() => setState({ at: "failed", why: "down" }), []);

  if (state.at === "failed") return <Ended why={state.why} owner={session?.mode.kind === "owner"} retry={load} />;
  const opened = state.at === "open" ? state.opened : null;
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
        {opened ? (
          <>
            <span className="shrink-0 text-muted-foreground">{opened.kind === "doc" ? <Doc className="size-3.5" /> : <Table className="size-3.5" />}</span>
            <span className="min-w-0 truncate text-sm font-semibold">{opened.title}</span>
            {opened.owner ? <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{opened.owner}</span> : null}
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
            {opened.kind === "doc" ? <DocPage session={session!} opened={opened} scheme={scheme} onGone={gone} /> : <SheetPage session={session!} opened={opened} onGone={gone} onDown={down} />}
          </Suspense>
        ) : (
          <Bones />
        )}
      </main>
    </div>
  );
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
  down: { title: "This page cannot be reached right now", detail: "Nothing you wrote is lost. Try again in a minute." },
};

function Ended({ why, owner, retry }: { why: Failure; owner: boolean; retry(): void }) {
  const words = owner && why === "gone" ? { title: "This page has already been opened, or it ran out", detail: "Open it again from TempCode." } : ENDED[why];
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
