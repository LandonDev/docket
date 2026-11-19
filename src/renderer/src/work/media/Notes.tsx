import { clock, frameStart } from "@shared/mediaFrames";
import type { FrameTable, MediaNote } from "@shared/contract-work-media";
import { Skeleton } from "../../components/ui/skeleton";
import { Author, authorOf } from "./parts";

/**
 * The list under the frame (docs/DESIGN.md "Images and video"): comments
 * and chapters by time, rows of 32px or more on a 36/20/1fr grid. A click
 * goes to the note's frame; the row playing sits on `muted`. An agent's note
 * waiting for the person carries the added tint, and the one the stepper is
 * on a hairline in the same hue.
 */
export function Notes({
  notes,
  table,
  current,
  playing,
  onPick,
}: {
  notes: MediaNote[];
  table: FrameTable | null;
  /** The note the stepper or a click is on. */
  current: string | null;
  /** The frame shown, for the row whose moment it is. */
  playing: number | null;
  onPick(note: MediaNote): void;
}) {
  if (notes.length === 0) return null;
  const start = table ? frameStart(table, 0) : 0;
  const at = (n: MediaNote): string | null => (table && n.anchor.frame !== undefined ? clock(frameStart(table, n.anchor.frame) - start) : null);
  const timed = table !== null;
  return (
    <div data-media-notes className="mt-2 flex min-w-0 flex-col gap-0.5 border-t border-border px-2 pt-2 pb-4">
      {notes.map((n) => {
        const waiting = n.state === "suggested";
        const on = current ? n.id === current : playing !== null && n.anchor.frame === playing;
        const who = authorOf(n);
        return (
          <button
            key={n.id}
            type="button"
            data-note={n.id}
            aria-current={on || undefined}
            onClick={() => onPick(n)}
            className={`grid w-full min-w-0 items-start gap-x-2 rounded-md px-2 py-1.5 text-start text-[13px] leading-5 text-foreground transition-[background-color] duration-(--dur-hover) ease-(--ease-out) motion-reduce:transition-none ${
              timed ? "grid-cols-[36px_20px_minmax(0,1fr)]" : "grid-cols-[20px_minmax(0,1fr)]"
            } ${waiting ? `bg-(--add-bg) ${on ? "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--success)_50%,transparent)]" : ""}` : on ? "bg-muted" : "hover:bg-foreground/5"}`}
          >
            {timed ? <time className={`text-xs leading-5 tabular-nums ${on ? "text-foreground" : "text-muted-foreground"}`}>{at(n)}</time> : null}
            {n.kind === "chapter" ? <span /> : <Author note={n} />}
            <span className={`min-w-0 text-pretty ${n.resolved ? "text-muted-foreground line-through decoration-muted-foreground/60" : ""}`}>
              {n.kind === "chapter" ? <span className="font-medium">{n.body}</span> : who.agent ? n.body : <><b className="font-medium text-muted-foreground">{who.name}</b> {n.body}</>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The list's three loading rows. */
export function NotesSkeleton() {
  return (
    <div className="mt-2 flex flex-col gap-0.5 border-t border-border px-2 pt-2 pb-4">
      {[62, 48, 70].map((w) => (
        <div key={w} className="flex h-8 items-center gap-2 px-2">
          <Skeleton className="h-3 w-7" />
          <Skeleton className="size-5 rounded-full" />
          <Skeleton className="h-3" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}
