import { useEffect, useState, type ReactNode } from "react";
import type { DeckShape, DeckSlide, SlideOp } from "@shared/contract-work-slides";
import { ColourPicker, FormatRowContext, FormatSelectButton, RowMenu, RowMenuRadioGroup, RowMenuRadioItem, type Colour, type OfficeTheme } from "work-kit/format";
import { Square, X } from "../../../chrome/icons";
import { Button } from "../../../components/ui/button";
import { GroupInput, InputGroup } from "../../../components/ui/input";
import { bareKey } from "../../../lib/keys";
import { IS_MAC } from "../../../lib/platform";
import { KIND_WORDS } from "../geometry";
import { deckColour } from "./DeckRow";
import { lengthText, normalAngle, parseLength, type Own, type Unit } from "./drag";
import { turnable } from "./Manipulate";
import type { HandSession } from "./session";

/**
 * The Format sheet (docs/DESIGN.md "The slide editor"): the picked shape's
 * place and size in his units, its turn, its outline, and a table's rows and
 * columns, each written at once as he leaves a field or picks. 280px at the
 * stage's end on a canvas 720px wide or more, else under the slide in the
 * notes' place. Shadow and crop have no edit on the host yet and are not
 * offered; Animate is the show's (SLD6).
 */

export const SHEET_WIDTH = 280;
/** Under this much canvas the sheet lies under the slide, so the slide keeps its size. */
export const SHEET_BESIDE = 720;

/** PowerPoint's outline weights, in points. */
export const WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6] as const;
const DASHES = [
  { value: "solid", label: "Solid" },
  { value: "dash", label: "Dash" },
  { value: "dot", label: "Dot" },
] as const;

/** PowerPoint's dash, as the sheet's three say it: its dots are a dot, its other dashes a dash. */
export const dashOf = (prst: string | undefined): "solid" | "dash" | "dot" => (!prst || prst === "solid" ? "solid" : /^(sys)?dot$/i.test(prst) ? "dot" : "dash");

/** A table's rows and columns as the outline reads its cells (its text, row by row). */
export function gridOf(shape: DeckShape): { rows: number; cols: number } | null {
  const cells = shape.cells;
  if (shape.kind !== "table" || !cells?.length) return null;
  return { rows: cells.length, cols: Math.max(...cells.map((r) => r.length)) };
}

/** A field he types a value into: it is sent when he leaves it or presses Return, and put back by Escape or a value it cannot read. */
function NumberField({ label, lead, value, read, onSet, disabled }: { label: string; lead?: string; value: string; read(text: string): number | null; onSet(v: number): void; disabled?: boolean }) {
  const [text, setText] = useState(value);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!held) setText(value);
  }, [value, held]);
  const commit = (): void => {
    setHeld(false);
    // Left as it was shown: nothing to write (what is shown is rounded, and must not move the shape by the rounding).
    if (text.trim() === value) return;
    const v = read(text);
    if (v === null) return setText(value);
    onSet(v);
  };
  return (
    <InputGroup className="h-7 rounded-md px-2" leading={lead ? <span className="text-xs leading-5 text-muted-foreground">{lead}</span> : undefined}>
      <GroupInput
        aria-label={label}
        value={text}
        disabled={disabled}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        className="text-[13px] tabular-nums"
        onFocus={(e) => {
          setHeld(true);
          e.currentTarget.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && bareKey(e)) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setText(value);
            e.currentTarget.blur();
          }
        }}
      />
    </InputGroup>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h3 className="text-xs leading-4 font-medium text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3 text-[13px] leading-5">
      <span className="min-w-0 truncate">{label}</span>
      <div className="flex shrink-0 items-center gap-0.5">{children}</div>
    </div>
  );
}

