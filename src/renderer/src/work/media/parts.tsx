import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { MediaNote, MediaRegion, MediaShape } from "@shared/contract-work-media";
import { LazyPopover } from "../../chrome/menuRows";
import { MessageMultiple } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";

/** Small parts the media canvas's views share: who wrote a note, the box drawn on a picture, and the comment field. */

const initials = (name: string): string => {
  const words = name.trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
};

/** A note's author as a reader names them: the person, an agent, or the review service's own name for them. */
export function authorOf(note: Pick<MediaNote, "by" | "external">): { name: string; agent: boolean } {
  if (note.external) return { name: note.external.author, agent: false };
  if (note.by === "owner") return { name: "You", agent: false };
  if (note.by.startsWith("agent:")) return { name: "Agent", agent: true };
  return { name: note.by.split(":").slice(1).join(":") || note.by, agent: false };
}

/** 20px: initials on `muted` for a person, the thread's glyph for an agent. */
export function Author({ note }: { note: Pick<MediaNote, "by" | "external"> }) {
  const who = authorOf(note);
  if (who.agent)
    return (
      <span aria-label="Agent" className="grid size-5 place-items-center rounded-full bg-muted text-type-chat">
        <MessageMultiple className="size-3" />
      </span>
    );
  return (
    <span aria-hidden className="grid size-5 place-items-center overflow-hidden rounded-full bg-muted text-[9px] font-semibold text-muted-foreground outline-1 -outline-offset-1 outline-(--image-outline)">
      {who.name === "You" ? "Y" : initials(who.name)}
    </span>
  );
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * The layer over a picture where a region is dragged out, in picture space
 * (0 to 1 from its top left). A press that does not move is a click,
 * handed to `onClick` (a video plays or pauses on it). `shown` is a region
 * to draw that is not being dragged (the current note's, or the selection's).
 */
export function RegionLayer({
  shown,
  shapes,
  selecting,
  onRegion,
  onClick,
  children,
}: {
  shown: MediaRegion | null;
  shapes?: MediaShape[];
  selecting: boolean;
  /** Absent: a drag takes nothing, and a press is a click. */
  onRegion?(region: MediaRegion, rect: DOMRect): void;
  onClick?(): void;
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const at = (e: ReactPointerEvent): { x: number; y: number } => {
    const r = box.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };
  const region = drag ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) } : shown;
  return (
    <div
      ref={box}
      data-media-picture
      className="absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = at(e);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = at(e);
        setDrag({ ...drag, x1: p.x, y1: p.y });
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        const p = at(e);
        const r = { x: Math.min(drag.x0, p.x), y: Math.min(drag.y0, p.y), w: Math.abs(p.x - drag.x0), h: Math.abs(p.y - drag.y0) };
        setDrag(null);
        const el = box.current!.getBoundingClientRect();
        if (!onRegion || (r.w * el.width < 6 && r.h * el.height < 6)) return onClick?.();
        onRegion(r, new DOMRect(el.left + r.x * el.width, el.top + r.y * el.height, r.w * el.width, r.h * el.height));
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {children}
      {shapes?.length ? <Shapes shapes={shapes} /> : null}
      {region ? (
        <div
          data-media-region
          className={`pointer-events-none absolute rounded-[2px] ${selecting || drag ? "bg-(--sel-bg) shadow-[0_0_0_1px_var(--accent)]" : "shadow-[0_0_0_1px_var(--foreground),0_0_0_2px_var(--background)]"}`}
          style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` }}
        >
          {selecting && !drag
            ? ["-start-[3px] -top-[3px]", "-end-[3px] -top-[3px]", "-start-[3px] -bottom-[3px]", "-end-[3px] -bottom-[3px]"].map((at) => (
                <i key={at} className={`absolute size-1.5 rounded-[1px] bg-background shadow-[0_0_0_1px_var(--accent)] ${at}`} />
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

/** Drawn marks in picture space, as a review service stores them. */
function Shapes({ shapes }: { shapes: MediaShape[] }) {
  return (
    <svg aria-hidden viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full overflow-visible">
      {shapes.map((s, i) => {
        const common = { stroke: s.color, strokeWidth: s.width, fill: "none", vectorEffect: "non-scaling-stroke" as const, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
        if (s.tool === "rect") return <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} {...common} strokeWidth={2} />;
        if (s.tool === "ellipse") return <ellipse key={i} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} {...common} strokeWidth={2} />;
        if (s.tool === "pen") return <polyline key={i} points={s.points.map((p) => `${p[0]},${p[1]}`).join(" ")} {...common} strokeWidth={2} />;
        return <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} {...common} strokeWidth={2} />;
      })}
    </svg>
  );
}

/**
 * The field a comment is written in: a popover at the moment or the region
 * it is about. Enter saves, Shift+Enter breaks the line, Escape leaves it.
 */
export function CommentPopover({ rect, about, onSave, onClose }: { rect: DOMRect | null; about: string; onSave(body: string): Promise<unknown>; onClose(): void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = rect ? { getBoundingClientRect: () => rect } : null;
  const save = async (): Promise<void> => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(body.trim());
      setBody("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <LazyPopover anchor={anchor} open={!!rect} onOpenChange={(open) => !open && onClose()} side="top" align="start" label="Comment" className="w-[320px] gap-2 p-3">
      <div className="text-xs text-muted-foreground">{about}</div>
      <Textarea
        autoFocus
        value={body}
        rows={3}
        placeholder="Comment"
        aria-label="Comment"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
      />
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" disabled={!body.trim()} onClick={() => void save()}>
          <BusyLabel busy={busy} label="Comment" />
        </Button>
      </div>
    </LazyPopover>
  );
}
