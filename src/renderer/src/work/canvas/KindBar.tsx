import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { Tip } from "../../components/tip";
import { BusyLabel, Button } from "../../components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip";
import { History } from "../icons";
import { sayError, type Feeds } from "./frame";
import type { CanvasMode, Presence, ReviewAdapter, WrittenLine } from "./kind";

export const MODE_WORDS = { suggests: "Agent suggests", writes: "Agent writes" } as const;
/** The mode in a narrow bar; the full words stay its name and its menu's rows. */
const MODE_SHORT = { suggests: "Suggests", writes: "Writes" } as const;

/**
 * Whether the bar holds anything besides the kind's own tools. A kind
 * that feeds it nothing gets no bar; one whose `Bar` renders nothing gets
 * none either (`KindBar`), though its `Bar` stays mounted to fill it later.
 */
export function barShown(feeds: Feeds, tools: boolean, history: boolean): boolean {
  return feeds.presence.length > 0 || feeds.mode !== null || tools || history || (feeds.review !== null && feeds.review.count > 0) || feeds.written !== null;
}

/** The bar's class while the kind's tools are all it could hold: it is drawn only once they render something. */
export const BAR_TOOLS_ONLY = "has-[[data-canvas-tools]:empty]:hidden";

/**
 * Under this width of canvas the bar takes its narrow form: the other people go, the mode says "Suggests" or "Writes",
 * the kind's tools marked `data-narrow-hide` go, History is its glyph alone, and the stepper drops its group's name and
 * its Previous and Next, keeping "1/3", Reject and Accept. A container query on the bar (`NARROW_HIDE`), so the form is
 * the same wherever the bar is drawn, a static render included.
 */
export const BAR_NARROW = 560;
export const NARROW_HIDE = "@max-[560px]/bar:hidden";
const NARROW_ONLY = "hidden @max-[560px]/bar:inline";
/**
 * On the tools slot: a tool a kind marks `data-narrow-hide` goes in the narrow form, whole, rather than be cut by the
 * slot's clip; and above it too while the slot cannot hold its tools (`data-tight`, `useTight`).
 */
const TOOLS_NARROW = "@max-[560px]/bar:[&_[data-narrow-hide]]:hidden data-tight:[&_[data-narrow-hide]]:hidden";

/**
 * Whether the tools overflow their slot: then the marked tools go, until the slot is as wide as the tools needed. Read
 * on every render (the tools change) and on every resize.
 */
function useTight(ref: React.RefObject<HTMLElement | null>, drawn: boolean): boolean {
  const [tight, setTight] = useState(false);
  const need = useRef(0);
  const check = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setTight((was) => {
      if (!was && el.scrollWidth > el.clientWidth + 1) {
        need.current = el.scrollWidth;
        return true;
      }
      return was && el.clientWidth < need.current;
    });
  }, [ref]);
  useLayoutEffect(check);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, check, drawn]);
  return tight;
}

/**
 * The kind's own bar, in the one order every kind keeps (docs/DESIGN.md
 * "The canvas pane"): the other people in the item, what the agent does to
 * it, the kind's own tools, History, then the changes to review at the end,
 * or the line that says what the agent last wrote. In a narrow canvas the
 * group's name goes first, then History's word; the kind's tools are
 * clipped before Reject and Accept give up any room.
 */
