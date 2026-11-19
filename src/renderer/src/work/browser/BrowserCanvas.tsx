import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { BrowserState } from "@shared/contract-work-browser";
import type { OutboxItem } from "@shared/contract-work-outbox";
import type { HeldRef } from "@shared/work";
import { Lock } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { TruncateTip } from "../../components/tip";
import { FADE_IN } from "../../components/ui/reveal";
import { cn } from "../../lib/cn";
import { treeIds } from "../../lib/activity";
import { drawable, useComputerSection } from "../../lib/computerSection";
import { stopComputer, useComputerEntries, type ComputerEntry } from "../../lib/computerSessions";
import { thisDesktopInLine } from "../../lib/native";
import { hostName } from "../../lib/threadResources";
import { useSessionMetas } from "../../lib/tcserver/store";
import { ENDED_WORDS, liveFace, pictureClass, RETRY_ENDS, streamSize, useLiveStream, ViewportLine } from "../../surfaces/threads/computer/Viewport";
import { sayError } from "../canvas/frame";
import type { CanvasBodyProps } from "../canvas/kind";
import { barFaceOf, heldSubmitOf, portalValues, siteHost, type BarFace, type HeldSubmitPayload, type PortalValue } from "./portal";
import { discardHeld, heldPicture, setDriver, submitHeld, useBrowserState, useHeldActs } from "./store";

/**
 * The live browser (docs/agents/work-browser.md "The canvas"; the approved
 * prototype's "Watch, and take over"): computer use on the Mac, shown full
 * size by the Computer section's viewport rules. The bar holds the site's
 * host, who drives and one verb. A submit the computer hold kept waits on
 * its final screen: the bar ends in the one primary named for the act, and
 * the page's values sit under the picture beside where each came from.
 */

/** The thread whose pane the item is in: the browser's state is kept by it. */
const paneOf = ({ item, source }: Pick<CanvasBodyProps, "item" | "source">): string => (source.at === "browser" ? source.sessionId : item.sessionId);

export interface Browser {
  state: BrowserState | null;
  held: OutboxItem | null;
  /** the session whose window the canvas follows; null when none is live or this desktop cannot draw it */
  entry: ComputerEntry | null;
  /** every live session of the pane's tree on its host, drawable here or not: Take over stops them all */
  live: ComputerEntry[];
  /** why the first read of who drives failed, while nothing has been read */
  error?: string | null;
  retry?(): void;
}

function useBrowser(env: string, pane: string): Browser {
  const { state, error, retry } = useBrowserState(env, pane);
  const acts = useHeldActs(env, pane);
  const metas = useSessionMetas();
  const treeKey = [...treeIds(pane, metas)].sort().join("\n");
  const tree = useMemo(() => new Set(treeKey.split("\n")), [treeKey]);
  const section = useComputerSection(pane);
  const held = useMemo(() => heldSubmitOf(acts, tree, state?.site ? state.since : 0), [acts, tree, state?.site, state?.since]);
  const live = useComputerEntries(tree, env);
  const entries = useMemo(() => drawable(section.entries), [section.entries]);
  return { state, held, entry: entries[0] ?? null, live, error, retry };
}

