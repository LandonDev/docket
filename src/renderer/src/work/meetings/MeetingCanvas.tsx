import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Meeting } from "@shared/contract-work-meetings";
import type { CanvasSource } from "@shared/work";
import { ChevronLeft, ChevronRight, Copy, Search, X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { GroupInput, InputGroup } from "../../components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { uploadAttachment } from "../../lib/attachmentUpload";
import { dayTime } from "../../lib/duration";
import { sayError } from "../canvas/frame";
import type { CanvasBodyProps, CanvasShell, MoreEntry, ReviewAdapter } from "../canvas/kind";
import { Download, Export } from "../icons";
import { decideTasks, loadMeeting, startMeeting, startOnce, undoNotes, useMeeting } from "./data";
import { Failed, NotesDoc, NothingYet, PlainName, PlayerRow, Progress, Turns, TurnsSkeleton } from "./MeetingView";
import { findHits, proposedTasks, segmentAt, stretchLabel, stretchOf, tasksByTurn, transcriptText } from "./model";
import { readRecording, usePlayer } from "./player";
import { SpeakerName } from "./Speaker";

/**
 * The meeting kind's chunk (docs/agents/work-meetings.md "The canvas"): the
 * body, which plays the recording over its transcript and feeds the pane
 * (the mode, the notes' Undo, the tasks to accept, a stretch to Ask about),
 * and the bar's own tools, the Notes and Transcript switch and Find. The two
 * share the item's kept state (`MeetingState`) and its one copy (data.ts).
 */

export interface MeetingState {
  tab: "transcript" | "notes";
  /** Find, while it is open: the words and which hit is current */
  find: { query: string; index: number } | null;
}
const FIRST: MeetingState = { tab: "transcript", find: null };

/** The pane's feeds from the meeting: the mode, what the agent wrote, the tasks to step through, and a filing that failed. */
function useFeeds(shell: CanvasShell, env: string, meeting: Meeting | null, current: string | null, onStep: (id: string) => void, unread: { error: string; retry(): void } | null) {
  const [fileError, setFileError] = useState<{ error: string; ids: string[] } | null>(null);
  const ready = meeting?.status === "ready";
  const notes = meeting?.notes ?? null;
  const itemId = meeting?.itemId ?? null;
  const proposed = useMemo(() => (meeting ? proposedTasks(meeting) : []), [meeting]);

  const made = !!meeting && meeting.status !== "empty";
  useEffect(() => {
    // Notes on his own recording are a direct write with Undo; tasks always wait for him.
    shell.mode(made ? { value: "writes" } : null);
    return () => shell.mode(null);
  }, [shell, made]);

  useEffect(() => {
    shell.written(ready && itemId && notes?.canUndo ? { text: `Wrote notes, ${dayTime(notes.writtenAt)}`, undo: () => undoNotes(env, itemId) } : null);
    return () => shell.written(null);
  }, [shell, env, ready, itemId, notes?.canUndo, notes?.writtenAt]);

  const decide = useCallback(
    async (ids: string[], decision: "accept" | "reject"): Promise<void> => {
      if (!itemId || ids.length === 0) return;
      const failed = await decideTasks(env, itemId, ids, decision);
      setFileError(failed.length ? { error: failed[0].error, ids: failed.map((f) => f.id) } : null);
    },
    [env, itemId],
  );

  useEffect(() => {
    if (!ready || proposed.length === 0) {
      shell.review(null);
      return;
    }
    const at = Math.max(0, proposed.findIndex((a) => a.id === current));
    const which = (w: number | { group: string } | "all"): string[] => (typeof w === "number" ? (proposed[w] ? [proposed[w].id] : []) : proposed.map((a) => a.id));
    const review: ReviewAdapter = {
      groups: [{ id: "tasks", label: "Tasks", by: `agent:${env}:${meeting?.sessionId ?? ""}`, count: proposed.length }],
      index: at,
      count: proposed.length,
      step: (to) => proposed[to] && onStep(proposed[to].id),
      accept: (w) => decide(which(w), "accept"),
      reject: (w) => decide(which(w), "reject"),
    };
    shell.review(review);
    return () => shell.review(null);
  }, [shell, env, ready, proposed, current, onStep, decide, meeting?.sessionId]);

  const unreadError = unread?.error ?? null;
  const retry = unread?.retry;
  useEffect(() => {
    const failed = fileError;
    if (unreadError && retry) shell.statusLine({ tone: "failed", word: "The host did not answer", detail: unreadError, action: { label: "Retry", run: retry } });
    else shell.statusLine(failed ? { tone: "failed", word: "Not filed in LifeOS", detail: failed.error, action: { label: "Try again", run: () => decide(failed.ids, "accept") } } : null);
    return () => shell.statusLine(null);
  }, [shell, fileError, decide, unreadError, retry]);

  return proposed;
}

/** What he selected in the transcript: the turns it covers, offered to Ask as "15:02 to 15:41, Staff sync" with Copy. */
function useStretch(root: RefObject<HTMLDivElement | null>, shell: CanvasShell, meeting: Meeting | null, source: CanvasSource): string[] {
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    if (!meeting) return;
    let frame = 0;
    const clear = (): void => {
      setSelected((was) => (was.length ? [] : was));
      shell.selection(null);
    };
    const read = (): void => {
      frame = 0;
      const sel = document.getSelection();
      const box = root.current;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !box) return clear();
      const range = sel.getRangeAt(0);
      if (!box.contains(range.commonAncestorContainer)) return clear();
      const turnOf = (node: Node): string | null => (node instanceof Element ? node : node.parentElement)?.closest("[data-turn]")?.getAttribute("data-turn") ?? null;
      const a = meeting.segments.findIndex((s) => s.id === turnOf(range.startContainer));
      const b = meeting.segments.findIndex((s) => s.id === turnOf(range.endContainer));
      if (a < 0 || b < 0) return clear();
      const ids = meeting.segments.slice(Math.min(a, b), Math.max(a, b) + 1).map((s) => s.id);
      const span = stretchOf(meeting.segments, ids)!;
      const quote = sel.toString().trim().slice(0, 4000);
      setSelected(ids.length > 1 ? ids : []);
      shell.selection({
        chip: { kind: "selection", label: stretchLabel(meeting, span), ref: source, quote },
        rect: range.getBoundingClientRect(),
        tools: (
          <Button variant="ghost" size="xs" className="rounded-lg text-[13px]" onMouseDown={(event) => event.preventDefault()} onClick={() => void navigator.clipboard?.writeText(quote)}>
            <Copy />
            Copy
          </Button>
        ),
      });
    };
    const onChange = (): void => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [root, shell, meeting, source]);
  return selected;
}

