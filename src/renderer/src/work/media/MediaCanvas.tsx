import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clock, frameStart, frameTimecode } from "@shared/mediaFrames";
import type { FrameTable, MediaAnchor, MediaNote, MediaRegion, MediaVersion, MediaView } from "@shared/contract-work-media";
import type { ContextChip } from "@shared/work";
import { RowsMenu } from "../../chrome/menuRows";
import { ChevronDown, X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Progress } from "../../components/ui/progress";
import { Skeleton } from "../../components/ui/skeleton";
import { Tip } from "../../components/tip";
import { dayTime } from "../../lib/duration";
import type { CanvasBodyProps, CanvasShell } from "../canvas/kind";
import { Comment, History, ZoomIn, ZoomOut } from "../icons";
import { Notes, NotesSkeleton } from "./Notes";
import { CommentPopover } from "./parts";
import { Picture, type Zoom } from "./Picture";
import { Player, PlayerSkeleton, type PlayerHandle, type Stretch } from "./Player";
import { shownPlay } from "./plays";
import { loadMedia, mediaActions, useMedia, type MediaActions } from "./store";

/**
 * The media kind's body and bar (docs/agents/work-media.md, "The canvas"):
 * an image or a video beside the thread, the player over its comments by
 * time (the approved prototype's pick). A note returns to its frame; a
 * stretch of the track or a region of the picture is a selection for Ask;
 * an agent's notes waiting for the person feed the pane's one stepper; a
 * version from History plays beside the current one on one transport.
 */

export interface MediaState {
  /** The version shown; the newest when unset. */
  versionId?: string;
  /** A second version shown beside the first, in step. */
  compare?: string;
  zoom?: Zoom;
}

const ZOOMS = [0.25, 0.5, 1, 2, 4];
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?|psd|svg)$/i;

const tableOf = (v: MediaVersion | undefined): FrameTable | null => {
  const play = v ? shownPlay(v) : null;
  return play && "table" in play ? play.table : null;
};
const timeOf = (t: FrameTable, n: number): string => clock(frameStart(t, n) - frameStart(t, 0));
const short = (at: number): string => new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
const regionWords = (r: MediaRegion): string => `x ${r.x.toFixed(2)}, y ${r.y.toFixed(2)}, w ${r.w.toFixed(2)}, h ${r.h.toFixed(2)}`;

/** The version a state shows, and the one it compares with. */
function shownOf(view: MediaView | null, state: MediaState | undefined): { shown?: MediaVersion; other?: MediaVersion } {
  const versions = view?.versions ?? [];
  const shown = versions.find((v) => v.id === state?.versionId) ?? versions[versions.length - 1];
  const other = state?.compare && state.compare !== shown?.id ? versions.find((v) => v.id === state.compare) : undefined;
  return { shown, other };
}

/** A moment or a stretch, as the thread reads it on a chip: what Ask hands over. */
export function selectionChip(o: { title: string; source: ContextChip["ref"]; version: MediaVersion; table: FrameTable | null; stretch?: Stretch; frame?: number; region?: MediaRegion }): ContextChip {
  const { title, version: v, table } = o;
  const tc = (n: number): string => (v.probe?.rate ? frameTimecode(n, v.probe.rate, v.probe.timecode) : String(n));
  if (o.stretch && table) {
    const { from, to } = o.stretch;
    return { kind: "selection", label: `${timeOf(table, from)} to ${timeOf(table, to)}, ${title}`, ref: o.source, quote: `v${v.n}, frames ${from} to ${to} (${tc(from)} to ${tc(to)})` };
  }
  const where = table && o.frame !== undefined ? `, frame ${o.frame} (${tc(o.frame)})` : "";
  const label = table && o.frame !== undefined ? `Region at ${timeOf(table, o.frame)}, ${title}` : `Region of ${title}`;
  return { kind: "selection", label, ref: o.source, quote: `v${v.n}${where}, the region ${o.region ? regionWords(o.region) : ""} of the picture` };
}

/** The agent's notes waiting for the person, as the pane's stepper steps them. */
function useReview(shell: CanvasShell, waiting: MediaNote[], current: string | null, pick: (n: MediaNote) => void, actions: MediaActions) {
  useEffect(() => {
    if (waiting.length === 0) return shell.review(null);
    const index = waiting.findIndex((n) => n.id === current);
    shell.review({
      groups: [{ id: "agent", label: "Agent's notes", by: waiting[0].by, count: waiting.length }],
      index,
      count: waiting.length,
      step: (to) => pick(waiting[(to + waiting.length) % waiting.length]),
      accept: (which) => actions.decide(typeof which === "number" ? waiting[which].id : "all", true),
      reject: (which) => actions.decide(typeof which === "number" ? waiting[which].id : "all", false),
    });
  }, [shell, waiting, current, pick, actions]);
  useEffect(() => () => shell.review(null), [shell]);
}

