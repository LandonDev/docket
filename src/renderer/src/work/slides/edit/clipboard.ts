import type { DeckShape, DeckSlide, SlideOp } from "@shared/contract-work-slides";
import { sayError } from "../../canvas/frame";
import { ATTACH_PIECE, type DeckHost, type DeckStore } from "../deck";
import { madeShape } from "./add";
import { quadOf, type Box, type Size } from "./drag";
import type { HandSession } from "./session";

/**
 * A shape copied, pasted and duplicated by his hand (docs/agents/work-slides.md
 * "Copy and paste"), as PowerPoint does: ⌘D lays a copy 12 points down and
 * right of the picked shape, and a second ⌘D after he moved that copy repeats
 * his move; ⌘C holds the picked shape for this window and puts its words on
 * the clipboard; ⌘V lays it on the slide on the stage, over its first where it
 * came from that slide and in its own place on another, each paste after the
 * first 12 points further. Each is one `copy` edit (deckScript.ts `op_copy`):
 * within a deck it names the shape, from another deck the slide it lies on,
 * cut out on its host (`work.slides.clip`) and brought to this one
 * (`work.slides.attach`), so the decks may be on different computers.
 */

/** PowerPoint's step for a duplicate, and for a paste over the shape it came from: 12 points each way, in EMU. */
export const COPY_STEP = 152_400;

/** The clipboard's own type for a shape: what it holds is the mark of the shape this window holds, so a later copy elsewhere wins. */
export const SHAPE_TYPE = "application/x-tempcode-deck-shape";

/** A field's keys and clipboard are its own: the notes, the typing box, find, a sheet's field. */
export const IN_FIELD = "input, textarea, [contenteditable=true], [data-slide-typing]";

/** The shape this window holds for a paste: where it came from, and how many times it was laid on each slide. */
export interface HeldShape {
  mark: string;
  env: string;
  itemId: string;
  host: DeckHost;
  slideId: number;
  slideKey: string;
  shapeId: number;
  /** its own box when it was copied; none for a shape the host places itself */
  box: Box | null;
  pasted: Map<string, number>;
}

let held: HeldShape | null = null;
let marks = 0;

/** ⌘C on a picked shape: held for a paste in this window; its words go on the clipboard for any other app, with the mark. */
export function copyShape(clipboard: DataTransfer | null, from: Omit<HeldShape, "mark" | "pasted">, shape: DeckShape): HeldShape {
  held = { ...from, mark: `${Date.now().toString(36)}-${++marks}`, pasted: new Map() };
  clipboard?.setData("text/plain", shape.text);
  clipboard?.setData(SHAPE_TYPE, held.mark);
  return held;
}

/** The shape a paste lays, when the clipboard still holds the one this window copied last. */
export function heldShape(clipboard: DataTransfer | null): HeldShape | null {
  const mark = clipboard?.getData(SHAPE_TYPE);
  return held && mark === held.mark ? held : null;
}

/** For a test: nothing held. */
export function forgetHeld(): void {
  held = null;
}

const shifted = (box: Box, dx: number, dy: number): Box => [box[0] + dx, box[1] + dy, box[2], box[3]];

/** Where a paste lies: over the shape it came from, a step on each time; on another slide where it lay, then a step on each time. */
export function pasteBox(clip: Pick<HeldShape, "box" | "slideKey" | "itemId" | "env" | "pasted">, here: { env: string; itemId: string; slideKey: string }): Box | null {
  if (!clip.box) return null;
  const over = clip.env === here.env && clip.itemId === here.itemId && clip.slideKey === here.slideKey;
  const n = (clip.pasted.get(`${here.env}\n${here.itemId}\n${here.slideKey}`) ?? 0) + (over ? 1 : 0);
  return shifted(clip.box, n * COPY_STEP, n * COPY_STEP);
}

/** The last ⌘D: the shape it was made from (its box then) and the copy, so the next ⌘D on that copy repeats the move he made. */
let lastDuplicate: { slideKey: string; from: Box; made: number } | null = null;

