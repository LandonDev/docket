import { useMemo, useRef, useState } from "react";
import type { DeckColour, DeckShape, DeckSlide, DeckView, SlideOp } from "@shared/contract-work-slides";
import { themeEdit } from "@shared/work/deckThemes";
import { DEFAULT_TWIN, drawnAs, FONT_FAMILIES, fontStatus, twinOf } from "work-kit/fonts";
import {
  AlignMenu,
  buttonItem,
  ColourPicker,
  FontSelect,
  FormatRow,
  GROUP,
  menuItem,
  nextSize,
  OFFICE_THEME,
  resolveColour,
  RowMenuItem,
  RowMenuLabel,
  RowMenuRadioGroup,
  RowMenuRadioItem,
  RowMenuSeparator,
  SizeField,
  SIZES,
  THEME_SLOTS,
  toggleItem,
  undoHint,
  type Colour,
  type FormatItem,
  type FormatKey,
  type FormatRowOut,
  type OfficeTheme,
} from "work-kit/format";
import { IS_MAC } from "../../../lib/platform";
import { usePresentMenu, warmShow, type PresentAsk } from "../Present";
import { Layers, Play, Undo2 as Undo } from "../../../chrome/icons";
import type { PdfEngine } from "../../pdf/engine";
import { Align, Bold, BringForward, BringToFront, Bullets, Font, FormatSheet, Italic, Numbers, Redo, SendBackward, SendToBack, ShapeFill, Slides, Sorter, TextColour, Underline } from "../../icons";
import type { DeckHost, DeckStore } from "../deck";
import type { Size } from "./drag";
import { insertRows, useInsert, type MediaSize } from "./Insert";
import { LayoutSelect } from "./LayoutSelect";
import { DEFAULT_SIZE, modelOf, showing, showingAll, type ParaLook, type RunLook, type Showing } from "./model";
import type { HandSession, HandState } from "./session";
import { ThemeMenu } from "./ThemeMenu";

/**
 * The row's keys by their names in work-kit's key table (`format/keys.ts`), never typed out as a chord: the row
 * shows each hint only where the editor has the key.
 */
const KEY = { bold: "bold", bulleted: "bulleted", italic: "italic", numbered: "numbered", presentHere: "presentHere", underline: "underline" } as const satisfies Record<string, FormatKey>;

/**
 * The deck's format row (docs/DESIGN.md "Work editors", "The format row" and
 * "The slide editor"): work-kit's row, kind `slides`, as the first unscrolled
 * row of the deck's body wherever he can edit the deck by hand. It acts on
 * the words selected in the typing box, else on the whole of the picked text
 * shape (one `format` edit, written at once); with neither, its controls rest.
 * Present is its way out.
 */

/** What the row acts on: the box's selection, the picked shape whole, or nothing. */
export type Target = { kind: "box"; showing: Showing } | { kind: "shape"; slide: DeckSlide; shape: DeckShape; showing: Showing } | null;