export function Body({ item, source, env, state, shell }: CanvasBodyProps<MediaState>) {
  const { view, error } = useMedia(env, item.id);
  const actions = useMemo(() => mediaActions(env, item.id), [env, item.id]);
  const { shown, other } = shownOf(view, state);
  const table = tableOf(shown);
  const player = useRef<PlayerHandle>(null);
  const [picked, setCurrent] = useState<string | null>(null);
  const [frame, setFrame] = useState<number | null>(null);
  const [stretch, setStretch] = useState<Stretch | null>(null);
  const [region, setRegion] = useState<{ region: MediaRegion; frame?: number } | null>(null);
  const [comment, setComment] = useState<{ anchor: MediaAnchor; rect: DOMRect | null; about: string } | null>(null);

  const notes = useMemo(
    () => (view?.notes ?? []).filter((n) => n.anchor.versionId === shown?.id && !n.parentId).sort((a, b) => (a.anchor.frame ?? 0) - (b.anchor.frame ?? 0) || a.createdAt - b.createdAt),
    [view?.notes, shown?.id],
  );
  const waiting = useMemo(() => notes.filter((n) => n.state === "suggested"), [notes]);
  const chapters = useMemo(() => notes.filter((n) => n.kind === "chapter" && n.state === "kept"), [notes]);
  // The stepper starts on the first note waiting, as the pane's stepper always shows where it is.
  const current = picked && notes.some((n) => n.id === picked) ? picked : (waiting[0]?.id ?? null);
  const currentNote = notes.find((n) => n.id === current) ?? null;

  /** A note returns to its frame, and shows its region. */
  const pick = useCallback(
    (n: MediaNote) => {
      setCurrent(n.id);
      setStretch(null);
      setRegion(null);
      shell.selection(null);
      if (n.anchor.frame !== undefined) void player.current?.seek(n.anchor.frame);
    },
    [shell],
  );
  useReview(shell, waiting, current, pick, actions);

  // What the agent does to this item, and what it last wrote straight onto it.
  useEffect(() => {
    if (!view || other) return shell.mode(null);
    shell.mode(view.shared ? { value: "suggests", note: "Others review this, so the agent's notes wait for you" } : { value: view.mode, set: (m) => void actions.mode(m) });
  }, [shell, view?.mode, view?.shared, other, actions, view]);
  useEffect(() => {
    const w = view?.lastWrite;
    shell.written(w ? { text: `${w.text}, ${dayTime(w.at)}`, undo: () => actions.undo(w.id) } : null);
  }, [shell, view?.lastWrite, actions]);
  useEffect(() => {
    const failed = [shown, other].find((v) => unshowable(v) !== undefined);
    shell.statusLine(
      failed
        ? { tone: "failed", word: `${failed.name} could not be shown`, detail: unshowable(failed), action: { label: "Retry", run: () => loadMedia(env, item.id, { retry: true }) } }
        : error
          ? { tone: "failed", word: "Couldn't open this file", detail: error, action: { label: "Retry", run: () => loadMedia(env, item.id) } }
          : null,
    );
  }, [shell, shown, other, view?.versions, error, env, item.id]);
  useEffect(
    () => () => {
      shell.mode(null);
      shell.written(null);
      shell.statusLine(null);
      shell.selection(null);
    },
    [shell],
  );

  const openComment = (anchor: MediaAnchor, rect: DOMRect | null, about: string): void => {
    shell.selection(null);
    setComment({ anchor, rect, about });
  };
  const commentButton = (anchor: MediaAnchor, rect: DOMRect, about: string) => (
    <Button variant="ghost" size="xs" className="rounded-lg text-[13px]" onMouseDown={(e) => e.preventDefault()} onClick={() => openComment(anchor, rect, about)}>
      <Comment className="size-3.5" />
      Comment
    </Button>
  );

  // A host that did not answer is the pane's state line, over the empty stage: no bones under a failure.
  if (!view && error) return <Stage />;
  if (!view || !shown) return <Loading kind={IMAGE_EXT.test(item.source.at === "file" ? item.source.path : item.title) ? "image" : "video"} />;

  const play = shownPlay(shown);
  const isImage = shown.probe?.kind === "image" || play?.via === "image" || play?.via === "tiles";
  if (!play) return <Loading kind={isImage ? "image" : "video"} version={shown} />;

  const selectRegion = (r: MediaRegion, rect: DOMRect, at?: number): void => {
    setRegion({ region: r, frame: at });
    setStretch(null);
    setCurrent(null);
    const chip = selectionChip({ title: item.title, source, version: shown, table, frame: at, region: r });
    shell.selection({ chip, rect, tools: commentButton({ versionId: shown.id, ...(at !== undefined ? { frame: at } : {}), region: r }, rect, chip.label) });
  };

  if (play.via === "image" || play.via === "tiles") {
    return (
      <div data-media-body className="flex size-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <Picture
            versionId={shown.id}
            play={play}
            zoom={state?.zoom ?? "fit"}
            actions={actions}
            region={region?.region ?? currentNote?.anchor.region ?? null}
            shapes={currentNote?.anchor.shapes}
            selecting={!!region}
            onRegion={(r, rect) => selectRegion(r, rect)}
            onScale={() => {}}
          />
        </div>
        {notes.length ? (
          <div className="max-h-[40%] shrink-0 overflow-x-hidden overflow-y-auto">
            <Notes notes={notes} table={null} current={current} playing={null} onPick={pick} />
          </div>
        ) : null}
        <CommentPopover rect={comment?.rect ?? null} about={comment?.about ?? ""} onSave={(body) => actions.note(comment!.anchor, body)} onClose={() => setComment(null)} />
      </div>
    );
  }

  const versions = other ? [...[other, shown].sort((a, b) => a.n - b.n)] : [shown];
  return (
    <div data-media-body className="size-full min-h-0 overflow-x-hidden overflow-y-auto">
      <Player
        ref={player}
        versions={versions}
        labels={other ? versions.map((v) => `v${v.n}`) : undefined}
        actions={actions}
        notes={other ? [] : notes}
        chapters={other ? [] : chapters}
        current={current}
        region={region?.region ?? (currentNote && currentNote.anchor.frame === frame ? (currentNote.anchor.region ?? null) : null)}
        selecting={!!region}
        stretch={stretch}
        onFrame={setFrame}
        onStretch={(s, rect) => {
          setStretch(s);
          setRegion(null);
          if (!s || !rect || !table) return shell.selection(null);
          const chip = selectionChip({ title: item.title, source, version: shown, table, stretch: s });
          shell.selection({ chip, rect, tools: commentButton({ versionId: shown.id, frame: s.from, durationFrames: s.to - s.from + 1 }, rect, chip.label) });
        }}
        onRegion={(r, rect, at) => selectRegion(r, rect, at)}
        onComment={(at, rect) => openComment({ versionId: shown.id, frame: at }, rect, table ? `At ${timeOf(table, at)}` : "")}
      />
      {other ? null : <Notes notes={notes} table={table} current={current} playing={frame} onPick={pick} />}
      <CommentPopover rect={comment?.rect ?? null} about={comment?.about ?? ""} onSave={(body) => actions.note(comment!.anchor, body)} onClose={() => setComment(null)} />
    </div>
  );
}

