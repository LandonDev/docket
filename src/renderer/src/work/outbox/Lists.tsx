import { memo, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { ItemButton } from "../../components/ui/item";
import { reveal, yields } from "../../components/ui/reveal";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { ChevronDown, Outbox } from "../../chrome/icons";
import { storeTitleOf } from "../../lib/threadMentions";
import { requestKey, requestName, type HostRequest } from "./requests";
import { heldWhen } from "./when";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { cn } from "../../lib/cn";
import { clockTime } from "../../lib/duration";
import { KindGlyph, rowWords } from "./parts";
import type { HostItem } from "./store";
import { doneLine, decidedAt, FOLD_AT, FOLD_SHOWS, itemKey, rowSide, tickable, type Section } from "./waiting";

/**
 * Waiting and Done as the list pane draws them (docs/DESIGN.md "The Outbox"):
 * one-line 32px rows under small headings, one tab stop for the whole list
 * (the picked row, or the one focused last), ↑ and ↓ (J and K) handled by the
 * page, which moves the pick and the focus together. Nothing here moves on a
 * key: a list stepped through tens of times a day has no motion.
 */

/** A row's key on the element, for the page's roving focus. */
export const ROW_ATTR = "data-outbox-row";

/** 12px between two groups, none over the first: on the section, where `first:` can tell them apart. */
const GROUP = "mt-3 first:mt-0";

/** A small heading over a section or a thread's group. */
function Heading({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("group/item flex h-7 min-w-0 items-center gap-2 pe-1 ps-2 text-xs leading-4", className)}>{children}</div>;
}

/** One row: the glyph column, the act, what it is about (it gives way first), one trailing word. */
function Row({
  rowKey,
  stop,
  current,
  lead,
  tick,
  act,
  about,
  side,
  strong = false,
  snippet = false,
  onPick,
}: {
  rowKey: string;
  stop: boolean;
  current: boolean;
  lead: ReactNode;
  tick?: ReactNode;
  act: string;
  about: string | null;
  side: string;
  strong?: boolean;
  /** rows that share this act: what it is about is what tells them apart, so it keeps its room before the time */
  snippet?: boolean;
  onPick: () => void;
}) {
  return (
    <li className="group/row @container/row relative">
      <ItemButton
        {...{ [ROW_ATTR]: rowKey }}
        tabIndex={stop ? 0 : -1}
        aria-current={current ? "true" : undefined}
        onClick={onPick}
        className={cn("h-8 flex-nowrap gap-2 rounded-md py-0 pe-2 ps-7 text-left text-[13px] leading-5 transition-none", current ? "bg-muted" : "hover:bg-foreground/5")}
      >
        <span className={cn("min-w-0 shrink truncate", snippet && "max-w-[45%]")}>{act}</span>
        {about ? (
          <span className={cn("min-w-0 flex-1 truncate text-muted-foreground", snippet ? "shrink" : "shrink-[100] @max-[40rem]/outbox:hidden")}>{about}</span>
        ) : null}
        {/* Its own column at the row's end whether or not what it is about shows; on a very narrow row it gives way first, so the act is read. */}
        <span className={cn("ms-auto shrink-0 text-xs tabular-nums @max-[15rem]/row:hidden", snippet && "@max-[30rem]/row:hidden", strong ? "text-foreground" : "text-muted-foreground")}>{side}</span>
      </ItemButton>
      {/* The glyph column: the kind's glyph, which gives way to the tick on hover, and to every tick while any row is ticked. */}
      <span className="pointer-events-none absolute start-2 top-2 grid size-4 place-items-center">{lead}</span>
      {tick}
    </li>
  );
}

/** While the Outbox first loads: the one-line rows' bones, each as tall as the row that takes its place. */
export function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading the Outbox" aria-busy className="flex select-none flex-col p-1">
      <span className="flex h-7 items-center px-2">
        <Skeleton className="h-2.5 w-24" />
      </span>
      {[62, 48, 70, 54, 40, 66, 50].map((w) => (
        <span key={w} className="flex h-8 items-center gap-2 px-2">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className="h-3" style={{ width: `${w}%` }} />
        </span>
      ))}
    </div>
  );
}