export function FormatSheet({
  slide,
  shape,
  theme,
  unit,
  session,
  docked,
  boundary,
  onClose,
}: {
  slide: DeckSlide | undefined;
  /** the picked shape, on a slide his hand may change */
  shape: DeckShape | undefined;
  theme: OfficeTheme;
  unit: Unit;
  session: HandSession;
  /** under the slide (a narrow canvas), not beside it */
  docked: boolean;
  boundary: Element | null;
  onClose(): void;
}) {
  const [lastLine, setLastLine] = useState<Colour | null>(null);
  const edit = (op: SlideOp, fallback: string): void => void session.edit([op], fallback);
  const own = shape?.own;
  const place = (next: Partial<Own>): void => {
    if (!shape || !own || !slide) return;
    const box = next.box ?? own.box;
    const rot = next.rot ?? own.rot;
    const op: SlideOp = { op: "geometry", slide: slide.id, shape: shape.id, ...(next.box ? { box } : {}), ...(next.rot !== undefined ? { rot } : {}) };
    if (box.every((v, i) => v === own.box[i]) && normalAngle(rot) === normalAngle(own.rot)) return;
    edit(op, "Couldn't move the shape");
  };
  const length = (text: string): number | null => parseLength(text, unit);
  const positive = (text: string): number | null => {
    const v = parseLength(text, unit);
    return v !== null && v >= 1 ? v : null;
  };
  const line = shape?.line;
  const grid = shape ? gridOf(shape) : null;
  const [row, setRow] = useState(0);
  const [col, setCol] = useState(0);
  const gridEdit = (what: "row" | "col", act: "insert" | "delete", at: number): void => {
    if (shape && slide) edit({ op: "grid", slide: slide.id, shape: shape.id, what, act, at }, what === "row" ? "Couldn't change the rows" : "Couldn't change the columns");
  };
  return (
    <FormatRowContext.Provider value={{ boundary, more: null, mac: IS_MAC, editorKeys: true, kind: "slides" }}>
      <aside
        data-slides-sheet={docked ? "under" : "beside"}
        aria-label="Format"
        onKeyDown={(e) => {
          if (e.key !== "Escape" || (e.target as Element).closest("input")) return;
          e.preventDefault();
          onClose();
        }}
        className={docked ? "flex min-h-0 flex-col border-t border-border bg-background" : "flex w-[280px] min-h-0 shrink-0 flex-col border-s border-border bg-background"}
      >
        <div className="flex shrink-0 items-center gap-1 ps-3 pe-2 pt-2">
          <h2 className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium">{shape ? (shape.label ?? KIND_WORDS[shape.kind ?? "other"]) : "Format"}</h2>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div
          key={shape?.id ?? "none"}
          className={`flex flex-col gap-5 px-3 pt-4 pb-6 transition-[opacity,translate] ${docked ? "" : "min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"} duration-(--dur-base) ease-(--ease-out) starting:opacity-0 motion-reduce:transition-opacity ${docked ? "starting:translate-y-2" : "starting:translate-x-2"} motion-reduce:starting:translate-x-0 motion-reduce:starting:translate-y-0`}
        >
          {!shape ? (
            <p className="text-[13px] leading-5 text-muted-foreground">Pick a shape on the slide</p>
          ) : (
            <>
              <Section label="Position and size">
                {own ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <NumberField label="Left" lead="X" value={`${lengthText(own.box[0], unit)} ${unit}`} read={length} onSet={(v) => place({ box: [v, own.box[1], own.box[2], own.box[3]] })} />
                      <NumberField label="Top" lead="Y" value={`${lengthText(own.box[1], unit)} ${unit}`} read={length} onSet={(v) => place({ box: [own.box[0], v, own.box[2], own.box[3]] })} />
                      <NumberField label="Width" lead="W" value={`${lengthText(own.box[2], unit)} ${unit}`} read={positive} onSet={(v) => place({ box: [own.box[0], own.box[1], v, own.box[3]] })} />
                      <NumberField label="Height" lead="H" value={`${lengthText(own.box[3], unit)} ${unit}`} read={positive} onSet={(v) => place({ box: [own.box[0], own.box[1], own.box[2], v] })} />
                    </div>
                    {turnable(shape) ? (
                      <Row label="Rotation">
                        <div className="w-24">
                          <NumberField
                            label="Rotation"
                            value={`${Math.round(own.rot * 100) / 100}°`}
                            read={(text) => {
                              const n = Number(text.replace(/°/g, "").replace("−", "-").replace(",", ".").trim());
                              return Number.isFinite(n) && text.trim() ? normalAngle(n) : null;
                            }}
                            onSet={(rot) => place({ rot })}
                          />
                        </div>
                      </Row>
                    ) : null}
                  </>
                ) : (
                  <p className="text-xs leading-4 text-muted-foreground">It is in a turned group: move it in PowerPoint</p>
                )}
              </Section>
              {shape.kind !== "table" && shape.kind !== "chart" ? (
                <Section label="Outline">
                  <Row label="Colour">
                    <ColourPicker
                      label="Outline colour"
                      icon={<Square />}
                      last={line?.color && line.color !== "none" ? { hex: `#${line.color}` } : line?.color === "none" ? null : lastLine}
                      current={!line?.color ? undefined : line.color === "none" ? null : { hex: `#${line.color}` }}
                      none="No outline"
                      theme={theme}
                      onPick={(colour) => {
                        setLastLine(colour);
                        if (slide) edit({ op: "line", slide: slide.id, shape: shape.id, color: colour ? deckColour(colour) : null }, "Couldn't change the outline");
                      }}
                    />
                  </Row>
                  <Row label="Weight">
                    <RowMenu
                      label="Outline weight"
                      width={128}
                      trigger={
                        <FormatSelectButton label="Outline weight" className="w-28">
                          {line?.width !== undefined ? `${line.width} pt` : "Default"}
                        </FormatSelectButton>
                      }
                    >
                      <RowMenuRadioGroup value={line?.width !== undefined ? String(line.width) : ""} onValueChange={(v: string) => slide && edit({ op: "line", slide: slide.id, shape: shape.id, width: Number(v) }, "Couldn't change the outline")}>
                        {WEIGHTS.map((w) => (
                          <RowMenuRadioItem key={w} value={String(w)}>
                            <span aria-hidden="true" className="me-2 block w-8 rounded-full bg-current" style={{ height: Math.max(1, Math.round(w * 1.333)) }} />
                            {w} pt
                          </RowMenuRadioItem>
                        ))}
                      </RowMenuRadioGroup>
                    </RowMenu>
                  </Row>
                  <Row label="Dash">
                    <RowMenu
                      label="Outline dash"
                      width={128}
                      trigger={
                        <FormatSelectButton label="Outline dash" className="w-28">
                          {DASHES.find((d) => d.value === dashOf(line?.dash))?.label}
                        </FormatSelectButton>
                      }
                    >
                      <RowMenuRadioGroup value={dashOf(line?.dash)} onValueChange={(v: string) => slide && edit({ op: "line", slide: slide.id, shape: shape.id, dash: v as "solid" | "dash" | "dot" }, "Couldn't change the outline")}>
                        {DASHES.map((d) => (
                          <RowMenuRadioItem key={d.value} value={d.value}>
                            <svg aria-hidden="true" viewBox="0 0 32 4" className="me-2 h-1 w-8">
                              <path d="M1 2H31" stroke="currentColor" strokeWidth={2} strokeDasharray={d.value === "dash" ? "5 3" : d.value === "dot" ? "1.5 2.5" : undefined} />
                            </svg>
                            {d.label}
                          </RowMenuRadioItem>
                        ))}
                      </RowMenuRadioGroup>
                    </RowMenu>
                  </Row>
                </Section>
              ) : null}
              {grid ? (
                <Section label="Table">
                  <GridRow what="row" count={grid.rows} at={Math.min(row, grid.rows - 1)} onAt={setRow} onEdit={gridEdit} />
                  <GridRow what="col" count={grid.cols} at={Math.min(col, grid.cols - 1)} onAt={setCol} onEdit={gridEdit} />
                </Section>
              ) : null}
            </>
          )}
        </div>
      </aside>
    </FormatRowContext.Provider>
  );
}