/** Why a version cannot be shown here: it failed, or the copy this viewer needs could not be made. */
function unshowable(v: MediaVersion | undefined): string | undefined {
  return !v ? undefined : v.state === "failed" ? v.error : !shownPlay(v) && v.proxyError ? v.proxyError : undefined;
}

/** The empty stage a failure leaves: the pane's state line says why, with Retry. */
function Stage() {
  return <div data-media-failed className="size-full bg-(--stage)" />;
}

/** While the host reads the file or makes what this viewer needs: the player's bones, and what is under way. */
function Loading({ kind, version }: { kind: "image" | "video"; version?: MediaVersion }) {
  // A failure is the pane's state line alone, over the empty stage: never bones that wait for nothing.
  if (version && unshowable(version) !== undefined) return <Stage />;
  const word = version?.state !== "preparing" || version.proxyError ? undefined : version.probe?.kind === "image" ? `Converting ${version.name}` : "Making a copy this viewer can play";
  if (kind === "image")
    return (
      <div data-media-loading className="grid size-full place-items-center bg-(--stage)">
        {word ? <Preparing word={word} progress={version?.progress} /> : version && version.state !== "probing" ? null : <Skeleton className="aspect-[4/5] w-[40%] rounded-[4px]" />}
      </div>
    );
  return (
    <div data-media-loading>
      <PlayerSkeleton line={undefined} />
      {word ? (
        <div className="px-3 pt-1">
          <Preparing word={word} progress={version?.progress} />
        </div>
      ) : version && version.state !== "probing" ? null : (
        <NotesSkeleton />
      )}
    </div>
  );
}

function Preparing({ word, progress }: { word: string; progress?: number }) {
  return (
    <div className="flex w-[240px] flex-col gap-2">
      <div className="flex text-xs text-muted-foreground">
        <span className="truncate">{word}</span>
        {progress !== undefined ? <span className="ms-auto tabular-nums">{Math.round(progress * 100)}%</span> : null}
      </div>
      <Progress value={progress === undefined ? null : progress * 100} aria-label={word} />
    </div>
  );
}