export function KindBar({ feeds, tools, onHistory }: { feeds: Feeds; tools?: ReactNode; onHistory?: () => void }) {
  const slot = useRef<HTMLDivElement | null>(null);
  const tight = useTight(slot, !!tools);
  const others = barShown(feeds, false, !!onHistory);
  if (!others && !tools) return null;
  const review = feeds.review && feeds.review.count > 0 ? feeds.review : null;
  return (
    <TooltipProvider>
      <div
        data-canvas-bar
        className={`@container/bar flex h-8 min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b border-border bg-background pr-2 pl-3 text-xs text-muted-foreground ${others ? "" : BAR_TOOLS_ONLY}`}
      >
        <People people={feeds.presence} />
        {feeds.mode ? <Mode mode={feeds.mode} /> : null}
        {/* The kind's tools take the free room, and are clipped to it: a tool given `ms-auto` sits at the end, before History and the stepper. */}
        {tools ? (
          <div ref={slot} data-canvas-tools data-tight={tight || undefined} className={`flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden ${TOOLS_NARROW}`}>
            {tools}
          </div>
        ) : null}
        {/* It gives up room only after the tools, and only through words: the group's name or a written line truncates; History, the count, Reject, Accept and Undo never shrink. */}
        <div className="ms-auto flex min-w-0 items-center gap-2">
          {onHistory ? <HistoryButton onClick={onHistory} /> : null}
          {review ? <Stepper review={review} /> : feeds.written ? <Written line={feeds.written} /> : null}
        </div>
      </div>
    </TooltipProvider>
  );
}

const initials = (name: string): string => {
  const words = name.trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
};

/** A person as a 20px disc: their picture, else their initials. */
function Person({ person, lapped }: { person: Presence; lapped: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-person={person.id}
            className={`grid size-5 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-[9px] font-semibold text-muted-foreground outline-1 -outline-offset-1 outline-(--image-outline) ${
              lapped ? "-ms-1.5 shadow-[0_0_0_2px_var(--background)]" : ""
            }`}
          />
        }
      >
        {person.image ? <img src={person.image} alt="" className="size-full object-cover" /> : initials(person.name)}
      </TooltipTrigger>
      <TooltipContent>{person.name}</TooltipContent>
    </Tooltip>
  );
}

/** At most three faces; the rest are counted. */
function People({ people }: { people: readonly Presence[] }) {
  if (people.length === 0) return null;
  const faces = people.length > 4 ? people.slice(0, 3) : people;
  const more = people.length - faces.length;
  return (
    <div role="group" aria-label={people.map((person) => person.name).join(", ")} className={`flex shrink-0 items-center ${NARROW_HIDE}`}>
      {faces.map((person, index) => (
        <Person key={person.id} person={person} lapped={index > 0} />
      ))}
      {more > 0 ? <span className="ms-1 tabular-nums">+{more}</span> : null}
    </div>
  );
}

/** The mode's words: in full, or short in a narrow bar, where the full words stay for a screen reader. */
function ModeWords({ value }: { value: CanvasMode["value"] }) {
  return (
    <>
      <span className="@max-[560px]/bar:sr-only">{MODE_WORDS[value]}</span>
      <span aria-hidden className={NARROW_ONLY}>
        {MODE_SHORT[value]}
      </span>
    </>
  );
}

function Mode({ mode }: { mode: CanvasMode }) {
  const set = mode.set;
  if (!set)
    return (
      <span className="shrink-0">
        <ModeWords value={mode.value} />
      </span>
    );
  const rows: MenuRow[] = [
    { kind: "item", id: "suggests", label: MODE_WORDS.suggests, checked: mode.value === "suggests" },
    { kind: "item", id: "writes", label: MODE_WORDS.writes, checked: mode.value === "writes" },
    ...(mode.note ? ([{ kind: "sep" }, { kind: "note", id: "why", content: <span className="text-xs text-muted-foreground">{mode.note}</span> }] satisfies MenuRow[]) : []),
  ];
  return (
    <RowsMenu
      label="What the agent does"
      align="start"
      rows={rows}
      onPick={(id) => {
        if (id === "suggests" || id === "writes") set(id);
      }}
      trigger={
        <Button variant="ghost" size="xs" aria-label={MODE_WORDS[mode.value]} className="shrink-0 font-normal text-muted-foreground">
          <ModeWords value={mode.value} />
          <ChevronDown />
        </Button>
      }
    />
  );
}

