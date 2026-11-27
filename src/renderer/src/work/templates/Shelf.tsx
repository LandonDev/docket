import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Template, TemplateKind } from "@shared/work/templates";
import { MoreHorizontal } from "../../chrome/icons";
import { RowsContextMenu, type MenuRow } from "../../chrome/menuRows";
import { useTruncated } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { ROW_HOLDS, ROW_OPEN } from "../../components/ui/press";
import { reveal } from "../../components/ui/reveal";
import { Spinner } from "../../components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import { KindGlyph } from "../files/KindGlyph";
import { KIND_WORD, type ShelfGroup } from "./model";

/**
 * The shelf's tiles (docs/agents/work-templates.md "The screens"), one part for
 * the Templates view and the "New from a Template" dialog: two groups, each a
 * 12px muted label over a grid of tiles. A tile is the file's picture (the
 * kind's glyph large on the stage, as a Files tile with no picture), then the
 * name on one 13px line, cut to it, the whole name the press's tip while it is cut. It aligns to the grid's edge (6px of padding
 * against a -6px margin), washes 5% on hover and steps to 12% at once while
 * pressed, as every row with its open control laid over it does (`ROW_HOLDS`),
 * never scaling, and draws the ring inside on focus; the plate's glyph turns to a
 * spinner only when a make takes over `SPIN_AFTER_MS`. Arrows walk the tiles,
 * Return makes. On the page a tile also has its menu: a right-click, or the ⋯
 * that shows on hover and on focus, takes no pointer until then, and stays while
 * its menu is open.
 */

/** A make shorter than this shows no spinner: the tile only presses. */
export const SPIN_AFTER_MS = 150;


/**
 * The picture area of a template, as a Files tile draws a file with no picture
 * of its own (docs/DESIGN.md "The Files place"): the stage, the kind's glyph
 * large in its tint in the middle, until Files' thumbnails land and take its
 * place. While a make waits past `SPIN_AFTER_MS` the spinner stands where the
 * glyph was. The name's line under it carries no glyph: the kind is said once.
 */
