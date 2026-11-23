import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DeckSlide, SlideChange, SlideOp } from "@shared/contract-work-slides";
import { FormatSelectButton, RowMenu, RowMenuItem, RowMenuRadioGroup, RowMenuRadioItem } from "work-kit/format";
import { ConfirmDialog } from "../../../chrome/ConfirmDialog";
import { GripVertical, Plus, X } from "../../../chrome/icons";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { reveal, yields } from "../../../components/ui/reveal";
import { useSortable } from "../../../hooks/useSortable";
import { cn } from "../../../lib/cn";
import { altOnly, bareKey } from "../../../lib/keys";
import { shapeLabel } from "../geometry";
import { addable, AFTER_FIRST, buildsHold, comesOf, KINDS, kindName, moved, parseSeconds, played, PUSH_SIDES, secondsText, transitionOp, type Comes, type Kind } from "./animation";
import type { HandSession } from "./session";
import { NumberField, Row, Section } from "./sheetParts";

/**
 * The Format sheet's Animate tab (docs/DESIGN.md "The slide editor"): how the
 * slide on the stage comes in a show, and the shapes that appear on a press,
 * in order. Each change is one edit by his hand, as every control of the
 * sheet. What only PowerPoint can set reads "Edit in PowerPoint"; on a slide
 * a suggestion changes it is the proposed value, read only.
 */

/** A shape of the slide by the words the stage reads to a screen reader. */
export const buildLabel = (slide: DeckSlide, id: number): string => {
  const shape = slide.shapes.find((s) => s.id === id);
  return shape ? shapeLabel(shape) : "Shape";
};

/** A proposed value, in the added tint where the suggestion changes it (the stage's `Diff`). */
function Value({ tinted, children }: { tinted: boolean; children: ReactNode }) {
  return <span className={cn("min-w-0 truncate text-[13px] leading-5", tinted && "rounded-sm bg-(--add-bg)")}>{children}</span>;
}

export function Animate({ slide, session, edits }: { slide: DeckSlide; session: HandSession; edits: SlideChange["edits"] }) {
  const refusal = session.slideRefusal(slide);
  const locked = refusal !== null;
  const changed = (where: string): boolean => edits.some((e) => e.where === where);
  return (
    <>
      {refusal ? <p className="text-xs leading-4 text-muted-foreground">{refusal}</p> : null}
      <Transition slide={slide} locked={locked} tinted={changed("Transition")} onSet={(op) => void session.edit([op], "Couldn't change the transition")} />
      <Builds slide={slide} session={session} locked={locked} tinted={changed("Builds")} />
    </>
  );
}

