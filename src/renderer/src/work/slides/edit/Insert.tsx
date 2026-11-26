import { useRef, useState, type ReactNode } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { DeckSlide, DeckView, SlideOp } from "@shared/contract-work-slides";
import { RowMenuItem, RowMenuSeparator, RowSubmenu } from "work-kit/format";
import { Plus } from "../../../chrome/icons";
import { sayError } from "../../canvas/frame";
import { Media, Shapes, TableInsert, TextBox, Video } from "../../icons";
import { ATTACH_PIECE, type DeckHost, type DeckStore } from "../deck";
import type { Size } from "./drag";
import { quadOf } from "./drag";
import { centredAt, madeShape, NEW_TEXT, pictureAt, PRESETS, shapeAt, tableAt, textBoxAt, type Preset } from "./add";
import type { HandSession, Start } from "./session";
import { newSlideAfter } from "./slides";

/**
 * Insert (the row's group 6, docs/DESIGN.md "The slide editor"): a new
 * slide, then what goes on the slide on the stage, each landing in the
 * slide's middle at a size of its own (edit/add.ts) and picked once it is
 * there; a text box opens for typing with its words selected, a table on its
 * first cell. A picture or a
 * video is read in the window for its proportions, brought to the host in
 * pieces (`DeckHost.attach`) and named by its token.
 */

/** How big a picture or a video is, read in the window; null where it cannot be read. */
export type MediaSize = (file: File, kind: "picture" | "video") => Promise<{ width: number; height: number } | null>;