export function WaitingList({
  sections,
  requests = [],
  onPickRequest,
  current,
  stop,
  ticked,
  expanded,
  now,
  onPick,
  onTick,
  onSelectGroup,
  onExpand,
}: {
  sections: Section<HostItem>[];
  /** Asked in threads: one row per open request, before every section; its items are not listed again. */
  requests?: HostRequest[];
  onPickRequest?: (request: HostRequest) => void;
  /** The picked row, highlighted; null while rows are ticked (the detail is their summary). */
  current: string | null;
  /** The row that holds the list's one tab stop. */
  stop: string | null;
  ticked: ReadonlySet<string>;
  /** Groups opened past their fold. */
  expanded: ReadonlySet<string>;
  now: number;
  onPick: (item: HostItem) => void;
  onTick: (item: HostItem, on: boolean, range: boolean) => void;
  onSelectGroup: (items: HostItem[]) => void;
  onExpand: (group: string) => void;
}) {
  const ticking = ticked.size > 0;
  return (
    <div className="flex flex-col p-1" data-outbox-waiting data-ticking={ticking ? "" : undefined}>
      {requests.length ? (
        <section aria-label="Asked in threads" data-outbox-section="asked" className={GROUP}>
          <Heading className="ps-2 font-medium text-muted-foreground">Asked in threads</Heading>
          <ul className="flex flex-col gap-0.5">
            {requests.map((request) => {
              const key = requestKey(request);
              return (
                <Row
                  key={key}
                  rowKey={key}
                  stop={stop === key}
                  current={current === key}
                  act={requestName(request)}
                  about={storeTitleOf(request.sessionId) ?? null}
                  side={heldWhen(request.createdAt, now)}
                  onPick={() => onPickRequest?.(request)}
                  lead={<Outbox className="size-3.5 text-muted-foreground" />}
                />
              );
            })}
          </ul>
        </section>
      ) : null}
      {sections.map((section) => {
        const fold = section.items.length > FOLD_AT && !expanded.has(section.key);
        const shown = fold ? section.items.slice(0, FOLD_SHOWS) : section.items;
        const tickables = section.items.filter(tickable);
        // Rows of one act ("Echo with League" three times) are told apart by what they are about.
        const actCount = new Map<string, number>();
        for (const it of section.items) actCount.set(rowWords(it).act, (actCount.get(rowWords(it).act) ?? 0) + 1);
        const label = section.kind === "thread" ? `${section.title}${section.job ? `, ${section.job}` : ""}` : section.title;
        return (
          <section key={section.key} aria-label={label} data-outbox-section={section.kind} className={GROUP}>
            {section.kind === "thread" ? (
              <Heading>
                <SectorDot sector={section.sector} className="size-4 shrink-0" />
                <span className="min-w-0 shrink truncate font-medium">{section.title}</span>
                {section.job ? <span className="min-w-0 flex-1 shrink-[1000] truncate text-muted-foreground">{section.job}</span> : <span className="flex-1" />}
                {tickables.length > 1 ? (
                  <span className={reveal("item", { row: true })}>
                    <Button variant="ghost" size="xs" tabIndex={-1} onClick={() => onSelectGroup(tickables)}>
                      Select {tickables.length}
                    </Button>
                  </span>
                ) : null}
              </Heading>
            ) : (
              <Heading className="ps-2 font-medium text-muted-foreground">{section.title}</Heading>
            )}
            <ul className="flex flex-col gap-0.5">
              {shown.map((item) => {
                const key = itemKey(item);
                const { act, about } = rowWords(item);
                const side = rowSide(item, section.kind, now);
                return (
                  <HeldRow key={key} item={item} stop={stop === key} current={current === key} ticking={ticking} ticked={ticked.has(key)} side={side.text} strong={side.strong} snippet={(actCount.get(act) ?? 0) > 1 && !!about} onPick={onPick} onTick={onTick} />
                );
              })}
              {fold ? (
                <li>
                  <ItemButton
                    {...{ [ROW_ATTR]: `more:${section.key}` }}
                    tabIndex={stop === `more:${section.key}` ? 0 : -1}
                    onClick={() => onExpand(section.key)}
                    className="h-8 flex-nowrap gap-2 rounded-md py-0 pe-2 ps-2 text-left text-[13px] leading-5 text-muted-foreground transition-none hover:bg-foreground/5"
                  >
                    <span className="grid size-4 shrink-0 place-items-center">
                      <ChevronDown className="size-3.5" />
                    </span>
                    {section.items.length - FOLD_SHOWS} more
                  </ItemButton>
                </li>
              ) : null}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * One waiting row. Memoised on the item, which the store keeps as the same object while nothing it shows moved, and on
 * plain values: a read that changed one item draws that row alone (the perf pass's M2).
 */
const HeldRow = memo(function HeldRow({
  item,
  stop,
  current,
  ticking,
  ticked,
  side,
  strong,
  snippet,
  onPick,
  onTick,
}: {
  item: HostItem;
  stop: boolean;
  current: boolean;
  ticking: boolean;
  ticked: boolean;
  side: string;
  strong: boolean;
  /** Master's: the row shows its snippet when another row of the section says the same act. */
  snippet: boolean;
  onPick: (item: HostItem) => void;
  onTick: (item: HostItem, on: boolean, range: boolean) => void;
}) {
  const key = itemKey(item);
  const { act, about } = rowWords(item);
  const can = tickable(item);
  // While rows are ticked every row shows its box, but a failed one keeps its red mark until it is ticked itself (the box
  // under the pointer, as before any tick): the list still says what failed.
  const boxShown = ticking && (ticked || item.state !== "failed");
  const glyph =
    item.state === "failed" ? (
      <StatusMark state="failed" word={false} />
    ) : item.state === "sending" && item.scheduledFor == null ? (
      <StatusMark state="working" word={false} still />
    ) : (
      <KindGlyph kind={item.kind} />
    );
  return (
    <Row
      rowKey={key}
      stop={stop}
      current={current}
      act={act}
      about={about}
      side={side}
      strong={strong}
      snippet={snippet}
      onPick={() => onPick(item)}
      lead={<span className={cn("grid size-4 place-items-center", can && (boxShown ? "opacity-0" : yields("row")))}>{glyph}</span>}
      tick={
        can ? (
          <span className={cn("absolute start-2 top-2 grid size-4 place-items-center", !boxShown && reveal("row", { row: true, overlay: true }))}>
            <Checkbox
              tabIndex={-1}
              aria-label={`Tick ${act}`}
              checked={ticked}
              onClick={(e) => {
                // Shift-click ticks the range from the last tick; the checkbox's own change is the plain one.
                if (e.shiftKey) {
                  e.preventDefault();
                  onTick(item, true, true);
                }
              }}
              onCheckedChange={(on) => onTick(item, on, false)}
            />
          </span>
        ) : undefined
      }
    />
  );
});

/** Done by day, newest first: what went, what he discarded, what went out of date that he put away. */
export function DoneList({ days, current, stop, now, onPick }: { days: { label: string; items: HostItem[] }[]; current: string | null; stop: string | null; now: number; onPick: (item: HostItem) => void }) {
  return (
    <div className="flex flex-col p-1" data-outbox-done>
      {days.map((day) => (
        <section key={day.label} aria-label={day.label} className={GROUP}>
          <Heading className="ps-2 font-medium text-muted-foreground">{day.label}</Heading>
          <ul className="flex flex-col gap-0.5">
            {day.items.map((item) => {
              const key = itemKey(item);
              return <DoneRow key={key} item={item} stop={stop === key} current={current === key} now={now} onPick={onPick} />;
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One Done row, memoised as a waiting row is. */
const DoneRow = memo(function DoneRow({ item, stop, current, now, onPick }: { item: HostItem; stop: boolean; current: boolean; now: number; onPick: (item: HostItem) => void }) {
  const { act, about, outcome } = doneLine(item, rowWords(item), now);
  const queued = item.state === "sent" && item.lifeos === "queued";
  return (
    <Row
      rowKey={itemKey(item)}
      stop={stop}
      current={current}
      act={act}
      about={about}
      side={outcome ?? clockTime(decidedAt(item))}
      onPick={() => onPick(item)}
      lead={queued ? <StatusMark state="queued" word={false} /> : <KindGlyph kind={item.kind} />}
    />
  );
});