/** The one stepper: Previous, where the caret is among the changes, Next, then Reject and Accept for that change. */
function Stepper({ review }: { review: ReviewAdapter }) {
  const [pending, setPending] = useState<"accept" | "reject" | null>(null);
  const { index, count } = review;
  const none = index < 0;
  // The group the current change is in, named only when there is more than one to tell apart.
  let group: string | null = null;
  if (review.groups.length > 1 && !none) {
    let seen = 0;
    for (const g of review.groups) {
      seen += g.count;
      if (index < seen) {
        group = g.label;
        break;
      }
    }
  }
  const decide = (verb: "accept" | "reject"): void => {
    setPending(verb);
    review[verb](index)
      .catch((error: unknown) => sayError(error, verb === "accept" ? "Couldn't accept the change" : "Couldn't reject the change"))
      .finally(() => setPending(null));
  };
  const busy = pending !== null;
  // One change, already the current one: there is nowhere to step, so only the verbs show.
  const steps = !(count === 1 && index === 0);
  return (
    <div role="toolbar" aria-label="Review changes" aria-busy={busy || undefined} className="flex min-w-0 items-center gap-1">
      {group ? <span className={`max-w-40 min-w-0 truncate pe-1 ${NARROW_HIDE}`}>{group}</span> : null}
      {steps ? (
        <>
          <Step label="Previous change" disabled={busy || index <= 0} className={NARROW_HIDE} onClick={() => review.step(index - 1)}>
            <ChevronLeft />
          </Step>
          <span className="min-w-6 shrink-0 text-center text-foreground tabular-nums select-none">
            {index + 1}/{count}
          </span>
          <Step label="Next change" disabled={busy || index >= count - 1} className={NARROW_HIDE} onClick={() => review.step(index + 1)}>
            <ChevronRight />
          </Step>
        </>
      ) : null}
      <Button variant="ghost" size="xs" disabled={busy || none} onClick={() => decide("reject")}>
        <BusyLabel busy={pending === "reject"} label="Reject" />
      </Button>
      <Button variant="secondary" size="xs" disabled={busy || none} onClick={() => decide("accept")}>
        <BusyLabel busy={pending === "accept"} label="Accept" />
      </Button>
    </div>
  );
}

/** History at the bar's end: its glyph and word, or in a narrow bar its glyph alone, which then takes the standard tip. */
function HistoryButton({ onClick }: { onClick(): void }) {
  const button = useRef<HTMLButtonElement | null>(null);
  const word = useRef<HTMLSpanElement | null>(null);
  const [bare, setBare] = useState(false);
  // The container query decides whether the word shows; the button's size follows it, so the tip is right before the pointer arrives.
  const look = (): void => setBare(!!word.current && getComputedStyle(word.current).display === "none");
  useLayoutEffect(() => {
    const el = button.current;
    look();
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(look);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <Tip label="History" disabled={!bare}>
      <Button ref={button} variant="ghost" size="xs" aria-label="History" className="shrink-0" onClick={onClick} onPointerEnter={look} onFocus={look}>
        <History />
        <span ref={word} className={NARROW_HIDE}>
          History
        </span>
      </Button>
    </Tip>
  );
}

function Step({ label, disabled = false, className, onClick, children }: { label: string; disabled?: boolean; className?: string; onClick(): void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} className={className} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** What the agent wrote directly, with its way back. */
function Written({ line }: { line: WrittenLine }) {
  const [undoing, setUndoing] = useState(false);
  const undo = line.undo;
  return (
    <div data-canvas-written className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate tabular-nums">{line.text}</span>
      {undo ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={undoing}
          onClick={() => {
            setUndoing(true);
            undo()
              .catch((error: unknown) => sayError(error, "Couldn't undo"))
              .finally(() => setUndoing(false));
          }}
        >
          <BusyLabel busy={undoing} label="Undo" />
        </Button>
      ) : null}
    </div>
  );
}