/** The kind's own tools in the pane's bar: a picture's facts and zoom, a video's versions, a compare's two pickers. */
export function Bar({ item, env, state, setState }: CanvasBodyProps<MediaState>) {
  const { view, error } = useMedia(env, item.id);
  const { shown, other } = shownOf(view, state);
  // While the host reads the file the bar holds one bone where the mode will be, so the body does not drop 32px when it lands.
  if (!view) return error ? null : <Skeleton className="h-3 w-30" />;
  if (!shown) return null;
  const versions = view.versions;
  const set = (patch: Partial<MediaState>): void => setState({ ...state, ...patch });
  const versionRows = (checked: string) => [...versions].reverse().map((v) => ({ kind: "item" as const, id: v.id, label: `v${v.n}`, hint: short(v.addedAt), checked: v.id === checked }));

  if (other) {
    const [a, b] = [other, shown].sort((x, y) => x.n - y.n);
    const picker = (v: MediaVersion, pick: (id: string) => void) => (
      <RowsMenu
        label="Version"
        align="start"
        rows={versionRows(v.id)}
        onPick={pick}
        trigger={
          <Button variant="ghost" size="xs" className="font-normal text-muted-foreground">
            v{v.n}
            {/* Whole or gone: in the narrow bar a picker keeps its version and drops its day. */}
            <span data-narrow-hide className="-ms-1 @max-[560px]/bar:hidden">, {short(v.addedAt)}</span>
            <ChevronDown />
          </Button>
        }
      />
    );
    return (
      <>
        {picker(a, (id) => set(a.id === shown.id ? { versionId: id } : { compare: id }))}
        <span>and</span>
        {picker(b, (id) => set(b.id === shown.id ? { versionId: id } : { compare: id }))}
        <Tip label="Close the compare">
          <Button variant="ghost" size="icon-xs" aria-label="Close the compare" className="text-muted-foreground" onClick={() => set({ compare: undefined })}>
            <X />
          </Button>
        </Tip>
      </>
    );
  }

  const play = shownPlay(shown);
  if (play?.via === "image" || play?.via === "tiles") {
    const zoom = state?.zoom ?? "fit";
    const step = (dir: 1 | -1): void => {
      const now = zoom === "fit" ? 1 : zoom;
      const next = dir > 0 ? ZOOMS.find((z) => z > now + 1e-6) : [...ZOOMS].reverse().find((z) => z < now - 1e-6);
      if (next) set({ zoom: next });
    };
    const p = shown.probe;
    return (
      <>
        {/* The picture's facts go whole in the narrow bar, so the zoom keeps its room. */}
        <span data-narrow-hide className="flex min-w-0 gap-2 truncate tabular-nums @max-[560px]/bar:hidden">
          {play.width ? <span>{`${play.width} × ${play.height}`}</span> : null}
          {p ? <span>{p.size >= 1e6 ? `${(p.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(p.size / 1e3))} KB`}</span> : null}
        </span>
        <Tip label="Zoom out">
          <Button variant="ghost" size="icon-xs" aria-label="Zoom out" className="text-muted-foreground" onClick={() => step(-1)}>
            <ZoomOut />
          </Button>
        </Tip>
        <RowsMenu
          label="Zoom"
          align="start"
          rows={[{ kind: "item" as const, id: "fit", label: "Fit", checked: zoom === "fit" }, ...ZOOMS.map((z) => ({ kind: "item" as const, id: String(z), label: `${z * 100}%`, checked: zoom === z }))]}
          onPick={(id) => set({ zoom: id === "fit" ? "fit" : Number(id) })}
          trigger={
            <Button variant="ghost" size="xs" className="font-normal text-muted-foreground tabular-nums">
              {zoom === "fit" ? "Fit" : `${zoom * 100}%`}
              <ChevronDown />
            </Button>
          }
        />
        <Tip label="Zoom in">
          <Button variant="ghost" size="icon-xs" aria-label="Zoom in" className="text-muted-foreground" onClick={() => step(1)}>
            <ZoomIn />
          </Button>
        </Tip>
      </>
    );
  }

  if (versions.length < 2) return null;
  // History sits at the bar's end, labelled, where every kind's History is (docs/DESIGN.md "The canvas pane").
  return (
    <RowsMenu
      label="Versions"
      align="end"
      rows={versionRows(shown.id)}
      onPick={(id) => (id === shown.id ? undefined : set({ compare: id }))}
      trigger={
        <Button variant="ghost" size="xs" aria-label="History" className="ms-auto">
          <History />
          <span data-narrow-hide className="@max-[560px]/bar:hidden">History</span>
        </Button>
      }
    />
  );
}
