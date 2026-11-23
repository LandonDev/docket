import { useRef, useState, type KeyboardEvent } from "react";
import type { DeckSlide, DeckView } from "@shared/contract-work-slides";
import { FormatSelectButton, RowPopover, StyleSelect, useLayerOpen } from "work-kit/format";
import type { PdfDoc, PdfEngine } from "../../pdf/engine";
import { layoutsPicOf, useRender, type DeckHost } from "../deck";
import { Picture } from "../Picture";
import { layoutsFor } from "./add";

/**
 * The slide's layout, in the row's Style place (docs/DESIGN.md "The slide
 * editor"): a 148px quiet select whose layer is the deck's layouts that this
 * slide can take, each as a 96px picture of the layout (`DeckView.layoutsPic`,
 * one page a layout) with its name, three across. A layout whose
 * placeholders do not hold the slide's is not offered. With no picture of the
 * layouts it is the names alone, as any style select is.
 */

const TILE = 96;
const COLUMNS = 3;

export function LayoutSelect({
  view,
  slide,
  host,
  engine,
  width,
  disabled,
  onPick,
}: {
  view: DeckView;
  slide: DeckSlide | undefined;
  host: DeckHost;
  engine: PdfEngine | undefined;
  /** 148px, or 132 on a canvas under 420px */
  width: number;
  disabled: boolean;
  onPick(layout: string): void;
}) {
  const options = layoutsFor(view, slide);
  const value = slide?.layout ?? null;
  const pictured = !!layoutsPicOf(view) && !!view.layouts?.length;
  if (!pictured || !engine) {
    return (
      <StyleSelect
        label="Layout"
        value={value}
        mixed={value ?? ""}
        width={width}
        options={options.map((l) => ({ id: l.name, label: l.name }))}
        disabled={disabled || options.length === 0}
        onChange={(name) => name !== value && onPick(name)}
      />
    );
  }
  return <LayoutPictures view={view} options={options} value={value} host={host} engine={engine} width={width} disabled={disabled} onPick={onPick} />;
}

function LayoutPictures({
  view,
  options,
  value,
  host,
  engine,
  width,
  disabled,
  onPick,
}: {
  view: DeckView;
  options: ReturnType<typeof layoutsFor>;
  value: string | null;
  host: DeckHost;
  engine: PdfEngine;
  width: number;
  disabled: boolean;
  onPick(layout: string): void;
}) {
  const state = useLayerOpen();
  const [open, setOpen] = state;
  // The layouts' picture is read the first time the layer opens, and kept while the row lives.
  const [wanted, setWanted] = useState(false);
  if (open && !wanted) setWanted(true);
  const pic = useRender(host, "layouts", wanted ? (layoutsPicOf(view) ?? null) : null, engine);
  return (
    <RowPopover
      label="Layout"
      width={COLUMNS * 102 + (COLUMNS - 1) * 8 + 24}
      state={state}
      className="p-3"
      tip={{ label: "Layout" }}
      trigger={
        <FormatSelectButton label="Layout" disabled={disabled || options.length === 0} style={{ width }}>
          {value ?? ""}
        </FormatSelectButton>
      }
    >
      <LayoutGrid
        view={view}
        options={options}
        value={value}
        doc={pic.doc}
        onPick={(name) => {
          setOpen(false);
          if (name !== value) onPick(name);
        }}
      />
    </RowPopover>
  );
}

/** The layouts a slide can take, three across, each as its picture over its name; the arrows move four ways. */
export function LayoutGrid({ view, options, value, doc, onPick }: { view: DeckView; options: ReturnType<typeof layoutsFor>; value: string | null; doc: PdfDoc | null; onPick(name: string): void }) {
  const grid = useRef<HTMLDivElement>(null);
  const pageOf = (name: string): number => (view.layouts ?? []).findIndex((l) => l.name === name) + 1;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[event.key];
    const tiles = [...(grid.current?.querySelectorAll<HTMLElement>("[data-layout]") ?? [])];
    const at = tiles.indexOf(event.target as HTMLElement);
    if (!step || at < 0) return;
    event.preventDefault();
    tiles[Math.max(0, Math.min(tiles.length - 1, at + step))]?.focus();
  };
  return (
    <div ref={grid} role="listbox" aria-label="Layouts" onKeyDown={onKeyDown} className="grid grid-cols-[repeat(3,102px)] gap-x-2 gap-y-3">
      {options.map((layout) => {
        const on = layout.name === value;
        return (
          <button
            key={layout.name}
            type="button"
            role="option"
            aria-selected={on}
            data-layout={layout.name}
            tabIndex={on || (!value && layout === options[0]) ? 0 : -1}
            onClick={() => onPick(layout.name)}
            className="group/lo flex flex-col gap-1 rounded-md text-start"
          >
            <span className={`block rounded-md p-[3px] transition-[background-color] duration-(--dur-hover) ease-(--ease-out) motion-reduce:transition-none ${on ? "bg-muted" : "group-hover/lo:bg-foreground/5 group-active/lo:bg-foreground/12 group-active/lo:transition-none"}`}>
              <Picture doc={doc} page={pageOf(layout.name)} width={TILE} title="" thumb />
            </span>
            <span className={`px-[3px] text-xs leading-4 text-balance ${on ? "text-foreground" : "text-muted-foreground"}`}>{layout.name}</span>
          </button>
        );
      })}
    </div>
  );
}
