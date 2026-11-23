import type { DeckSlide, DeckView, SlideOp } from "@shared/contract-work-slides";
import { CopyPlus, Eye, Layers, Pencil, Plus, Trash2, X } from "../../../chrome/icons";
import type { MenuRow } from "../../../chrome/menuRows";
import { Hidden } from "../../icons";
import type { DeckStore } from "../deck";
import { layoutsFor, madeSlide } from "./add";
import type { HandSession } from "./session";

/**
 * His hand on the deck's slides (docs/agents/work-slides.md "Slides by
 * hand"): the menu a slide opens in the strip and in the Sorter, what each of
 * its rows writes, and a slide's place moved by a drag. Only where no
 * suggestion waits: the strip shows the proposed order then, which is not
 * the file's.
 */

/** Whether his hand may change the deck's slides now: by hand, with no suggestion waiting. */
export const slidesOpen = (view: DeckView): boolean => !!view.hand && view.changes.length === 0;

/** A section's place in the deck's list of them (from 0): how many slides before this one start one. */
export function sectionIndex(view: DeckView, slide: DeckSlide): number {
  const at = view.slides.findIndex((s) => s.key === slide.key);
  return view.slides.slice(0, at).filter((s) => s.section !== undefined).length;
}

/** The rows of a slide's menu. */
export function slideRows(view: DeckView, slide: DeckSlide): MenuRow[] {
  const layouts = view.layouts ?? [];
  const fits = layoutsFor(view, slide);
  const rows: MenuRow[] = [];
  if (layouts.length) rows.push({ kind: "sub", id: "new", label: "New slide after", icon: Plus, items: layouts.map((l) => ({ kind: "item", id: `new:${l.name}`, label: l.name })) });
  rows.push({ kind: "item", id: "duplicate", label: "Duplicate", icon: CopyPlus });
  rows.push(slide.hidden ? { kind: "item", id: "hide", label: "Show slide", icon: Eye } : { kind: "item", id: "hide", label: "Hide slide", icon: Hidden });
  if (fits.length > 1) rows.push({ kind: "sub", id: "layout", label: "Layout", icon: Layers, items: fits.map((l) => ({ kind: "item", id: `layout:${l.name}`, label: l.name, checked: l.name === slide.layout })) });
  rows.push({ kind: "sep" });
  if (slide.section === undefined) rows.push({ kind: "item", id: "section:add", label: "Add section here", icon: Plus });
  else rows.push({ kind: "item", id: "section:rename", label: "Rename section…", icon: Pencil }, { kind: "item", id: "section:remove", label: "Remove section", icon: X });
  rows.push({ kind: "sep" }, { kind: "item", id: "delete", label: "Delete slide", icon: Trash2, disabled: view.slides.length < 2 });
  return rows;
}

/** A section's name asked for: adding one at a slide, or renaming the one it starts. */
export type NameAsk = { act: "add"; slide: DeckSlide } | { act: "rename"; slide: DeckSlide; section: number; name: string };

/** What a row of a slide's menu does: one edit, written at once; a slide it makes goes on the stage. */
export function slideAct(pick: string, slide: DeckSlide, view: DeckView, session: HandSession, store: DeckStore, askName: (ask: NameAsk) => void): void {
  const send = (op: SlideOp, fallback: string, go = false): void =>
    void session.edit([op], fallback).then((next) => {
      const made = go && next ? madeSlide(view, next) : undefined;
      if (made) store.set({ current: made.key });
    });
  if (pick.startsWith("new:")) return send({ op: "add", after: slide.id, layout: pick.slice(4) }, "Couldn't add a slide", true);
  if (pick.startsWith("layout:")) return send({ op: "layout", slide: slide.id, layout: pick.slice(7) }, "Couldn't change the layout");
  if (pick === "duplicate") return send({ op: "duplicate", slide: slide.id }, "Couldn't duplicate the slide", true);
  if (pick === "hide") return send({ op: "hide", slide: slide.id, hidden: !slide.hidden }, slide.hidden ? "Couldn't show the slide" : "Couldn't hide the slide");
  if (pick === "delete") return removeSlide(slide, view, session);
  if (pick === "section:add") return askName({ act: "add", slide });
  if (pick === "section:rename") return askName({ act: "rename", slide, section: sectionIndex(view, slide), name: slide.section ?? "" });
  if (pick === "section:remove") return send({ op: "section", act: "remove", section: sectionIndex(view, slide) }, "Couldn't remove the section");
}

/** A slide off the deck; the deck's last slide stays. */
export function removeSlide(slide: DeckSlide, view: DeckView, session: HandSession): void {
  if (view.slides.length < 2) return;
  void session.edit([{ op: "remove", slide: slide.id }], "Couldn't delete the slide");
}

/** The edit that puts a slide in its new place: after the slide before it in the new order, or first. */
export function moveOp(order: readonly string[], key: string, view: DeckView): SlideOp | null {
  const slide = view.slides.find((s) => s.key === key);
  const at = order.indexOf(key);
  if (!slide || at < 0) return null;
  const before = at === 0 ? null : view.slides.find((s) => s.key === order[at - 1]);
  const was = view.slides.findIndex((s) => s.key === key);
  const wasBefore = was === 0 ? null : view.slides[was - 1];
  if ((before?.id ?? 0) === (wasBefore?.id ?? 0)) return null;
  return { op: "move", slide: slide.id, after: before?.id ?? 0 };
}
