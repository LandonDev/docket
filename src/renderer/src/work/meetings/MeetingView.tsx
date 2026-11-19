import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { Meeting, MeetingAction, MeetingNote, MeetingSegment, MeetingSpeaker } from "@shared/contract-work-meetings";
import { ListPlus, Pause, Play } from "../../chrome/icons";
import { RowsMenu } from "../../chrome/menuRows";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { BusyLabel, Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { Task } from "../icons";
import { dueOf, markRuns, progressLine, speakerName, timeOf, waveBars, type FindHit } from "./model";
import { SPEEDS, type Player, type Speed } from "./player";

/**
 * The meeting view (docs/DESIGN.md "The canvas pane", Meetings; the approved
 * prototype .temp-code/prototypes/work-workspaces-2/meeting.html, its pick:
 * the transcript with a slim player over it). Drawn from props alone, so a
 * preview page and a test can draw any moment; MeetingCanvas.tsx feeds it.
 */

// ── the player ───────────────────────────────────────────────────────

/** The waveform: what has played in the foreground, a stretch's span on the selection tint. Drags and arrows move the position. */
function Wave({ peaks, durationSec, position, span, onSeek, label }: { peaks: readonly number[]; durationSec: number; position: number; span: { start: number; end: number } | null; onSeek(t: number): void; label: string }) {
  const bars = waveBars(peaks);
  const played = durationSec > 0 ? position / durationSec : 0;
  const box = useRef<HTMLDivElement>(null);
  const at = (event: PointerEvent): number => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * durationSec;
  };
  const key = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 30 : 5;
    const to = event.key === "ArrowLeft" ? position - step : event.key === "ArrowRight" ? position + step : event.key === "Home" ? 0 : event.key === "End" ? durationSec : null;
    if (to === null) return;
    event.preventDefault();
    onSeek(to);
  };
  const live = durationSec > 0;
  return (
    <div
      ref={box}
      data-meeting-wave
      role="slider"
      tabIndex={live ? 0 : -1}
      aria-label="Position"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationSec)}
      aria-valuenow={Math.round(position)}
      aria-valuetext={label}
      aria-disabled={!live || undefined}
      className="focus-ring relative flex h-6 min-w-0 flex-1 touch-none items-center gap-px rounded-sm"
      onPointerDown={(event) => {
        if (!live || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        onSeek(at(event));
      }}
      onPointerMove={(event) => {
        if (live && event.currentTarget.hasPointerCapture(event.pointerId)) onSeek(at(event));
      }}
      onKeyDown={live ? key : undefined}
    >
      {bars.map((h, i) => (
        <span
          key={i}
          data-played={(i + 0.5) / bars.length <= played || undefined}
          className="min-w-0 flex-1 rounded-[1px] bg-(--wave) data-played:bg-foreground"
          style={{ height: `${Math.min(22, 4 + Math.round(h * 18))}px` }}
        />
      ))}
      {span && live ? (
        <span
          data-meeting-span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 rounded-[3px] bg-(--sel-bg)"
          style={{ left: `${(span.start / durationSec) * 100}%`, width: `${(Math.max(0, span.end - span.start) / durationSec) * 100}%` }}
        />
      ) : null}
    </div>
  );
}

/** The 40px row: play, the time, the wave, the speed. It works while a recording transcribes and after it fails, once the copy is there. */
export function PlayerRow({ meeting, player, span }: { meeting: Pick<Meeting, "durationSec" | "peaks">; player: Player; span: { start: number; end: number } | null }) {
  const now = timeOf(player.position, meeting);
  const total = timeOf(meeting.durationSec, meeting);
  return (
    <div data-meeting-player className="flex h-10 min-w-0 shrink-0 items-center gap-1 border-b border-border pr-2 pl-1.5">
      <Button variant="ghost" size="icon-sm" aria-label={player.playing ? "Pause" : "Play"} disabled={!player.playable} onClick={player.toggle}>
        {player.loading ? <BusyLabel busy label="" /> : player.playing ? <Pause /> : <Play />}
      </Button>
      <span className="ms-0.5 me-2 text-[13px] leading-5 whitespace-nowrap tabular-nums">
        {now} <span className="text-muted-foreground">/ {total}</span>
      </span>
      <Wave peaks={meeting.peaks} durationSec={meeting.durationSec} position={player.position} span={span} onSeek={(t) => player.seek(t)} label={`${now} of ${total}`} />
      <RowsMenu
        label="Speed"
        align="end"
        rows={SPEEDS.map((s) => ({ kind: "item" as const, id: String(s), label: `${s}×`, checked: s === player.rate }))}
        onPick={(id) => player.setRate(Number(id) as Speed)}
        trigger={
          <Button variant="ghost" size="xs" aria-label="Speed" className="ms-1 w-10 font-normal text-muted-foreground tabular-nums">
            {player.rate}×
          </Button>
        }
      />
    </div>
  );
}

