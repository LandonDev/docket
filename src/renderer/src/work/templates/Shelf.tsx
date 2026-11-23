import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Template, TemplateKind } from "@shared/work/templates";
import { MoreHorizontal } from "../../chrome/icons";
import { RowsContextMenu, type MenuRow } from "../../chrome/menuRows";
import { Button } from "../../components/ui/button";
import { reveal } from "../../components/ui/reveal";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { cn } from "../../lib/cn";
import { Doc, Slides, Table } from "../icons";
import type { ShelfGroup } from "./model";

/**
 * The shelf's tiles (docs/agents/work-templates.md "The screens"), one part for
 * the Templates view and the "New from a template" dialog: two groups, each a
 * 12px muted label over a grid of tiles. A tile is the file's picture, then the
 * kind's glyph and the name on one 13px line. It aligns to the grid's edge (6px
 * of padding against a -6px margin), washes 5% on hover, draws the ring inside
 * on focus and takes scale(0.97) while pressed; the glyph turns to a spinner
 * only when a make takes over `SPIN_AFTER_MS`. Arrows walk the tiles, Return
 * makes. On the page a tile also has its menu: a right-click, or the ⋯ that
 * shows on hover and on focus.
 */

/** A make shorter than this shows no spinner: the tile only presses. */
export const SPIN_AFTER_MS = 150;

const KIND_GLYPH: Record<TemplateKind, typeof Doc> = { document: Doc, sheet: Table, deck: Slides };

/** The widths of a drawn page's lines, as shares of the line: enough of a rhythm to read as writing. */
const LINES = ["w-[92%]", "w-[78%]", "w-[86%]", "w-[58%]"] as const;
const MORE_LINES = ["w-[88%]", "w-[70%]"] as const;
/** A drawn sheet's rows: the bar in each cell, as a share of the cell. The first row is the head. */
const CELLS = [
  ["w-[64%]", "w-[52%]", "w-[58%]", "w-[46%]"],
  ["w-[72%]", "w-[40%]", "w-[62%]", "w-[50%]"],
  ["w-[56%]", "w-[66%]", "w-[44%]", "w-[60%]"],
  ["w-[68%]", "w-[48%]", "w-[70%]", "w-[42%]"],
  ["w-[60%]", "w-[58%]", "w-[52%]", "w-[64%]"],
  ["w-[74%]", "w-[44%]", "w-[60%]", "w-[54%]"],
] as const;

/**
 * The picture area of a template: a small drawing of what its kind is, in the
 * tile's own measure (container units), until Files' thumbnails land and take
 * its place. A document is a heading and lines of writing, a sheet a grid with
 * a head row, a deck a title slide. It says the kind at a glance and shows no
 * glyph: the glyph is on the name's line, once.
 */
export function Plate({ kind }: { kind: TemplateKind }) {
  return (
    <span data-plate={kind} aria-hidden className="@container relative block aspect-[4/3] w-full overflow-hidden rounded-md bg-card outline-1 -outline-offset-1 outline-image-outline">
      {kind === "document" ? (
        <span className="absolute inset-0 flex flex-col gap-[4.5cqw] px-[11cqw] pt-[11cqw]">
          <span className="mb-[1cqw] block h-[3.6cqw] w-[46%] flex-none rounded-[2px] bg-foreground/40" />
          {LINES.map((w) => (
            <span key={w} className={cn("block h-[2.4cqw] flex-none rounded-[2px] bg-foreground/15", w)} />
          ))}
          <span className="mt-[2cqw] block h-[3cqw] w-[30%] flex-none rounded-[2px] bg-foreground/40" />
          {MORE_LINES.map((w) => (
            <span key={w} className={cn("block h-[2.4cqw] flex-none rounded-[2px] bg-foreground/15", w)} />
          ))}
        </span>
      ) : kind === "sheet" ? (
        <span className="absolute top-[9cqw] right-0 bottom-0 left-[9cqw] flex flex-col border-t border-l border-border">
          {CELLS.map((row, r) => (
            <span key={r} className="grid h-[11cqw] flex-none grid-cols-[2fr_1fr_1fr_1fr] border-b border-border">
              {row.map((w, c) => (
                <span key={c} className="flex items-center border-r border-border px-[12%]">
                  <span className={cn("block h-[2.4cqw] rounded-[2px]", r === 0 ? "bg-foreground/40" : "bg-foreground/15", w)} />
                </span>
              ))}
            </span>
          ))}
        </span>
      ) : (
        <span className="absolute inset-0 flex flex-col justify-center gap-[3cqw] px-[11cqw]">
          <span className="mb-[1cqw] block h-[1.4cqw] w-[12cqw] flex-none rounded-[1px] bg-foreground/40" />
          <span className="block h-[5.2cqw] w-[62%] flex-none rounded-[2px] bg-foreground/40" />
          <span className="block h-[2.6cqw] w-[40%] flex-none rounded-[2px] bg-foreground/15" />
        </span>
      )}
    </span>
  );
}