export const mediaSize: MediaSize = async (file, kind) => {
  try {
    if (kind === "picture" && typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      const got = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return got;
    }
    if (kind === "video" && typeof URL.createObjectURL === "function") {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      try {
        return await new Promise((done) => {
          const timer = setTimeout(() => done(null), 3000);
          video.onloadedmetadata = () => (clearTimeout(timer), done({ width: video.videoWidth, height: video.videoHeight }));
          video.onerror = () => (clearTimeout(timer), done(null));
          video.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch {
    /* not a picture the window can read: the host says what it is */
  }
  return null;
};

/** The pictures and videos a deck holds (the host's own lists: deckScript.ts `op_insert`). */
export const PICTURE_TYPES = "image/png,image/jpeg,image/gif,image/bmp,image/tiff";
export const VIDEO_TYPES = "video/mp4,video/quicktime,video/x-ms-wmv,video/x-msvideo,video/mpeg,.mp4,.mov,.wmv,.avi,.mpg,.mpeg";

/** The kind of file a deck holds that `file` is, by its type: a picture, a video, or neither. */
export function mediaOf(file: Pick<File, "type">): "picture" | "video" | null {
  if (PICTURE_TYPES.split(",").includes(file.type)) return "picture";
  if (file.type && VIDEO_TYPES.split(",").includes(file.type)) return "video";
  return null;
}

/**
 * A picture or a video he adds (Insert's chooser, a paste, a drop on the stage): read in the window for its proportions
 * and fitted to three fifths of the slide, in its middle or centred on `at` (a drop's point, as shares of the slide),
 * brought to the host in pieces while its place is outlined ("Adding", counting what the host holds of a file of more
 * than one piece), then one `insert`, and picked.
 */
export async function bringMedia({
  file,
  what,
  slide,
  size,
  host,
  store,
  session,
  measure = mediaSize,
  at,
}: {
  file: File;
  what: "picture" | "video";
  slide: DeckSlide;
  size: Size;
  host: DeckHost;
  store: DeckStore;
  session: HandSession;
  measure?: MediaSize | undefined;
  at?: { x: number; y: number };
}): Promise<void> {
  const failed = what === "picture" ? "Couldn't add the picture" : "Couldn't add the video";
  const got = await measure(file, what);
  const fitted = pictureAt(size, got?.width ?? 0, got?.height ?? 0);
  const box = at ? centredAt(size, fitted, at) : fitted;
  const place = { slideKey: slide.key, quad: quadOf({ box, rot: 0, flipH: false, flipV: false }, size) };
  // A file that goes in more than one piece counts what the host holds, so a long video over a slow link shows it moving.
  const counted = file.size > ATTACH_PIECE;
  session.adding(counted ? { ...place, sent: 0, total: file.size } : place);
  let token: string;
  try {
    token = await session.while(() => file.arrayBuffer().then((bytes) => host.attach(file.name, new Uint8Array(bytes), counted ? (sent) => session.adding({ ...place, sent, total: file.size }) : undefined)));
  } catch (error) {
    session.adding(null);
    sayError(error, failed);
    return;
  }
  const before = store.get().view?.slides.find((s) => s.key === slide.key);
  const next = await session.edit([{ op: "insert", slide: slide.id, what, box, file: token }], failed);
  session.adding(null);
  const made = madeShape(before, next, slide.id);
  const now = next?.slides.find((s) => s.id === slide.id && s.tint !== "del");
  if (made && now) session.pick(now.key, made.id);
}

export interface Inserter {
  newSlide(): void;
  text(): void;
  shape(preset: Preset): void;
  table(rows: number, cols: number): void;
  /** opens the file chooser */
  picture(): void;
  video(): void;
  /** the hidden file choosers, drawn by the row outside its menus */
  inputs: ReactNode;
}

export function useInsert({
  view,
  slide,
  size,
  host,
  store,
  session,
  measure = mediaSize,
}: {
  view: DeckView;
  /** the slide on the stage, when his hand may add to it */
  slide: DeckSlide | undefined;
  size: Size;
  host: DeckHost;
  store: DeckStore;
  session: HandSession;
  measure?: MediaSize | undefined;
}): Inserter {
  const pictureInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  /** One shape onto the slide; once it is there it is picked, and a text box or a table opens for his words (`typing`: where the caret starts). */
  const add = async (op: (on: DeckSlide) => SlideOp, fallback: string, typing?: Start): Promise<void> => {
    const on = slide;
    if (!on) return;
    const before = store.get().view?.slides.find((s) => s.key === on.key);
    const next = await session.edit([op(on)], fallback);
    const made = madeShape(before, next, on.id);
    const now = next?.slides.find((s) => s.id === on.id && s.tint !== "del");
    if (!made || !now) return;
    session.pick(now.key, made.id);
    if (typing) session.open(now, made, typing);
  };
  /** A file he chose, brought to the host and put on the slide at its own proportions. */
  const bring = (file: File, what: "picture" | "video"): Promise<void> => (slide ? bringMedia({ file, what, slide, size, host, store, session, measure }) : Promise.resolve());
  const chooser = (ref: typeof pictureInput, accept: string, what: "picture" | "video") => (
    <input
      ref={ref}
      type="file"
      accept={accept}
      hidden
      data-slides-insert={what}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void bring(file, what);
      }}
    />
  );
  return {
    newSlide: () => newSlideAfter(view, slide ?? view.slides.find((s) => s.key === store.get().current), session, store),
    text: () => void add((s) => ({ op: "insert", slide: s.id, what: "text", box: textBoxAt(size), text: NEW_TEXT }), "Couldn't add a text box", "all"),
    shape: (preset) => void add((s) => ({ op: "insert", slide: s.id, what: "shape", box: shapeAt(size, preset), preset }), "Couldn't add the shape"),
    // A table opens on its first cell; a chart is left to PowerPoint until its data can be changed here.
    table: (rows, cols) => void add((s) => ({ op: "insert", slide: s.id, what: "table", box: tableAt(size, rows, cols), rows, cols }), "Couldn't add the table", "end"),
    picture: () => pictureInput.current?.click(),
    video: () => videoInput.current?.click(),
    inputs: (
      <>
        {chooser(pictureInput, PICTURE_TYPES, "picture")}
        {chooser(videoInput, VIDEO_TYPES, "video")}
      </>
    ),
  };
}

/** A preset's outline, drawn as the glyph of its row. */
export function PresetGlyph({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

const GRID = { rows: 6, cols: 8 } as const;

/** The table's size, picked on a grid as Word and PowerPoint draw it: each cell a menu row, its size said under the grid. */
function TableGrid({ onPick }: { onPick(rows: number, cols: number): void }) {
  const [at, setAt] = useState<[number, number]>([1, 1]);
  return (
    <div className="px-2 pt-1.5 pb-1">
      <div role="grid" aria-label="Table size" className="grid grid-cols-[repeat(8,16px)] gap-0.5">
        {Array.from({ length: GRID.rows * GRID.cols }, (_, i) => {
          const r = Math.floor(i / GRID.cols) + 1;
          const c = (i % GRID.cols) + 1;
          const on = r <= at[0] && c <= at[1];
          return (
            <MenuPrimitive.Item
              key={i}
              data-table-cell={`${r}x${c}`}
              aria-label={`${r} by ${c} table`}
              onPointerEnter={() => setAt([r, c])}
              onFocus={() => setAt([r, c])}
              onClick={() => onPick(r, c)}
              className={`size-4 rounded-[3px] outline-1 -outline-offset-1 outline-(--image-outline) ${on ? "bg-(--sel-bg-dark-pic) outline-(--sel-line-dark-pic)" : "bg-muted"}`}
            />
          );
        })}
      </div>
      <div className="pt-1.5 text-xs leading-4 text-muted-foreground tabular-nums">
        {at[0]} × {at[1]}
      </div>
    </div>
  );
}

/** Insert's rows: in its menu, and the same beside its row in ⋯ when it has folded. */
export function insertRows(insert: Inserter, { onSlide, canAdd }: { onSlide: boolean; canAdd: boolean }): ReactNode {
  return (
    <>
      <RowMenuItem icon={<Plus />} disabled={!canAdd} onSelect={insert.newSlide}>
        New slide
      </RowMenuItem>
      <RowMenuSeparator />
      <RowMenuItem icon={<TextBox />} disabled={!onSlide} onSelect={insert.text}>
        Text box
      </RowMenuItem>
      <RowSubmenu icon={<Shapes />} label="Shape" disabled={!onSlide} width={196}>
        {PRESETS.map((p) => (
          <RowMenuItem key={p.preset} icon={<PresetGlyph path={p.path} />} onSelect={() => insert.shape(p.preset)}>
            {p.label}
          </RowMenuItem>
        ))}
      </RowSubmenu>
      <RowMenuItem icon={<Media />} disabled={!onSlide} onSelect={insert.picture}>
        Picture…
      </RowMenuItem>
      <RowSubmenu icon={<TableInsert />} label="Table" disabled={!onSlide}>
        <TableGrid onPick={insert.table} />
      </RowSubmenu>
      <RowMenuItem icon={<Video />} disabled={!onSlide} onSelect={insert.video}>
        Video…
      </RowMenuItem>
    </>
  );
}