/** The deck's theme as Office keeps it: its twelve colours (Office's own where the deck names none) and two fonts. */
export function officeTheme(view: DeckView): OfficeTheme {
  const colours = { ...OFFICE_THEME.colours };
  for (const slot of THEME_SLOTS) {
    const hex = view.theme?.colors[slot]?.replace(/^#/, "");
    if (hex && /^[0-9a-f]{6}$/i.test(hex)) colours[slot] = hex.toUpperCase();
  }
  return { name: view.name, colours, fonts: { heading: view.theme?.major || OFFICE_THEME.fonts.heading, body: view.theme?.minor || OFFICE_THEME.fonts.body } };
}

/** What the row and the keys act on now. */
export function targetOf(view: DeckView, slide: DeckSlide | undefined, hand: HandState, session: HandSession): Target {
  const box = hand.box;
  if (box) return box.phase === "typing" && slide?.key === box.slideKey ? { kind: "box", showing: showing(box.model, box.sel, box.pending) } : null;
  const shape = hand.picked && slide && hand.picked.slideKey === slide.key ? slide.shapes.find((s) => s.id === hand.picked!.shapeId) : undefined;
  if (!slide || !shape || session.refusal(slide, shape) !== null) return null;
  const shown = showingAll(modelOf(shape, session.fallback(view)));
  const over = hand.shapeLook?.shapeId === shape.id ? hand.shapeLook.set : {};
  return { kind: "shape", slide, shape, showing: { ...shown, ...over } };
}

/** Lays a look (or a paragraph's alignment, list or level) on what the row acts on. */
export function lay(target: Target, session: HandSession, set: RunLook & ParaLook): void {
  if (!target) return;
  if (target.kind === "shape") return void session.formatShape(target.slide, target.shape, set);
  const { level, align, list, ...look } = set;
  if (Object.keys(look).length > 0) session.look(look);
  const para = { ...(level !== undefined ? { level } : {}), ...(align ? { align } : {}), ...(list ? { list } : {}) };
  if (Object.keys(para).length > 0) session.para(para);
}

/** A colour from the picker as an edit says it: a theme colour by its slot and tint, so it stays the theme's; else its hex. */
export const deckColour = (colour: Colour): DeckColour => ("theme" in colour ? { slot: colour.theme, ...(colour.tint ? { tint: colour.tint } : {}) } : colour.hex.replace(/^#/, "").toUpperCase());

/** A shape whose fill is set here: a table's and a chart's are set in PowerPoint, and media has none. */
export const fillable = (shape: DeckShape): boolean => shape.kind !== "table" && shape.kind !== "chart" && shape.kind !== "media";

/** The fill a shape says it has, as the picker marks it: a hex, none, or undefined where its style gives it. */
const fillOf = (shape: DeckShape | undefined): Colour | null | undefined => (!shape?.fill ? undefined : shape.fill === "none" ? null : { hex: `#${shape.fill}` });

/** The format keys of the table (work-kit `formatKeyOf`) that the row's controls answer, on what it acts on. */
export function keyAct(key: FormatKey, target: Target, session: HandSession): boolean {
  if (!target) return false;
  const now = target.showing;
  const step = (dir: 1 | -1): number => nextSize(now.size ?? DEFAULT_SIZE, dir);
  const set: (RunLook & ParaLook) | null =
    key === "bold"
      ? { bold: !now.bold }
      : key === "italic"
        ? { italic: !now.italic }
        : key === "underline"
          ? { underline: !now.underline }
          : key === "sizeUp"
            ? { size: step(1) }
            : key === "sizeDown"
              ? { size: step(-1) }
              : key === "bulleted"
                ? { list: now.list === "bullet" ? "none" : "bullet" }
                : key === "numbered"
                  ? { list: now.list === "number" ? "none" : "number" }
                  : null;
  if (!set) return false;
  lay(target, session, set);
  return true;
}

/** The fonts the row offers: the five TempCode draws with their own metrics, by Office's names, then the theme's. */
const DRAWN = FONT_FAMILIES.map((f) => f.office);
/** A font TempCode has no face for says what it is drawn with; one drawn by its own twin says nothing. */
const drawnWith = (name: string): string | undefined => (fontStatus(name) === "fallback" ? (drawnAs(name) ?? DEFAULT_TWIN) : undefined);
const faceOf = (name: string): string => twinOf(name)?.twin ?? DEFAULT_TWIN;
const DISPLAYS_STALE_MS = 10_000;

export function DeckRow({
  view,
  target,
  slide,
  picked,
  hand,
  session,
  host,
  store,
  engine,
  size,
  look,
  sheet,
  narrow,
  tone,
  boundary,
  onPresent,
  measure,
  mediaSize,
}: {
  view: DeckView;
  target: Target;
  /** the slide on the stage (in the Sorter, the one he last stood on) */
  slide: DeckSlide | undefined;
  /** the shape picked on a slide his hand may change */
  picked: { slide: DeckSlide; shape: DeckShape } | null;
  hand: HandState;
  session: HandSession;
  host: DeckHost;
  store: DeckStore;
  engine?: PdfEngine | undefined;
  /** the slide in EMU */
  size: Size;
  look: "slide" | "sorter";
  /** the Format sheet is open */
  sheet: boolean;
  /** a canvas under 420px: the layout select narrows to 132px */
  narrow: boolean;
  /** the slide's ground, for Automatic: the theme's dark ink on a light slide, its light one on a dark slide */
  tone: "dark" | "light";
  boundary: Element | null;
  /** absent where the host has no picture of the file to show */
  onPresent?: (ask: PresentAsk) => void;
  /** a preview's widths, where nothing lays out */
  measure?: ((el: HTMLElement) => number) | undefined;
  /** a test's reading of a picture's size, where the window cannot read one */
  mediaSize?: MediaSize | undefined;
}) {
  const theme = useMemo(() => officeTheme(view), [view]);
  const inDocument = useMemo(() => {
    const named = new Set([theme.fonts.heading, theme.fonts.body]);
    for (const slide of view.slides) for (const shape of slide.shapes) for (const p of shape.paragraphs ?? []) for (const r of p.runs) if (r.font) named.add(r.font);
    return [...named];
  }, [view, theme]);
  const [lastColour, setLastColour] = useState<Colour | "auto">("auto");
  const [lastFill, setLastFill] = useState<Colour | null>(null);
  // His hand on the slide itself (its layout, what goes on it): none on a slide a suggestion changes.
  const slideOpen = !!slide && session.slideRefusal(slide) === null;
  const onStage = slideOpen && look === "slide";
  const insert = useInsert({ view, slide: onStage ? slide : undefined, size, host, store, session, measure: mediaSize });
  const shape = picked?.shape;
  const order = (to: "front" | "back" | "forward" | "backward"): void => {
    if (picked) void session.edit([{ op: "order", slide: picked.slide.id, shape: picked.shape.id, to }], "Couldn't move the shape");
  };
  const now = target?.showing;
  const off = !target;
  const box = hand.box;
  const undo = box ? hand.undo : !!view.hand?.undo;
  const redo = box ? hand.redo : !!view.hand?.redo;
  const hints = undoHint(IS_MAC);
  const set = (look: RunLook & ParaLook): void => lay(target, session, look);
  const present = usePresentMenu(onPresent ?? (() => undefined));
  const readAt = useRef(Date.now());
  const out: FormatRowOut | undefined = onPresent
    ? {
        label: "Present",
        icon: <Play className="fill-current" />,
        shortcut: KEY.presentHere,
        onPress: present.present,
        menuLabel: "Ways to present",
        menu: present.rows.map((row, i) =>
          row.kind === "sep" ? (
            <RowMenuSeparator key={`sep${i}`} />
          ) : row.kind === "label" ? (
            <RowMenuLabel key={`label${i}`}>{row.label}</RowMenuLabel>
          ) : row.kind === "item" ? (
            <RowMenuItem key={row.id} hint={row.shortcut} inset {...(row.checked !== undefined ? { checked: row.checked } : {})} onSelect={() => present.onPick(row.id)}>
              {row.label}
            </RowMenuItem>
          ) : null,
        ),
      }
    : undefined;
  const items: FormatItem[] = [
    buttonItem({ id: "undo", group: GROUP.edits, label: "Undo", icon: <Undo />, hint: hints.undo, disabled: !undo || !!(box && box.phase !== "typing"), onPress: () => (box ? session.undo() : void session.step("undo")) }),
    buttonItem({ id: "redo", group: GROUP.edits, label: "Redo", icon: <Redo />, hint: hints.redo, disabled: !redo || !!(box && box.phase !== "typing"), onPress: () => (box ? session.redo() : void session.step("redo")) }),
    {
      id: "layout",
      group: GROUP.style,
      keep: true,
      label: "Layout",
      hint: slide?.layout,
      control: (
        <LayoutSelect
          view={view}
          slide={slide}
          host={host}
          engine={engine}
          width={narrow ? 132 : 148}
          disabled={!slideOpen}
          onPick={(layout) => slide && void session.edit([{ op: "layout", slide: slide.id, layout }], "Couldn't change the layout")}
        />
      ),
      more: { layer: true, disabled: !slideOpen },
    },
    {
      id: "font",
      group: GROUP.font,
      label: "Font",
      icon: <Font />,
      hint: now?.font ?? undefined,
      control: <FontSelect label="Font" value={now?.font ?? null} fonts={DRAWN} inDocument={inDocument} drawnAs={drawnWith} faceOf={faceOf} disabled={off} onChange={(font) => set({ font })} />,
      more: { layer: true, disabled: off },
    },
    {
      id: "size",
      group: GROUP.font,
      label: "Font size",
      hint: now?.size ? String(now.size) : undefined,
      control: <SizeField label="Font size" value={now ? (now.size ?? null) : null} disabled={off} onChange={(size) => set({ size })} />,
      // Folded into ⋯, the size is Office's list of sizes.
      more: {
        submenu: (
          <RowMenuRadioGroup value={now?.size ? String(now.size) : ""} onValueChange={(v: string) => set({ size: Number(v) })}>
            {SIZES.map((size) => (
              <RowMenuRadioItem key={size} value={String(size)}>
                {size}
              </RowMenuRadioItem>
            ))}
          </RowMenuRadioGroup>
        ),
        width: 120,
        disabled: off,
      },
    },
    toggleItem({ id: "bold", group: GROUP.character, keep: true, label: "Bold", icon: <Bold />, shortcut: KEY.bold, disabled: off, pressed: !!now?.bold, onPressedChange: (bold) => set({ bold }) }),
    toggleItem({ id: "italic", group: GROUP.character, keep: true, label: "Italic", icon: <Italic />, shortcut: KEY.italic, disabled: off, pressed: !!now?.italic, onPressedChange: (italic) => set({ italic }) }),
    toggleItem({ id: "underline", group: GROUP.character, label: "Underline", icon: <Underline />, shortcut: KEY.underline, disabled: off, pressed: !!now?.underline, onPressedChange: (underline) => set({ underline }) }),
    {
      id: "colour",
      group: GROUP.character,
      label: "Text colour",
      icon: <TextColour />,
      control: (
        <ColourPicker
          label="Text colour"
          icon={<TextColour />}
          last={lastColour}
          current={now?.color ? { hex: `#${now.color}` } : undefined}
          none="Automatic"
          theme={theme}
          disabled={off}
          onPick={(colour) => {
            setLastColour(colour ?? "auto");
            // Drawn here as the hex it comes to; sent as the theme's own colour where it is one, so it stays the
            // theme's. Automatic is the theme's text colour (tx1), drawn as its ink for the slide's ground.
            const hex = colour ? resolveColour(colour, theme, "office") : tone === "dark" ? theme.colours.lt1 : theme.colours.dk1;
            const slot = colour === null ? { slot: "tx1" as const } : "theme" in colour ? { slot: colour.theme, ...(colour.tint ? { tint: colour.tint } : {}) } : null;
            set({ color: hex.replace(/^#/, "").toUpperCase(), theme: slot });
          }}
        />
      ),
      more: { layer: true, disabled: off },
    },
    {
      id: "fill",
      group: GROUP.character,
      label: "Shape fill",
      icon: <ShapeFill />,
      control: (
        <ColourPicker
          label="Shape fill"
          icon={<ShapeFill />}
          last={lastFill}
          current={fillOf(shape)}
          none="No fill"
          theme={theme}
          disabled={!shape || !fillable(shape)}
          onPick={(colour) => {
            setLastFill(colour);
            if (picked) void session.edit([{ op: "fill", slide: picked.slide.id, shape: picked.shape.id, color: colour ? deckColour(colour) : null }], "Couldn't fill the shape");
          }}
        />
      ),
      more: { layer: true, disabled: !shape || !fillable(shape) },
    },
    {
      id: "align",
      group: GROUP.cell,
      label: "Align",
      icon: <Align />,
      control: <AlignMenu label="Align" horizontal={now?.align ?? null} justify disabled={off} onHorizontal={(align) => set({ align })} />,
      more: { layer: true, disabled: off },
    },
    toggleItem({ id: "bullets", group: GROUP.cell, label: "Bullets", icon: <Bullets />, shortcut: KEY.bulleted, disabled: off, pressed: now?.list === "bullet", onPressedChange: (on) => set({ list: on ? "bullet" : "none" }) }),
    toggleItem({ id: "numbers", group: GROUP.cell, label: "Numbering", icon: <Numbers />, shortcut: KEY.numbered, disabled: off, pressed: now?.list === "number", onPressedChange: (on) => set({ list: on ? "number" : "none" }) }),
    menuItem({
      id: "arrange",
      group: GROUP.cell,
      label: "Arrange",
      icon: <Layers />,
      disabled: !picked,
      menuWidth: 200,
      rows: (
        <>
          <RowMenuItem icon={<BringToFront />} onSelect={() => order("front")}>
            Bring to front
          </RowMenuItem>
          <RowMenuItem icon={<BringForward />} onSelect={() => order("forward")}>
            Bring forward
          </RowMenuItem>
          <RowMenuItem icon={<SendBackward />} onSelect={() => order("backward")}>
            Send backward
          </RowMenuItem>
          <RowMenuItem icon={<SendToBack />} onSelect={() => order("back")}>
            Send to back
          </RowMenuItem>
        </>
      ),
    }),
    toggleItem({ id: "format", group: GROUP.cell, label: "Format", icon: <FormatSheet />, disabled: look !== "slide", pressed: sheet && look === "slide", onPressedChange: (on) => store.set({ sheet: on }) }),
    menuItem({ id: "insert", group: GROUP.insert, label: "Insert", word: true, menuWidth: 200, rows: insertRows(insert, { onSlide: onStage, canAdd: !!view.hand }) }),
    {
      id: "theme",
      group: GROUP.insert,
      label: "Theme",
      icon: <Slides />,
      control: <ThemeMenu view={view} disabled={false} onPick={(next) => void session.edit([themeEdit(next) as SlideOp], "Couldn't change the theme")} />,
      more: { layer: true },
    },
  ];
  return (
    <div
      data-format-row
      onPointerEnter={() => {
        if (!onPresent) return;
        warmShow();
        // The displays are read when the row is first reached, and again only after a while: they seldom change.
        if (Date.now() - readAt.current > DISPLAYS_STALE_MS) {
          readAt.current = Date.now();
          present.readDisplays();
        }
      }}
    >
      {/* A press on a toggle keeps the caret in the typing box; a layer takes the keyboard into itself. Escape on the
          row's own controls (not in a layer it opened) takes the keyboard back to the box. */}
      <div
        onKeyDown={(event) => {
          if (event.key !== "Escape" || box?.phase !== "typing" || !event.currentTarget.contains(event.target as Node)) return;
          event.preventDefault();
          session.focusBox();
        }}
        onMouseDown={(event) => {
          const button = (event.target as Element).closest("button");
          if (box?.phase === "typing" && button && !button.hasAttribute("aria-haspopup")) event.preventDefault();
        }}
      >
        <FormatRow
          kind="slides"
          items={items}
          view={{
            label: "View",
            value: look,
            options: [
              { value: "slide", label: "Slide", icon: <Slides /> },
              { value: "sorter", label: "Sorter", icon: <Sorter /> },
            ],
            onChange: (next) => store.set({ look: next as "slide" | "sorter" }),
          }}
          out={out}
          mac={IS_MAC}
          editorKeys
          boundary={boundary}
          {...(measure ? { measure } : {})}
        />
      </div>
      {insert.inputs}
    </div>
  );
}