/** One of a table's rows or columns picked by its place, and a row or column put in before or after it, or it taken out. */
function GridRow({ what, count, at, onAt, onEdit }: { what: "row" | "col"; count: number; at: number; onAt(at: number): void; onEdit(what: "row" | "col", act: "insert" | "delete", at: number): void }) {
  const name = what === "row" ? "Row" : "Column";
  return (
    <div className="flex flex-col gap-1">
      <Row label={name}>
        <RowMenu
          label={name}
          width={112}
          trigger={
            <FormatSelectButton label={name} className="w-28">
              {`${name} ${at + 1} of ${count}`}
            </FormatSelectButton>
          }
        >
          <RowMenuRadioGroup value={String(at)} onValueChange={(v: string) => onAt(Number(v))}>
            {Array.from({ length: count }, (_, i) => (
              <RowMenuRadioItem key={i} value={String(i)}>
                {`${name} ${i + 1}`}
              </RowMenuRadioItem>
            ))}
          </RowMenuRadioGroup>
        </RowMenu>
      </Row>
      <div className="flex justify-end gap-0.5">
        <Button variant="ghost" size="xs" onClick={() => onEdit(what, "insert", at)}>
          {what === "row" ? "Insert above" : "Insert left"}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onEdit(what, "insert", at + 1)}>
          {what === "row" ? "Insert below" : "Insert right"}
        </Button>
        <Button variant="ghost" size="xs" disabled={count < 2} onClick={() => onEdit(what, "delete", at)}>
          Delete
        </Button>
      </div>
    </div>
  );
}
