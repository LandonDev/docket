import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { BrowserState } from "@shared/contract-work-browser";
import type { OutboxItem } from "@shared/contract-work-outbox";
import type { HeldRef } from "@shared/work";
import { Lock } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { FADE_IN } from "../../components/ui/reveal";
import { cn } from "../../lib/cn";
import { treeIds } from "../../lib/activity";
import { drawable, useComputerSection } from "../../lib/computerSection";
import { stopComputer, type ComputerEntry } from "../../lib/computerSessions";
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
  live: ComputerEntry[];
}

function useBrowser(env: string, pane: string): Browser {
  const state = useBrowserState(env, pane);
  const acts = useHeldActs(env);
  const metas = useSessionMetas();
  const treeKey = [...treeIds(pane, metas)].sort().join("\n");
  const tree = useMemo(() => new Set(treeKey.split("\n")), [treeKey]);
  const section = useComputerSection(pane);
  const held = useMemo(() => heldSubmitOf(acts, tree, state?.site ? state.since : 0), [acts, tree, state?.site, state?.since]);
  const entries = useMemo(() => drawable(section.entries), [section.entries]);
  return { state, held, entry: entries[0] ?? null, live: section.entries };
}

/** A press: one at a time, its failure said once in the thread's toast stack. */
function usePress(): [string | null, (which: string, run: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState<string | null>(null);
  const press = (which: string, run: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(which);
    void run()
      .catch((err: unknown) => sayError(err, "That did not go through"))
      .finally(() => setBusy(null));
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
  const { state, held, live } = props.data ?? fetched;
  const face = barFaceOf(state, held);
  const [busy, press] = usePress();
  const takeOver = (): void =>
    press("take", async () => {
      await setDriver(env, pane, "owner");
      // The agent's computer use stops for its turn; it is told when he hands back.
      await Promise.allSettled(live.map((e) => stopComputer(e)));
    });
  const handBack = (): void => press("back", () => setDriver(env, pane, "agent"));
  const host = siteHost(state);
  return (
    <>
      {face.face === "loading" ? (
        <Skeleton className="h-3 w-32" />
      ) : host ? (
        <span data-slot="browser-host" className="flex min-w-0 items-center gap-1.5 text-foreground">
          <Lock className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{host}</span>
        </span>
      ) : null}
      <FaceEnd face={face} env={env} busy={busy} press={press} takeOver={takeOver} handBack={handBack} />
    </>
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
        <>
          <span className="ms-auto shrink-0 whitespace-nowrap">The agent is driving</span>
          <Button variant="secondary" size="xs" disabled={!!busy} onClick={takeOver}>
            <BusyLabel busy={busy === "take"} label="Take over" />
          </Button>
        </>
      );
    case "needs":
      return (
        <>
          <StatusMark state="waiting" word={face.words} className="ms-auto min-w-0 truncate" />
          <Button size="xs" disabled={!!busy} onClick={takeOver}>
            <BusyLabel busy={busy === "take"} label="Take over" />
          </Button>
        </>
      );
    case "owner":
      return (
        <>
          <span className="ms-auto shrink-0 whitespace-nowrap text-foreground">You are driving</span>
          <Button variant="secondary" size="xs" disabled={!!busy} onClick={handBack}>
            <BusyLabel busy={busy === "back"} label="Hand back" />
          </Button>
        </>
      );
    case "done":
      return <span className="ms-auto shrink-0 whitespace-nowrap">{face.words}</span>;
    case "held": {
      const ref = face.item.ref;
      return (
        <span className="ms-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="xs" className="max-[560px]:hidden" disabled={!!busy} onClick={takeOver}>
            <BusyLabel busy={busy === "take"} label="Take over" />
          </Button>
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
  const { state, held, entry } = props.data ?? fetched;
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stream = useLiveStream(entry, true, box, measure);

  // Where it runs, said once after the page's title: the Mac a box thread drives, else the thread's own host.
  const where = entry?.row.macName ?? hostName(env);
  useEffect(() => {
    shell.detail(where === "this Mac" ? null : where);
    return () => shell.detail(null);
  }, [shell, where]);

  const waiting = held && (held.state === "held" || held.state === "live") ? held : null;
  const values = useMemo<PortalValue[]>(() => (waiting ? portalValues((waiting.payload as HeldSubmitPayload).mark ?? "", state?.sources ?? []) : []), [waiting, state?.sources]);

  return (
    <div ref={measure} data-slot="browser-view" className="flex h-full min-h-0 flex-col gap-3 overflow-x-hidden overflow-y-auto p-3">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3">
        {props.picture ??
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
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!key) return setSrc(null);
    let live = true;
    setSrc(undefined);
    heldPicture(env, JSON.parse(key) as HeldRef).then(
      (s) => live && setSrc(s),
      () => live && setSrc(null),
    );
    return () => {
      live = false;
    };
  }, [env, key]);
  if (!key) return <ViewportLine words="The agent is not driving the browser now" />;
  const picture = held?.payload as HeldSubmitPayload | null;
  const shape = picture?.picture ? `${picture.picture.width} / ${picture.picture.height}` : "16 / 10";
  if (src === undefined) return <Skeleton className="w-full rounded-lg" style={{ aspectRatio: shape }} />;
  if (!src) return <ViewportLine words="No picture of this page was kept" />;
  return <img src={src} alt={held?.summary ?? ""} draggable={false} className={cn(pictureClass(true), "h-auto")} style={{ aspectRatio: shape }} />;
}

/** The page's values at its final screen, each beside where it came from. */
function Values({ values }: { values: PortalValue[] }) {
  return (
    <div data-slot="browser-values" role="table" aria-label="What the page holds" className="flex flex-col">
      {values.map((v, i) => (
        <div
          key={`${v.label}-${i}`}
          role="row"
          className="grid h-7 grid-cols-[112px_80px_minmax(0,1fr)] items-center gap-x-3 border-t border-border text-[13px] leading-5 first:border-t-0"
        >
          <span role="cell" className="truncate font-medium">
            {v.label}
          </span>
          <span role="cell" className="truncate tabular-nums">
            {v.value}
          </span>
          <span role="cell" className="truncate text-xs text-muted-foreground">
            {v.source ?? ""}
          </span>
        </div>
      ))}
    </div>
  );
}