/**
 * The meeting's own verbs in the pane's More: Export transcript once there is
 * one, and Download recording, the original as it was dropped, read from the
 * host that holds it. While it comes the row says how far and takes no press.
 */
function useMore(shell: CanvasShell, env: string, meeting: Meeting | null): void {
  const ready = meeting?.status === "ready" && meeting.segments.length > 0 ? meeting : null;
  const recording = meeting?.from === "recording" ? meeting.itemId : null;
  const [fetched, setFetched] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const entries: MoreEntry[] = [];
    if (ready)
      entries.push({ id: "export-transcript", label: "Export transcript", icon: Export, run: () => saveBlob(`${ready.title.replace(/\.[A-Za-z0-9]{1,5}$/, "")}.txt`, new Blob([transcriptText(ready)], { type: "text/plain;charset=utf-8" })) });
    if (recording)
      entries.push({
        id: "download-recording",
        label: fetched === null ? "Download recording" : `Downloading… ${Math.round(fetched * 100)}%`,
        icon: Download,
        disabled: fetched !== null,
        run: async () => {
          const signal = (abort.current = new AbortController()).signal;
          setFetched(0);
          try {
            const { name, blob } = await readRecording(env, recording, setFetched, signal);
            saveBlob(name, blob);
          } finally {
            if (!signal.aborted) setFetched(null);
          }
        },
      });
    if (entries.length === 0) return;
    shell.more?.(entries);
    return () => shell.more?.(null);
  }, [shell, env, ready, recording, fetched]);
}