// ── the transcript ───────────────────────────────────────────────────

/** A task the meeting yielded, where it was said: tinted until he accepts, then marked as LifeOS's. */
export function TaskRow({ action, current, doc = false, onPick, at }: { action: MeetingAction; current: boolean; doc?: boolean; onPick?(): void; at?: ReactNode }) {
  const due = dueOf(action.due);
  const waiting = action.state === "proposed";
  return (
    <div
      data-task={action.id}
      data-state={action.state}
      data-current={(waiting && current) || undefined}
      onClick={(event) => {
        event.stopPropagation();
        onPick?.();
      }}
      className={`flex min-h-7 min-w-0 items-center gap-2 rounded-md px-2 py-1 data-current:outline-1 data-current:-outline-offset-1 data-current:outline-success/50 data-[state=proposed]:bg-(--add-bg) ${
        doc ? "-mx-2 mt-1 text-[15px] leading-6" : "mt-1.5 text-[13px] leading-5"
      }`}
    >
      {waiting ? <ListPlus aria-label="Waiting for you" className="size-3.5 shrink-0 text-muted-foreground" /> : <Task aria-label="In LifeOS" className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className={`min-w-0 ${doc ? "" : "truncate font-medium"}`}>
        {action.text}
        {doc && due ? `, ${due}` : null}
        {at}
      </span>
      {!doc && due ? <span className="shrink-0 text-xs text-muted-foreground">{due}</span> : null}
    </div>
  );
}

export interface TurnsProps {
  meeting: Meeting;
  /** the turn playing, once he played or moved the position */
  current: string | null;
  hits: readonly FindHit[];
  hit: FindHit | null;
  /** the turns a stretch covers, in order */
  selected: readonly string[];
  tasks: ReadonlyMap<string, MeetingAction[]>;
  currentTask: string | null;
  onSeek(t: number): void;
  onTask(id: string): void;
  /** a speaker's name, as a control that names them */
  name(speaker: MeetingSpeaker | null): ReactNode;
  /** what follows the last turn in the same column: the working line while it transcribes */
  after?: ReactNode;
}

/** Each turn: the name and its minute over the words; a click seeks, unless it ended a selection. */
export function Turns({ meeting, current, hits, hit, selected, tasks, currentTask, onSeek, onTask, name, after }: TurnsProps) {
  const seen = new Set<string>();
  return (
    <div data-meeting-turns className="mx-auto flex max-w-[704px] flex-col gap-0.5 px-2 pt-2 pb-6">
      {meeting.segments.map((seg) => {
        const first = seg.speaker !== null && !seen.has(seg.speaker);
        if (seg.speaker) seen.add(seg.speaker);
        const speaker = meeting.speakers.find((s) => s.id === seg.speaker) ?? null;
        const at = selected.indexOf(seg.id);
        const sel = at < 0 ? undefined : selected.length === 1 ? "only" : at === 0 ? "first" : at === selected.length - 1 ? "last" : "mid";
        return (
          <Turn
            key={seg.id}
            seg={seg}
            meeting={meeting}
            current={current === seg.id && sel === undefined}
            sel={sel}
            hits={hits.filter((h) => h.segment === seg.id)}
            hit={hit}
            onSeek={onSeek}
            nameNode={name(speaker)}
            hint={first && speaker?.suggested && !speaker.name ? `Sounds like ${speaker.suggested}` : null}
          >
            {(tasks.get(seg.id) ?? []).map((a) => (
              <TaskRow key={a.id} action={a} current={currentTask === a.id} onPick={() => onTask(a.id)} />
            ))}
          </Turn>
        );
      })}
      {after}
    </div>
  );
}

function Turn({ seg, meeting, current, sel, hits, hit, onSeek, nameNode, hint, children }: { seg: MeetingSegment; meeting: Meeting; current: boolean; sel?: string; hits: FindHit[]; hit: FindHit | null; onSeek(t: number): void; nameNode: ReactNode; hint: string | null; children?: ReactNode }) {
  return (
    <div
      data-turn={seg.id}
      data-sel={sel}
      aria-current={current || undefined}
      onClick={() => {
        // A click that ends a drag across the words is a selection, not a seek.
        if (globalThis.getSelection?.()?.isCollapsed === false) return;
        onSeek(seg.start);
      }}
      className="relative rounded-lg px-3 py-2 [content-visibility:auto] [contain-intrinsic-size:auto_64px] transition-[background-color] duration-(--dur-hover) ease-(--ease-out) hover:bg-foreground/4 aria-current:bg-muted data-sel:rounded-none data-sel:bg-(--sel-bg) data-[sel=first]:rounded-t-lg data-[sel=last]:-mt-0.5 data-[sel=last]:rounded-b-lg data-[sel=mid]:-mt-0.5 data-[sel=only]:rounded-lg motion-reduce:transition-none"
    >
      <div className="flex min-w-0 items-baseline gap-2 text-[13px] leading-5">
        {nameNode}
        <Button
          variant="link"
          size="xs"
          aria-label={`Go to ${timeOf(seg.start, meeting)}`}
          onClick={(event) => {
            event.stopPropagation();
            onSeek(seg.start);
          }}
          className="h-auto p-0 text-xs leading-5 font-normal text-muted-foreground tabular-nums underline-offset-3"
        >
          <time>{timeOf(seg.start, meeting)}</time>
        </Button>
        {hint ? <span className="min-w-0 truncate text-xs text-muted-foreground">{hint}</span> : null}
      </div>
      <p className="mt-0.5 text-sm leading-[22px] text-pretty select-text">
        {markRuns(seg.text, hits, hit).map((run, i) =>
          run.hit === "none" ? (
            run.text
          ) : (
            <mark
              key={i}
              data-hit={run.hit}
              className="rounded-[2px] bg-(--find-hit) text-inherit data-[hit=current]:bg-(--sel-bg) data-[hit=current]:outline-1 data-[hit=current]:outline-accent"
            >
              {run.text}
            </mark>
          ),
        )}
      </p>
      {children}
    </div>
  );
}

/** While it transcribes: the turns heard so far, the working line, then turns still to come. */
export function Progress({ meeting }: { meeting: Meeting }) {
  return (
    <div data-meeting-progress>
      <div role="status" className="mx-3 mt-2 flex h-7 items-center gap-2 text-[13px] text-muted-foreground">
        <Spinner className="size-3.5" />
        <span>{progressLine(meeting)}</span>
      </div>
      {[
        [30, 84, 62],
        [24, 70],
      ].map((widths, i) => (
        <div key={i} aria-hidden className="flex flex-col gap-2 px-3 py-2">
          {widths.map((w, j) => (
            <Skeleton key={j} className="h-3" style={{ width: `${w}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A meeting still loading, in the transcript's shape. */
export function TurnsSkeleton() {
  return (
    <div data-meeting-skeleton aria-busy="true" aria-label="Loading" className="mx-auto flex max-w-[704px] flex-col px-2 pt-2">
      {[
        [18, 92, 70],
        [22, 80],
        [16, 88, 54],
      ].map((widths, i) => (
        <div key={i} className="flex flex-col gap-2 px-3 py-2">
          {widths.map((w, j) => (
            <Skeleton key={j} className={j === 0 ? "h-3" : "h-3.5"} style={{ width: `${w}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── the notes ────────────────────────────────────────────────────────

/** A line's minute: an accent link that plays that moment. */
export function MinuteLink({ at, meeting, onPlay }: { at: number | null; meeting: Pick<Meeting, "durationSec">; onPlay(t: number): void }) {
  if (at === null) return null;
  return (
    <Button
      variant="link"
      size="xs"
      data-minute={at}
      aria-label={`Play from ${timeOf(at, meeting)}`}
      onClick={(event) => {
        event.stopPropagation();
        onPlay(at);
      }}
      className="ms-1.5 h-auto p-0 align-baseline text-[13px] leading-6 font-normal text-accent tabular-nums underline-offset-3"
    >
      {timeOf(at, meeting)}
    </Button>
  );
}

/** The agent's notes as a short document: what was said first, then Decided, To do and Open questions, each line ending in its minute. */
export function NotesDoc({ meeting, currentTask, onPlay, onTask }: { meeting: Meeting; currentTask: string | null; onPlay(t: number): void; onTask(id: string): void }) {
  const notes = meeting.notes;
  if (!notes) return null;
  const line = (n: MeetingNote) => (
    <p key={n.id} data-note={n.id} className="mt-1 text-pretty first:mt-0">
      {n.text}
      <MinuteLink at={n.at} meeting={meeting} onPlay={onPlay} />
    </p>
  );
  const head = (text: string) => <h2 className="mt-6 text-base leading-6 font-semibold tracking-[-0.01em] first:mt-0">{text}</h2>;
  const todo = notes.actions.filter((a) => a.state !== "rejected");
  return (
    <div data-meeting-notes className="mx-auto max-w-[672px] px-6 pt-5 pb-8 text-[15px] leading-6">
      {notes.summary.map(line)}
      {notes.decisions.length ? (
        <>
          {head("Decided")}
          {notes.decisions.map(line)}
        </>
      ) : null}
      {todo.length ? (
        <>
          {head("To do")}
          {todo.map((a) => (
            <TaskRow key={a.id} action={a} doc current={currentTask === a.id} onPick={() => onTask(a.id)} at={<MinuteLink at={a.at} meeting={meeting} onPlay={onPlay} />} />
          ))}
        </>
      ) : null}
      {notes.questions.length ? (
        <>
          {head("Open questions")}
          {notes.questions.map(line)}
        </>
      ) : null}
    </div>
  );
}

// ── nothing yet, and a failure ───────────────────────────────────────

/** One Empty: drop a recording or choose one. */
export function NothingYet({ uploading, onChoose }: { uploading: boolean; onChoose(file: File): void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Empty data-meeting-empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>Drop a recording</EmptyTitle>
        <EmptyDescription>Audio, video or a transcript, from any meeting.</EmptyDescription>
      </EmptyHeader>
      <input
        ref={input}
        type="file"
        hidden
        accept="audio/*,video/*,.vtt,.srt,.txt,.docx"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onChoose(file);
        }}
      />
      <Button size="sm" variant="secondary" disabled={uploading} onClick={() => input.current?.click()}>
        <BusyLabel busy={uploading} label="Choose a file" busyLabel="Uploading" />
      </Button>
    </Empty>
  );
}

/** Could not transcribe: the reason in his words, and Try again. The player above it still plays. */
export function Failed({ meeting, onRetry, title }: { meeting: Pick<Meeting, "from" | "error">; onRetry(): Promise<void>; title?: string }) {
  const [trying, setTrying] = useState(false);
  return (
    <div className="mx-auto max-w-[704px] p-4">
      <Alert variant="error" data-meeting-failed>
        <AlertTitle>{title ?? (meeting.from === "transcript" ? "Could not read the transcript" : "Could not transcribe")}</AlertTitle>
        <AlertDescription>
          <p>{meeting.error}</p>
          <Button
            variant="secondary"
            size="xs"
            className="mt-2"
            disabled={trying}
            onClick={() => {
              setTrying(true);
              void onRetry().finally(() => setTrying(false));
            }}
          >
            <BusyLabel busy={trying} label="Try again" />
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

/** The name at a turn's head, before anyone can name it (a preview, a test): plain text. */
export function PlainName({ speakers, speaker }: { speakers: readonly MeetingSpeaker[]; speaker: MeetingSpeaker | null }) {
  return <span className="min-w-0 truncate font-medium">{speakerName(speakers, speaker?.id ?? null)}</span>;
}