/** A press: one at a time (a second click before the re-render too), its failure said once in the thread's toast stack. */
function usePress(): [string | null, (which: string, run: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState<string | null>(null);
  const pressing = useRef(false);
  const press = (which: string, run: () => Promise<unknown>): void => {
    if (pressing.current) return;
    pressing.current = true;
    setBusy(which);
    void run()
      .catch((err: unknown) => sayError(err, "That did not go through"))
      .finally(() => {
        pressing.current = false;
        setBusy(null);
      });
  };
  return [busy, press];
}

/** A preview's stand-ins: what the host would answer, and the page in place of the live window. */
export interface BrowserSeam {
  data?: Browser;
  picture?: ReactNode;
}

export function Bar(props: CanvasBodyProps & BrowserSeam) {
  const { env } = props;
  const pane = paneOf(props);
  const fetched = useBrowser(env, pane);
  const { state, held, live, error } = props.data ?? fetched;
  const face = barFaceOf(state, held);
  const [busy, press] = usePress();
  const takeOver = (): void =>
    press("take", async () => {
      // The agent's hands come off first: every live session of the tree stops for its turn, then he holds the wheel.
      await Promise.all(live.map((e) => stopComputer(e)));
      await setDriver(env, pane, "owner");
    });
  const handBack = (): void => press("back", () => setDriver(env, pane, "agent"));
  const host = siteHost(state);
  // A first read that failed is the state line's alone: the bar holds no bone that would never fill.
  if (error) return null;
  // Its own container, the free room in the bar: a verb the pane cannot hold gives way by the pane's width, not the window's,
  // and who drives goes whole before its verb would be cut (the verb already says it).
  return (
    <span data-slot="browser-bar" className="@container/browser flex min-w-0 flex-1 items-center gap-2">
      {face.face === "loading" ? (
        <Skeleton className="h-3 w-32" />
      ) : host ? (
        <span data-slot="browser-host" className="flex min-w-0 items-center gap-1.5 text-foreground">
          <Lock className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{host}</span>
        </span>
      ) : null}
      <FaceEnd face={face} env={env} busy={busy} press={press} takeOver={takeOver} handBack={handBack} />
    </span>
  );
}

function FaceEnd({
  face,
  env,
  busy,
  press,
  takeOver,
  handBack,
}: {
  face: BarFace;
  env: string;
  busy: string | null;
  press: (which: string, run: () => Promise<unknown>) => void;
  takeOver(): void;
  handBack(): void;
}) {
  switch (face.face) {
    case "loading":
      return null;
    case "agent":
      return (
        <span className="ms-auto flex shrink-0 items-center gap-2">
          <span data-narrow-hide className="whitespace-nowrap @max-[320px]/browser:hidden">The agent is driving</span>
          <Button variant="secondary" size="xs" disabled={!!busy} onClick={takeOver}>
            <BusyLabel busy={busy === "take"} label="Take over" />
          </Button>
        </span>
      );
    case "needs":
      return (
        <span className="ms-auto flex min-w-0 items-center gap-2">
          <StatusMark state="waiting" word={face.words} className="min-w-0 truncate" />
          <Button size="xs" className="shrink-0" disabled={!!busy} onClick={takeOver}>
            <BusyLabel busy={busy === "take"} label="Take over" />
          </Button>
        </span>
      );
    case "owner":
      return (
        <span className="ms-auto flex shrink-0 items-center gap-2">
          <span data-narrow-hide className="whitespace-nowrap text-foreground @max-[320px]/browser:hidden">You are driving</span>
          <Button variant="secondary" size="xs" disabled={!!busy} onClick={handBack}>
            <BusyLabel busy={busy === "back"} label="Hand back" />
          </Button>
        </span>
      );
    case "done":
      return <span className="ms-auto min-w-0 truncate">{face.words}</span>;
    case "held": {
      const ref = face.item.ref;
      return (
        <span className="ms-auto flex shrink-0 items-center gap-1">
          {face.owner ? (
            <Button variant="ghost" size="xs" disabled={!!busy} onClick={handBack}>
              <BusyLabel busy={busy === "back"} label="Hand back" />
            </Button>
          ) : (
            <Button variant="ghost" size="xs" data-slot="browser-take-over" className="@max-[540px]/browser:hidden" disabled={!!busy} onClick={takeOver}>
              <BusyLabel busy={busy === "take"} label="Take over" />
            </Button>
          )}
          <Button variant="ghost" size="xs" disabled={!!busy} onClick={() => press("discard", () => discardHeld(env, ref))}>
            <BusyLabel busy={busy === "discard"} label="Discard" />
          </Button>
          <Button size="xs" disabled={!!busy} onClick={() => press("submit", () => submitHeld(env, ref))}>
            <BusyLabel busy={busy === "submit"} label={face.act} />
          </Button>
        </span>
      );
    }
  }
}

export function Body(props: CanvasBodyProps & BrowserSeam) {
  const { env, shell } = props;
  const pane = paneOf(props);
  const fetched = useBrowser(env, pane);
  const { state, held, entry, live, error, retry } = props.data ?? fetched;
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stream = useLiveStream(entry, true, box, measure);

  // Where it runs, said once after the page's title: the Mac a box thread drives, else the thread's own host (none for this one).
  const where = entry?.row.macName ?? live.find((e) => e.row.macName)?.row.macName ?? hostName(env);
  useEffect(() => {
    shell.detail(where === thisDesktopInLine() ? null : where);
    return () => shell.detail(null);
  }, [shell, where]);

  // A first read that failed says so on the one state line, with Retry; the body under it draws nothing that pretends to load.
  useEffect(() => {
    shell.statusLine(error ? { tone: "failed", word: "Couldn't open this browser", detail: error, action: retry ? { label: "Retry", run: retry } : undefined } : null);
    return () => shell.statusLine(null);
  }, [shell, error, retry]);

  const waiting = held && (held.state === "held" || held.state === "live") ? held : null;
  const values = useMemo<PortalValue[]>(() => (waiting ? portalValues((waiting.payload as HeldSubmitPayload).mark ?? "", state?.sources ?? []) : []), [waiting, state?.sources]);

  return (
    <div ref={measure} data-slot="browser-view" className="flex h-full min-h-0 flex-col gap-3 overflow-x-hidden overflow-y-auto p-3">
      {/* The page fills the body inside its inset (browser.html), at any width of canvas. */}
      <div className="flex w-full flex-col gap-3">
        {error && !props.picture ? null : props.picture ??
          (entry ? (
            <LiveView stream={stream} box={box} label={liveLabel(entry)} />
          ) : state ? (
            <StillView env={env} held={waiting} />
          ) : (
            <Skeleton className="aspect-[16/10] w-full rounded-lg" />
          ))}
        {values.length ? <Values values={values} /> : null}
      </div>
    </div>
  );
}

const liveLabel = (entry: ComputerEntry): string => {
  const app = entry.row.apps[0];
  return app ? `Live view of ${app.window ? `${app.window} in ${app.name}` : app.name}` : "Live view";
};

/** The window live, in its own shape at the column's width, a skeleton in that shape until its first frame. */
function LiveView({ stream, box, label }: { stream: ReturnType<typeof useLiveStream>; box: RefObject<HTMLDivElement | null>; label: string }) {
  const face = liveFace(stream);
  const size = streamSize(stream.state) ?? { width: 16, height: 10 };
  const ended = stream.state.status === "ended" ? stream.state : null;
  return (
    <div className={FADE_IN}>
      <div ref={box} role="img" aria-label={label} data-face="live" className="relative w-full overflow-hidden rounded-lg bg-card" style={{ aspectRatio: `${size.width} / ${size.height}` }}>
        {!face.drawn ? <Skeleton className="absolute inset-0 rounded-lg" /> : null}
        {face.picture}
        <div className="pointer-events-none absolute inset-0">{face.mark}</div>
      </div>
      {ended ? (
        <div className="pt-1">
          <ViewportLine words={ENDED_WORDS[ended.reason]} onRetry={RETRY_ENDS.has(ended.reason) ? stream.retry : undefined} />
        </div>
      ) : null}
    </div>
  );
}

/** Where the window cannot be drawn live (the box, the browser /ui): the held page's picture, or one line. */
function StillView({ env, held }: { env: string; held: OutboxItem | null }) {
  // Read by the ref's key: a push that rewrites the same item fetches nothing again.
  const key = held ? JSON.stringify(held.ref) : null;
  // undefined while it comes; null when the host kept none; "failed" when the host did not answer, which is not the same thing.
  const [src, setSrc] = useState<string | null | undefined | "failed">(undefined);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return setSrc(null);
    let live = true;
    setSrc(undefined);
    heldPicture(env, JSON.parse(key) as HeldRef).then(
      (s) => live && setSrc(s),
      () => live && setSrc("failed"),
    );
    return () => {
      live = false;
    };
  }, [env, key, attempt]);
  if (!key) return <ViewportLine words="The agent is not driving the browser now" />;
  const picture = held?.payload as HeldSubmitPayload | null;
  const shape = picture?.picture ? `${picture.picture.width} / ${picture.picture.height}` : "16 / 10";
  if (src === undefined) return <Skeleton className="w-full rounded-lg" style={{ aspectRatio: shape }} />;
  if (src === "failed") return <ViewportLine words="The page's picture did not load" onRetry={() => setAttempt((n) => n + 1)} />;
  if (!src) return <ViewportLine words="No picture of this page was kept" />;
  return <img src={src} alt={held?.summary ?? ""} draggable={false} className={cn(pictureClass(true), "h-auto")} style={{ aspectRatio: shape }} />;
}

/** The page's values at its final screen, each beside where it came from. */
function Values({ values }: { values: PortalValue[] }) {
  return (
    // Under 480px of its own width the source goes under its label and value, whole, rather than a sliver beside them.
    <div data-slot="browser-values" role="table" aria-label="What the page holds" className="@container/values flex flex-col">
      {values.map((v, i) => (
        <div
          key={`${v.label}-${i}`}
          role="row"
          className="grid min-h-7 grid-cols-[112px_minmax(0,1fr)] items-center gap-x-3 @[480px]/values:grid-cols-[112px_minmax(80px,max-content)_minmax(0,1fr)] border-t border-border py-1 text-[13px] leading-5 first:border-t-0"
        >
          <span role="cell" className="truncate font-medium">
            {v.label}
          </span>
          <span role="cell" className="min-w-0 break-words tabular-nums">
            {v.value}
          </span>
          <TruncateTip text={v.source ?? ""}>
            <span role="cell" data-value-source className="col-span-2 truncate text-xs text-muted-foreground @[480px]/values:col-span-1">
              {v.source ?? ""}
            </span>
          </TruncateTip>
        </div>
      ))}
    </div>
  );
}
