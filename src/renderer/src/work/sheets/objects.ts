import type { ObjectChange, PictureMedia, SheetObjects } from "work-kit/sheet";
import { RULES_SET, type ObjectIds, type ObjectListKind, type RulesSetParams, type SheetMutation } from "@shared/work/sheets";

/**
 * A sheet's charts and pictures as its host keeps them (docs/agents/work-sheets.md "Charts and
 * pictures"): the grid tells each change (`onObjects`), and the host is sent the tab's whole chart
 * or picture list in its place, as a rule's change sends its whole list. No React, no Univer.
 */

/**
 * The list a change sends: the whole chart or picture list of the change's tab, as the grid holds it
 * now. Null for a change that only follows the cells (`cause: 'cells'`): the host's own writer moves a
 * file's drawings with its rows and columns. A picture made here carries its bytes (`data`) until a
 * save gives it a part of the file's own.
 */
export function objectListOf(change: ObjectChange, list: SheetObjects, sheetId: (name: string) => string | undefined, bytesOf: (part: string) => Uint8Array | undefined): SheetMutation | null {
  if (change.cause === "cells") return null;
  const kind: ObjectListKind = "chart" in change.object ? "charts" : "pictures";
  const sheet = "chart" in change.object ? change.object.chart.sheet : change.object.picture.sheet;
  const subUnitId = sheetId(sheet);
  if (!subUnitId) return null;
  const items =
    kind === "charts"
      ? list.charts.filter((c) => c.sheet === sheet && !c.chartsheet)
      : list.pictures
          .filter((p) => p.sheet === sheet)
          .map((p) => {
            const bytes = p.part.startsWith("media:") ? bytesOf(p.part) : undefined;
            return bytes ? { ...p, data: base64Of(bytes) } : p;
          });
  const params: RulesSetParams = { kind, subUnitId, list: items };
  return { id: RULES_SET, params };
}

/**
 * What the grid takes after a save named its objects anew (`ObjectIds`): each one the file now calls
 * otherwise taken out under its old id and put back under the file's, with a picture's new part.
 * Every old id goes first, so a picture renumbered into another's old id is not taken out again.
 */
export function rekeyed(list: SheetObjects, ids: ObjectIds): ObjectChange[] {
  const out: ObjectChange[] = [];
  const back: ObjectChange[] = [];
  for (const chart of list.charts) {
    const to = ids[chart.id];
    if (!to || to.id === chart.id) continue;
    out.push({ kind: "remove", object: { chart } });
    back.push({ kind: "add", object: { chart: { ...chart, id: to.id } } });
  }
  for (const picture of list.pictures) {
    const to = ids[picture.id];
    if (!to || (to.id === picture.id && (to.part ?? picture.part) === picture.part)) continue;
    out.push({ kind: "remove", object: { picture } });
    back.push({ kind: "add", object: { picture: { ...picture, id: to.id, part: to.part ?? picture.part } } });
  }
  return [...out, ...back];
}

/** The bytes of the pictures made here, by their part, kept until the grid lets go: what a save sends, and what the grid draws. */
export class MadePictures {
  private readonly held = new Map<string, PictureMedia>();
  /** A change the grid told: an added picture's bytes are kept under its part. */
  take(change: ObjectChange): void {
    if (change.media && "picture" in change.object) this.held.set(change.object.picture.part, change.media);
  }
  get(part: string): PictureMedia | undefined {
    return this.held.get(part);
  }
  /** A save gave pictures parts of the file's own: their bytes are kept under those too, so the grid still draws them. */
  rename(list: SheetObjects, ids: ObjectIds): void {
    for (const picture of list.pictures) {
      const to = ids[picture.id]?.part;
      const media = this.held.get(picture.part);
      if (to && media) this.held.set(to, media);
    }
  }
}

/** Bytes as base64, a block at a time (a string of a whole picture's characters at once overflows the call stack). */
export function base64Of(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