/** Saves a file where the person keeps downloads. */
function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function Body({ item, source, env, state, shell }: CanvasBodyProps<MeetingState>) {
  const view = state ?? FIRST;
  const { meeting, loaded, error } = useMeeting(env, item.id);
  const player = usePlayer(env, meeting?.media?.audio, meeting?.durationSec ?? 0);
  const [uploading, setUploading] = useState(false);
  const [task, setTask] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const turnsBox = useRef<HTMLDivElement>(null);

  // An item opened on a file starts it once; one opened empty waits for a file.
  const needsFile = loaded && !error && (!meeting || meeting.status === "empty");
  const [startError, setStartError] = useState<string | null>(null);
  useEffect(() => {
    if (needsFile && source.at === "file") startOnce(env, item.id)?.catch((err: unknown) => setStartError(err instanceof Error ? err.message : String(err)));
  }, [needsFile, source.at, env, item.id]);

  const reveal = useCallback((selector: string) => {
    requestAnimationFrame(() => scroller.current?.querySelector(selector)?.scrollIntoView({ block: "center" }));
  }, []);
  const { seek } = player;
  const onStep = useCallback(
    (id: string) => {
      setTask(id);
      const at = meeting?.notes?.actions.find((a) => a.id === id)?.at;
      if (typeof at === "number") seek(at);
      reveal(`[data-task="${id}"]`);
    },
    [meeting, seek, reveal],
  );
  const retry = useCallback(() => loadMeeting(env, item.id), [env, item.id]);
  const proposed = useFeeds(shell, env, meeting, task, onStep, error && !meeting ? { error, retry } : null);
  const current = proposed.some((a) => a.id === task) ? task : (proposed[0]?.id ?? null);
  const selected = useStretch(turnsBox, shell, meeting, source);
  useMore(shell, env, meeting);

  const hits = useMemo(() => (meeting && view.find ? findHits(meeting.segments, view.find.query) : []), [meeting, view.find]);
  const hit = view.find && hits.length ? hits[((view.find.index % hits.length) + hits.length) % hits.length] : null;
  useEffect(() => {
    if (hit) reveal(`[data-turn="${hit.segment}"] mark[data-hit="current"]`);
  }, [hit, reveal]);

  const choose = (file: File): void => {
    setUploading(true);
    uploadAttachment(env, item.sessionId, { id: crypto.randomUUID(), name: file.name, mimeType: file.type || "application/octet-stream", kind: "file", size: file.size, blob: file })
      .then((landed) => {
        if (!landed.path) throw new Error(`${file.name} did not land on the thread's host`);
        return startMeeting(env, item.id, { at: "file", host: env, path: landed.path });
      })
      .catch((err: unknown) => sayError(err, `Couldn't open ${file.name}`))
      .finally(() => setUploading(false));
  };

  if (startError && needsFile) {
    // The host never answered the start: say so, with Try again, in the transcript's place.
    const retry = (): Promise<void> => {
      setStartError(null);
      return startMeeting(env, item.id).then(
        () => undefined,
        (err: unknown) => setStartError(err instanceof Error ? err.message : String(err)),
      );
    };
    return <Failed meeting={{ from: null, error: startError }} onRetry={retry} title="Could not open the recording" />;
  }
  if (!loaded || (needsFile && source.at === "file") || (error && !meeting)) return <TurnsSkeleton />;
  if (!meeting || meeting.status === "empty") {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          const file = event.dataTransfer.files[0];
          if (!file) return;
          event.preventDefault();
          choose(file);
        }}
      >
        <NothingYet uploading={uploading} onChoose={choose} />
      </div>
    );
  }

  const hasPlayer = meeting.from === "recording";
  const span = selected.length ? stretchOf(meeting.segments, selected) : null;
  const playing = player.touched ? (segmentAt(meeting.segments, player.position)?.id ?? null) : null;
  const tab = meeting.status === "ready" && meeting.notes && view.tab === "notes" ? "notes" : "transcript";
  const play = (t: number): void => player.seek(t, true);
  return (
    <div data-meeting={meeting.status} className="flex min-h-0 flex-1 flex-col">
      {hasPlayer ? <PlayerRow meeting={meeting} player={player} span={span} /> : null}
      {player.error ? <p className="px-3 pt-2 text-xs text-destructive">{player.error}</p> : null}
      <div ref={scroller} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {meeting.status === "failed" ? (
          <Failed meeting={meeting} onRetry={() => startMeeting(env, item.id).then(() => undefined, (err: unknown) => sayError(err, "Couldn't start it again"))} />
        ) : tab === "notes" ? (
          <NotesDoc meeting={meeting} currentTask={current} onPlay={play} onTask={setTask} />
        ) : (
          <div ref={turnsBox}>
            <Turns
              meeting={meeting}
              current={playing}
              hits={hits}
              hit={hit}
              selected={selected}
              tasks={meeting.status === "ready" ? tasksByTurn(meeting) : new Map()}
              currentTask={current}
              onSeek={(t) => player.seek(t)}
              onTask={setTask}
              name={(speaker) => (meeting.status === "ready" ? <SpeakerName env={env} itemId={item.id} speaker={speaker} /> : <PlainName speakers={meeting.speakers} speaker={speaker} />)}
              after={meeting.status === "transcribing" ? <Progress meeting={meeting} /> : null}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** The bar's tools: the Notes and Transcript switch once there are notes, then Find. */
export function Bar({ item, env, state, setState }: CanvasBodyProps<MeetingState>) {
  const view = state ?? FIRST;
  const { meeting } = useMeeting(env, item.id);
  const input = useRef<HTMLInputElement>(null);
  if (!meeting || meeting.status === "empty") return null;
  const notes = meeting.status === "ready" && meeting.notes !== null;
  const hits = view.find ? findHits(meeting.segments, view.find.query) : [];
  const index = hits.length && view.find ? ((view.find.index % hits.length) + hits.length) % hits.length : -1;
  const move = (by: number): void => {
    if (view.find && hits.length) setState({ ...view, find: { ...view.find, index: index + by } });
  };
  return (
    <>
      {notes && !view.find ? (
        <Tabs value={view.tab} onValueChange={(tab) => setState({ ...view, tab: tab as MeetingState["tab"] })}>
          <TabsList aria-label="Show" className="group-data-[orientation=horizontal]/tabs:h-6">
            <TabsTrigger value="notes" className="px-2 text-xs">
              Notes
            </TabsTrigger>
            <TabsTrigger value="transcript" className="px-2 text-xs">
              Transcript
            </TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      {view.find ? (
        <div data-meeting-find className="ms-auto flex min-w-0 items-center gap-1">
          <InputGroup className="h-6 w-56 rounded-md px-2 [&_svg:not([class*='size-'])]:size-3" leading={<Search />}>
            <GroupInput
              ref={input}
              autoFocus
              aria-label="Find in the transcript"
              placeholder="Find"
              className="text-xs"
              value={view.find.query}
              onChange={(event) => setState({ ...view, find: { query: event.currentTarget.value, index: 0 } })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  move(event.shiftKey ? -1 : 1);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setState({ ...view, find: null });
                }
              }}
            />
          </InputGroup>
          {view.find.query.trim() ? (
            <span className="mx-1 whitespace-nowrap tabular-nums">{hits.length ? `${index + 1}/${hits.length}` : "None"}</span>
          ) : null}
          <Button variant="ghost" size="icon-xs" aria-label="Previous match" disabled={hits.length < 2} onClick={() => move(-1)}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Next match" disabled={hits.length < 2} onClick={() => move(1)}>
            <ChevronRight />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={() => setState({ ...view, find: null })}>
            <X />
          </Button>
        </div>
      ) : (
        <Button variant="ghost" size="icon-xs" aria-label="Find" className="ms-auto text-muted-foreground" onClick={() => setState({ ...view, tab: "transcript", find: { query: "", index: 0 } })}>
          <Search />
        </Button>
      )}
    </>
  );
}