/** True once `on` has held for `ms`; false again as soon as it stops. */
function useLate(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) {
      setLate(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on && late;
}

/** The grid: auto-filled 148px tiles on the page, three columns (two under 640px) in the dialog. */
const GRID = {
  page: "grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-x-3 gap-y-4",
  dialog: "grid grid-cols-3 gap-x-3 gap-y-4 max-sm:grid-cols-2",
} as const;

export type ShelfLayout = keyof typeof GRID;

function Tile({
  template,
  making,
  focusable,
  menu,
  onPress,
  onFocus,
  onMore,
}: {
  template: Template;
  making: boolean;
  focusable: boolean;
  menu: boolean;
  onPress: () => void;
  onFocus: () => void;
  onMore: (button: HTMLElement) => void;
}) {
  const spin = useLate(making, SPIN_AFTER_MS);
  const Glyph = KIND_GLYPH[template.kind];
  return (
    <div
      data-menu-id={template.id}
      data-tile={template.id}
      className="group/item relative -m-1.5 flex min-w-0 flex-col gap-1.5 rounded-xl p-1.5 [transition:background-color_var(--dur-hover)_var(--ease-out),scale_var(--dur-fast)_var(--ease-out)] hover:bg-foreground/5 has-[>[data-tile-open]:active]:scale-[0.97] motion-reduce:transition-none"
    >
      {/* The tile's press, laid over the whole tile so its ring is the tile's edge, inside. */}
      <button
        type="button"
        data-tile-open
        aria-label={template.name}
        aria-busy={making || undefined}
        tabIndex={focusable ? 0 : -1}
        onFocus={onFocus}
        onClick={onPress}
        className="absolute inset-0 rounded-[inherit]"
      />
      <span className="pointer-events-none relative flex min-w-0 flex-col gap-1.5">
        <Plate kind={template.kind} />
        <span className="flex h-5 min-w-0 items-center gap-1.5 text-[13px] leading-5 text-foreground">
          {spin ? <Spinner aria-hidden className="size-3.5" /> : <Glyph aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 truncate">{template.name}</span>
        </span>
      </span>
      {menu ? (
        <span className={cn("absolute top-3 right-3", reveal("item", { row: true }))}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`More for ${template.name}`}
            tabIndex={focusable ? 0 : -1}
            onFocus={onFocus}
            onClick={(event) => onMore(event.currentTarget)}
          >
            <MoreHorizontal />
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/** The tile an arrow lands on: the next or the previous in reading order, or the nearest one a row above or below. */
export function nextTile(tiles: readonly HTMLElement[], from: number, key: string): number {
  if (key === "Home") return 0;
  if (key === "End") return tiles.length - 1;
  if (key === "ArrowRight") return Math.min(tiles.length - 1, from + 1);
  if (key === "ArrowLeft") return Math.max(0, from - 1);
  const rects = tiles.map((t) => t.getBoundingClientRect());
  const here = rects[from]!;
  const down = key === "ArrowDown";
  const rows = rects.filter((r) => (down ? r.top > here.top + 1 : r.top < here.top - 1)).map((r) => r.top);
  if (rows.length === 0) return from;
  const row = down ? Math.min(...rows) : Math.max(...rows);
  const middle = here.left + here.width / 2;
  let best = from;
  let gap = Infinity;
  rects.forEach((r, i) => {
    if (Math.abs(r.top - row) > 1) return;
    const d = Math.abs(r.left + r.width / 2 - middle);
    if (d < gap) {
      gap = d;
      best = i;
    }
  });
  return best;
}

const WALK = new Set(["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]);

export function Shelf({
  groups,
  layout,
  making,
  onPress,
  menuFor,
  onMenu,
}: {
  groups: readonly ShelfGroup[];
  layout: ShelfLayout;
  /** The template a make is waiting on, or null. */
  making: string | null;
  onPress: (template: Template) => void;
  /** A tile's menu rows (the page); absent, tiles have none (the dialog). */
  menuFor?: (template: Template) => MenuRow[];
  onMenu?: (pick: string, template: Template) => void;
}) {
  const all = groups.flatMap((g) => g.templates);
  const [active, setActive] = useState<string | null>(null);
  const current = all.some((t) => t.id === active) ? active : (all[0]?.id ?? null);
  const root = useRef<HTMLDivElement | null>(null);
  const openMenu = useRef<((at: { x: number; y: number; id: string | null }) => void) | null>(null);
  const byId = (id: string | null) => all.find((t) => t.id === id) ?? null;

  const walk = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches("[data-tile-open]")) return;
    // Return makes, once: the button's own click on Enter is held back.
    if (event.key === "Enter") {
      event.preventDefault();
      const t = byId(event.target.closest<HTMLElement>("[data-tile]")?.dataset.tile ?? null);
      if (t) onPress(t);
      return;
    }
    if (!WALK.has(event.key)) return;
    const tiles = [...(root.current?.querySelectorAll<HTMLElement>("[data-tile-open]") ?? [])];
    const from = tiles.indexOf(event.target);
    if (from < 0) return;
    event.preventDefault();
    tiles[nextTile(tiles, from, event.key)]?.focus();
  };

  const body: ReactNode = (
    <div ref={root} onKeyDown={walk} className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label} className="flex min-w-0 flex-col gap-2">
          <h2 className="min-w-0 truncate text-xs leading-4 font-medium text-muted-foreground">{group.label}</h2>
          <div className={GRID[layout]}>
            {group.templates.map((t) => (
              <Tile
                key={t.id}
                template={t}
                making={making === t.id}
                focusable={t.id === current}
                menu={!!menuFor}
                onPress={() => onPress(t)}
                onFocus={() => setActive(t.id)}
                onMore={(button) => {
                  const box = button.getBoundingClientRect();
                  openMenu.current?.({ x: box.left, y: box.bottom + 4, id: t.id });
                }}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
  if (!menuFor || !onMenu) return body;
  return (
    <RowsContextMenu
      label="Template actions"
      lazyMount
      rowsFor={(id) => {
        const t = byId(id);
        return t ? menuFor(t) : null;
      }}
      onPick={(pick, id) => {
        const t = byId(id);
        if (t) onMenu(pick, t);
      }}
      openRef={openMenu}
    >
      {body}
    </RowsContextMenu>
  );
}

/** The shelf on its way: still tiles in the grid's shape, one group of them. */
export function ShelfSkeleton({ layout, count = 6 }: { layout: ShelfLayout; count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading templates" className="flex flex-col gap-2">
      <Skeleton className="h-4 w-24" />
      <div className={GRID[layout]}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="flex min-w-0 flex-col gap-1.5">
            <Skeleton className="aspect-[4/3] w-full rounded-md" />
            <span className="flex h-5 items-center">
              <Skeleton className="h-3 rounded-sm" style={{ width: `${[64, 48, 72, 56, 40, 60][i % 6]}%` }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
