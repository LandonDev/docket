import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { BusyLabel, Button } from "../../components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip";
import { History } from "../icons";
import { sayError, type Feeds } from "./frame";
import type { CanvasMode, Presence, ReviewAdapter, WrittenLine } from "./kind";

export const MODE_WORDS = { suggests: "Agent suggests", writes: "Agent writes" } as const;

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
 * The kind's own bar, in the one order every kind keeps (docs/DESIGN.md
 * "The canvas pane"): the other people in the item, what the agent does to
 * it, the kind's own tools, History, then the changes to review at the end,
 * or the line that says what the agent last wrote.
 */
export function KindBar({ feeds, tools, onHistory }: { feeds: Feeds; tools?: ReactNode; onHistory?: () => void }) {
  const others = barShown(feeds, false, !!onHistory);
  if (!others && !tools) return null;
  const review = feeds.review && feeds.review.count > 0 ? feeds.review : null;
  return (
    <TooltipProvider>
      <div
        data-canvas-bar
        className={`flex h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background pr-2 pl-3 text-xs text-muted-foreground ${others ? "" : BAR_TOOLS_ONLY}`}
      >
        <People people={feeds.presence} />
        {feeds.mode ? <Mode mode={feeds.mode} /> : null}
        {/* The kind's tools take the free room, so a tool given `ms-auto` sits at the end, before History and the stepper. */}
        {tools ? <div data-canvas-tools className="flex min-w-0 flex-1 items-center gap-0.5">{tools}</div> : null}
        <div className="ms-auto flex min-w-0 shrink-0 items-center gap-2">
          {onHistory ? (
            <Button variant="ghost" size="xs" onClick={onHistory}>
              <History />
              History
            </Button>
          ) : null}
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
    <div role="group" aria-label={people.map((person) => person.name).join(", ")} className="flex shrink-0 items-center">
      {faces.map((person, index) => (
        <Person key={person.id} person={person} lapped={index > 0} />
      ))}
      {more > 0 ? <span className="ms-1 tabular-nums">+{more}</span> : null}
    </div>
  );
}

function Mode({ mode }: { mode: CanvasMode }) {
  const set = mode.set;
  if (!set) return <span className="shrink-0">{MODE_WORDS[mode.value]}</span>;
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
        <Button variant="ghost" size="xs" className="shrink-0 font-normal text-muted-foreground">
          {MODE_WORDS[mode.value]}
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
  return (
    <div role="toolbar" aria-label="Review changes" aria-busy={busy || undefined} className="flex min-w-0 items-center gap-1">
      {group ? <span className="max-w-40 min-w-0 truncate pe-1">{group}</span> : null}
      <Step label="Previous change" disabled={busy || index <= 0} onClick={() => review.step(index - 1)}>
        <ChevronLeft />
      </Step>
      <span className="min-w-6 text-center text-foreground tabular-nums select-none">
        {index + 1}/{count}
      </span>
      <Step label="Next change" disabled={busy || index >= count - 1} onClick={() => review.step(index + 1)}>
        <ChevronRight />
      </Step>
      <Button variant="ghost" size="xs" disabled={busy || none} onClick={() => decide("reject")}>
        <BusyLabel busy={pending === "reject"} label="Reject" />
      </Button>
      <Button variant="secondary" size="xs" disabled={busy || none} onClick={() => decide("accept")}>
        <BusyLabel busy={pending === "accept"} label="Accept" />
      </Button>
    </div>
  );
}

function Step({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick(): void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick} />}>{children}</TooltipTrigger>
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