/** Where a duplicate lies: a step down and right, or, from the copy the last ⌘D made, as far again as he moved it. */
export function duplicateBox(slideKey: string, shape: DeckShape): Box | null {
  const own = shape.own?.box;
  if (!own) return null;
  const again = lastDuplicate && lastDuplicate.slideKey === slideKey && lastDuplicate.made === shape.id ? lastDuplicate.from : null;
  const [dx, dy] = again ? [own[0] - again[0], own[1] - again[1]] : [COPY_STEP, COPY_STEP];
  return shifted(own, dx, dy);
}

/** Reads a slide cut out of its deck on its host, piece by piece, all of one revision. */
export async function clipBytes(host: DeckHost, slideId: number): Promise<Uint8Array> {
  if (!host.clip) throw new Error("That deck's computer cannot hand its shapes to another deck yet.");
  const first = await host.clip(slideId, 0, ATTACH_PIECE);
  const out = new Uint8Array(first.size);
  out.set(first.data, 0);
  for (let at = first.data.length; at < first.size; ) {
    const next = await host.clip(slideId, at, ATTACH_PIECE);
    if (next.rev !== first.rev) throw new Error("The deck changed while the shape was read. Copy it again.");
    out.set(next.data, at);
    at += next.data.length;
    if (next.data.length === 0) break;
  }
  return out;
}

/** Lays the copy, then picks it as Insert picks what it adds. */
async function lay(session: HandSession, store: DeckStore, slide: DeckSlide, op: SlideOp, fallback: string): Promise<DeckShape | undefined> {
  const before = store.get().view?.slides.find((s) => s.key === slide.key);
  const next = await session.edit([op], fallback);
  const made = madeShape(before, next, slide.id);
  const now = next?.slides.find((s) => s.id === slide.id && s.tint !== "del");
  if (made && now) session.pick(now.key, made.id);
  return made;
}

/** ⌘D: a copy of the picked shape, on its own slide. */
export async function duplicateShape(session: HandSession, store: DeckStore, slide: DeckSlide, shape: DeckShape): Promise<void> {
  const box = duplicateBox(slide.key, shape);
  const made = await lay(session, store, slide, { op: "copy", slide: slide.id, shape: shape.id, ...(box ? { box } : {}) }, "Couldn't duplicate the shape");
  lastDuplicate = made && shape.own ? { slideKey: slide.key, from: shape.own.box, made: made.id } : null;
}

/** ⌘V: the shape this window holds, on the slide on the stage of this deck. */
export async function pasteShape(clip: HeldShape, here: { env: string; itemId: string; host: DeckHost; session: HandSession; store: DeckStore; slide: DeckSlide; size: Size }): Promise<void> {
  const { session, store, slide } = here;
  const box = pasteBox(clip, { env: here.env, itemId: here.itemId, slideKey: slide.key });
  const at = `${here.env}\n${here.itemId}\n${slide.key}`;
  clip.pasted.set(at, (clip.pasted.get(at) ?? 0) + 1);
  const place = box ? { op: { box }, quad: quadOf({ box, rot: 0, flipH: false, flipV: false }, here.size) } : null;
  if (clip.env === here.env && clip.itemId === here.itemId) {
    await lay(session, store, slide, { op: "copy", slide: clip.slideId, shape: clip.shapeId, to: slide.id, ...place?.op }, "Couldn't paste the shape");
    return;
  }
  // From another deck: its slide, cut out on its host, travels here first; its place is outlined meanwhile, as an added picture's is.
  if (place) session.adding({ slideKey: slide.key, quad: place.quad });
  let token: string;
  try {
    token = await session.while(async () => here.host.attach("Pasted shape.pptx", await clipBytes(clip.host, clip.slideId)));
  } catch (error) {
    session.adding(null);
    sayError(error, "Couldn't paste the shape");
    return;
  }
  await lay(session, store, slide, { op: "copy", slide: clip.slideId, shape: clip.shapeId, to: slide.id, file: token, ...place?.op }, "Couldn't paste the shape");
  session.adding(null);
}