function Transition({ slide, locked, tinted, onSet }: { slide: DeckSlide; locked: boolean; tinted: boolean; onSet(op: SlideOp): void }) {
  const c = comesOf(slide.transition);
  const known = played(c.kind);
  const side = PUSH_SIDES.find((s) => s.dir === c.dir)!.label;
  // Only None, Fade or Push replaces a transition this app does not play; its timing stays PowerPoint's until then.
  const set = (patch: Partial<Comes> & { kind?: Kind }): void => {
    const kind = patch.kind ?? (known ? (c.kind as Kind) : null);
    if (kind) onSet(transitionOp(slide.id, { ...c, ...patch, kind }));
  };
  if (locked) {
    const moves = [c.click ? "on click" : "", c.after !== null ? `after ${secondsText(c.after)}` : ""].filter(Boolean).join(", ");
    return (
      <Section label="Transition">
        <Row label="Effect">
          <Value tinted={tinted}>{kindName(c.kind)}</Value>
        </Row>
        {c.kind === "push" ? (
          <Row label="Direction">
            <Value tinted={tinted}>{side}</Value>
          </Row>
        ) : null}
        <Row label="Advance">
          <Value tinted={tinted}>{moves ? `${moves.charAt(0).toUpperCase()}${moves.slice(1)}` : "Never"}</Value>
        </Row>
      </Section>
    );
  }
  return (
    <Section label="Transition">
      <div className="flex flex-col gap-1">
        <Row label="Effect">
          <RowMenu
            label="Transition"
            width={128}
            trigger={
              <FormatSelectButton label="Transition" className="w-28">
                {kindName(c.kind)}
              </FormatSelectButton>
            }
          >
            <RowMenuRadioGroup value={known ? c.kind : ""} onValueChange={(v: string) => set({ kind: v as Kind })}>
              {KINDS.map((k) => (
                <RowMenuRadioItem key={k.value} value={k.value}>
                  {k.label}
                </RowMenuRadioItem>
              ))}
            </RowMenuRadioGroup>
          </RowMenu>
        </Row>
        {known ? null : <p className="text-xs leading-4 text-muted-foreground">Plays in PowerPoint; a cut here</p>}
      </div>
      {c.kind === "push" ? (
        <Row label="Direction">
          <RowMenu
            label="Direction"
            width={128}
            trigger={
              <FormatSelectButton label="Direction" className="w-28">
                {side}
              </FormatSelectButton>
            }
          >
            <RowMenuRadioGroup value={c.dir} onValueChange={(v: string) => set({ dir: v as Comes["dir"] })}>
              {PUSH_SIDES.map((s) => (
                <RowMenuRadioItem key={s.dir} value={s.dir}>
                  {s.label}
                </RowMenuRadioItem>
              ))}
            </RowMenuRadioGroup>
          </RowMenu>
        </Row>
      ) : null}
      <div className="flex min-h-7 items-center justify-between gap-3 text-[13px] leading-5">
        <label className="flex items-center gap-2">
          <Checkbox checked={c.click} disabled={!known} onCheckedChange={(on) => set({ click: on })} />
          On click
        </label>
      </div>
      <div className="flex min-h-7 items-center justify-between gap-3 text-[13px] leading-5">
        <label className="flex items-center gap-2">
          <Checkbox checked={c.after !== null} disabled={!known} onCheckedChange={(on) => set({ after: on ? AFTER_FIRST : null })} />
          After
        </label>
        {c.after !== null ? (
          <div className="w-28">
            <NumberField label="Seconds" value={secondsText(c.after)} read={parseSeconds} disabled={!known} onSet={(after) => set({ after })} />
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function Builds({ slide, session, locked, tinted }: { slide: DeckSlide; session: HandSession; locked: boolean; tinted: boolean }) {
  const hold = buildsHold(slide);
  const [asking, setAsking] = useState(false);
  if ("why" in hold) {
    return (
      <Section label="Builds">
        <div className="flex flex-col">
          <p className="text-[13px] leading-5">Edit in PowerPoint</p>
          <p className="text-xs leading-4 text-muted-foreground">{hold.why}</p>
        </div>
        {hold.replace && !locked ? (
          <Button variant="ghost" size="xs" className="-ms-2 self-start" onClick={() => setAsking(true)}>
            Remove animations…
          </Button>
        ) : null}
        {asking ? (
          <ConfirmDialog
            title="Remove this slide's animations?"
            body="Every effect on this slide goes, in PowerPoint too. Then you can set shapes to appear on click."
            confirmLabel="Remove"
            danger
            onCancel={() => setAsking(false)}
            onConfirm={async () => void (await session.editOrThrow([{ op: "builds", slide: slide.id, order: [], replace: true }]))}
            onDone={() => setAsking(false)}
          />
        ) : null}
      </Section>
    );
  }
  return locked ? (
    <Section label="Builds">
      {hold.order.length ? (
        <ol aria-label="Builds" className="flex flex-col">
          {hold.order.map((id, i) => (
            <li key={id} className="flex h-7 items-center gap-2">
              <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <Value tinted={tinted}>{buildLabel(slide, id)}</Value>
            </li>
          ))}
        </ol>
      ) : (
        <Value tinted={tinted}>None</Value>
      )}
    </Section>
  ) : (
    <BuildList slide={slide} order={hold.order} session={session} />
  );
}

/** The shapes that appear on a press, in order: dragged, or moved by ⌥↑ and ⌥↓; Delete takes one out. */
function BuildList({ slide, order: theirs, session }: { slide: DeckSlide; order: number[]; session: HandSession }) {
  // His change, shown at once until the deck comes back with it (or the edit fails).
  const key = theirs.join(",");
  const [held, setHeld] = useState<{ was: string; order: number[] } | null>(null);
  const order = held?.was === key ? held.order : theirs;
  const rows = useRef(new Map<number, HTMLElement>());
  const [focusOn, setFocusOn] = useState<number | null>(null);
  useEffect(() => {
    if (focusOn === null) return;
    rows.current.get(focusOn)?.focus();
    setFocusOn(null);
  }, [focusOn, order]);
  const send = (next: number[]): void => {
    if (next.join(",") === order.join(",")) return;
    setHeld({ was: key, order: next });
    void session.edit([{ op: "builds", slide: slide.id, order: next }], "Couldn't change the builds").then((view) => {
      if (!view) setHeld(null);
    });
  };
  const remove = (id: number): void => {
    const at = order.indexOf(id);
    const next = order.filter((x) => x !== id);
    if (rows.current.get(id)?.contains(document.activeElement)) setFocusOn(next[Math.min(at, next.length - 1)] ?? null);
    send(next);
  };
  const ids = order.map(String);
  const sortable = useSortable(ids, (next) => send(next.map(Number)), "y");
  const more = addable(slide, order);
  return (
    <Section label="Builds">
      {order.length ? (
        <ol aria-label="Builds" className="-mx-1 flex flex-col">
          {order.map((id, i) => {
            const label = buildLabel(slide, id);
            const dropping = sortable.toIndex === i && sortable.fromIndex !== null && sortable.toIndex !== sortable.fromIndex;
            return (
              <li
                key={id}
                ref={(el) => {
                  sortable.setItemRef(String(id), el);
                  if (el) rows.current.set(id, el);
                  else rows.current.delete(id);
                }}
                data-build={id}
                tabIndex={0}
                aria-label={`${i + 1}. ${label}`}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Delete"
                onPointerDown={(e) => sortable.onItemPointerDown(String(id), e)}
                onKeyDown={(e) => {
                  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && altOnly(e)) {
                    e.preventDefault();
                    send(moved(order, id, e.key === "ArrowUp" ? -1 : 1));
                  } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && bareKey(e)) {
                    e.preventDefault();
                    rows.current.get(order[i + (e.key === "ArrowUp" ? -1 : 1)])?.focus();
                  } else if ((e.key === "Delete" || e.key === "Backspace") && bareKey(e)) {
                    e.preventDefault();
                    remove(id);
                  }
                }}
                className={cn(
                  "group/row relative flex h-7 cursor-grab touch-none items-center gap-2 rounded-md px-1 select-none active:cursor-grabbing",
                  sortable.draggingId === String(id) && "z-10 bg-muted",
                )}
              >
                {dropping ? <span aria-hidden className={cn("pointer-events-none absolute inset-x-1 z-20 h-0.5 rounded-full bg-accent", sortable.toIndex! < sortable.fromIndex! ? "-top-px" : "-bottom-px")} /> : null}
                <span aria-hidden className="relative flex w-4 shrink-0 items-center justify-center">
                  <span className={cn("text-xs text-muted-foreground tabular-nums", yields("row"))}>{i + 1}</span>
                  <GripVertical className={cn("absolute size-3.5 text-muted-foreground", reveal("row", { row: true }))} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] leading-5">{label}</span>
                <span className={reveal("row", { row: true })}>
                  <Button variant="ghost" size="icon-xs" tabIndex={-1} aria-label={`Remove ${label}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => remove(id)}>
                    <X />
                  </Button>
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      <RowMenu
        label="Appear on click"
        width={224}
        trigger={
          <Button variant="ghost" size="xs" className="-ms-2 self-start" disabled={more.length === 0}>
            <Plus />
            Appear on click
          </Button>
        }
      >
        {more.map((s) => (
          <RowMenuItem key={s.id} onSelect={() => send([...order, s.id])}>
            {buildLabel(slide, s.id)}
          </RowMenuItem>
        ))}
      </RowMenu>
    </Section>
  );
}