export function Plate({ kind, spin = false }: { kind: TemplateKind; spin?: boolean }) {
  return (
    <span data-plate={kind} aria-hidden className="grid aspect-[4/3] w-full place-items-center overflow-hidden rounded-md bg-(--stage) outline-1 -outline-offset-1 outline-image-outline">
      {spin ? <Spinner aria-hidden className="size-4 text-muted-foreground" /> : <KindGlyph kind={kind} className="size-10 shrink-0" />}
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
  disabled,
  menu,
  held,
  onPress,
  onFocus,
  onMore,
}: {
  template: Template;
  making: boolean;
  focusable: boolean;
  disabled: boolean;
  menu: boolean;
  /** Its menu is open: the ⋯ stays shown. */
  held: boolean;
  onPress: () => void;
  onFocus: () => void;
  onMore: (button: HTMLElement) => void;
}) {
  const spin = useLate(making, SPIN_AFTER_MS);
  // The caption is cut to one line; while it is cut, the whole name is the press's tip.
  const { ref: caption, cut } = useTruncated(template.name);
  const press = (
    <Button
      variant="ghost"
      data-tile-open=""
      data-row-open=""
      aria-label={template.name}
      // The kind, for someone who cannot see the glyph or its tint; the name stays the label.
      aria-description={KIND_WORD[template.kind]}
      aria-busy={making || undefined}
      disabled={disabled}
      tabIndex={focusable ? 0 : -1}
      onFocus={onFocus}
      onClick={onPress}
      className={ROW_OPEN}
    />
  );
  return (
    <div
      data-menu-id={template.id}
      data-tile={template.id}
      // A row whose open control lies over it (README, `ROW_HOLDS`): /5 on hover, /12 at once while pressed, nothing scales.
      // While its menu is open the tile keeps its hover wash, as a rail row does, so the menu stays tied to it.
      className={cn(ROW_HOLDS, "group/item -m-1.5 flex min-w-0 flex-col gap-1.5 rounded-xl p-1.5", held && "bg-foreground/5")}
    >
      {/* The tile's press, laid over the whole tile so its ring is the tile's edge, inside. */}
      {cut ? (
        <Tooltip>
          <TooltipTrigger render={press} />
          <TooltipContent>{template.name}</TooltipContent>
        </Tooltip>
      ) : (
        press
      )}
      <span className="pointer-events-none relative flex min-w-0 flex-col gap-1.5">
        {/* The kind's glyph in its tint, on the plate, drawn by the one part that draws it (docs/DESIGN.md "File kind
            tints": a template's tile is a file's tile, and only its glyph takes the colour). The wait is no kind: muted. */}
        <Plate kind={template.kind} spin={spin} />
        <span className="flex h-5 min-w-0 items-center text-[13px] leading-5 text-foreground">
          <span ref={caption} data-tile-name="" className="min-w-0 truncate">
            {template.name}
          </span>
        </span>
      </span>
      {menu ? (
        // Over the plate: no pointer until it shows, and shown while its menu is open.
        // On the plate's own ground (the stage), so it reads as part of the plate.
        <span data-tile-more="" className={cn("absolute top-3 right-3 rounded-md bg-(--stage)", held ? "pointer-events-auto opacity-100" : reveal("item", { row: true, overlay: true }))}>
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
  focusId,
  disabled = false,
}: {
  groups: readonly ShelfGroup[];
  layout: ShelfLayout;
  /** The tile that takes the tab stop first (the one Back returns to); the first tile when absent. */
  focusId?: string | null;
  disabled?: boolean;
  /** The template a make is waiting on, or null. */
  making: string | null;
  onPress: (template: Template) => void;
  /** A tile's menu rows (the page); absent, tiles have none (the dialog). */
  menuFor?: (template: Template) => MenuRow[];
  onMenu?: (pick: string, template: Template) => void;
}) {
  const all = groups.flatMap((g) => g.templates);
  const [active, setActive] = useState<string | null>(focusId ?? null);
  const [held, setHeld] = useState<string | null>(null);
  const current = all.some((t) => t.id === active) ? active : (all[0]?.id ?? null);
  const root = useRef<HTMLDivElement | null>(null);
  const openMenu = useRef<((at: { x: number; y: number; id: string | null }) => void) | null>(null);
  const byId = (id: string | null) => all.find((t) => t.id === id) ?? null;

  const walk = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !(event.target instanceof HTMLElement) || !event.target.matches("[data-tile-open]")) return;
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
                disabled={disabled}
                menu={!disabled && !!menuFor}
                held={held === t.id}
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
        if (disabled) return null;
        const t = byId(id);
        return t ? menuFor(t) : null;
      }}
      onPick={(pick, id) => {
        if (disabled) return;
        const t = byId(id);
        if (t) onMenu(pick, t);
      }}
      openRef={openMenu}
      onOpenChange={(open, id) => setHeld(open ? id : null)}
    >
      {body}
    </RowsContextMenu>
  );
}

const SAMPLE_NAMES = ["Crew memo", "Game report", "Season log", "Meeting notes", "Budget", "Pitch deck", "Weekly update", "Run of show"];
const SAMPLE_KINDS: readonly TemplateKind[] = ["document", "document", "sheet", "document", "sheet", "deck", "document", "deck"];
const NO_PRESS = (): void => undefined;

/** One group of `count` tiles, as the shelf draws them while it loads: names of a name's length, no clock, no host. */
export function sampleShelf(count: number): ShelfGroup[] {
  const templates = Array.from({ length: count }, (_, i): Template => {
    const name = SAMPLE_NAMES[i % SAMPLE_NAMES.length]!;
    return { id: `sample:${i}`, name, kind: SAMPLE_KINDS[i % SAMPLE_KINDS.length]!, form: "docx", where: "job", fields: [], source: { at: "file", host: "sample", path: `sample:${i}` } };
  });
  return [{ key: "job", label: "This job", templates }];
}

/** The shelf on its way: the shelf itself, drawn at rest from `sampleShelf`, as a region's bones. */
export function ShelfSample({ layout, count = 6 }: { layout: ShelfLayout; count?: number }) {
  return <Shelf groups={sampleShelf(count)} layout={layout} making={null} onPress={NO_PRESS} />;
}
