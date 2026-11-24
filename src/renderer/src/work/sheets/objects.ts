import type { ObjectChange, PictureMedia, SheetObjects } from "work-kit/sheet";
import { MEDIA_RESOURCE, RULES_SET, type ObjectIds, type ObjectListKind, type RulesSetParams, type SheetMutation } from "@shared/work/sheets";

/**
 * A sheet's charts and pictures as its host keeps them (docs/agents/work-sheets.md "Charts and
 * pictures"): the grid tells each change (`onObjects`), and the host is sent the tab's whole chart
 * or picture list in its place, as a rule's change sends its whole list. No React, no Univer.
 */

/**
 * A tab's whole chart or picture list as the grid holds it now, `subUnitId` the grid's id of the tab
 * named `tab`. A picture made here carries its bytes (`data`) while `bytesOf` gives them: until a
 * save gives it a part of the file's own, or the host has them.
 */
export function tabList(kind: ObjectListKind, subUnitId: string, tab: string, list: SheetObjects, bytesOf: (part: string) => Uint8Array | undefined): SheetMutation {
  const items =
    kind === "charts"
      ? list.charts.filter((c) => c.sheet === tab && !c.chartsheet)
      : list.pictures
          .filter((p) => p.sheet === tab)
          .map((p) => {
            const bytes = p.part.startsWith("media:") ? bytesOf(p.part) : undefined;
            return bytes ? { ...p, data: base64Of(bytes) } : p;
          });
  const params: RulesSetParams = { kind, subUnitId, list: items };
  return { id: RULES_SET, params };
}

/**
 * The list a change sends: the whole chart or picture list of the change's tab. A change that only
 * follows the cells (`cause: 'cells'`) sends nothing unless `cells`: an Excel file's own writer moves
 * its drawings with its rows and columns, while a sheet the service holds takes the grid's own list
 * after its rows as the truth.
 */
export function objectListOf(change: ObjectChange, list: SheetObjects, sheetId: (name: string) => string | undefined, bytesOf: (part: string) => Uint8Array | undefined, cells = false): SheetMutation | null {
  if (change.cause === "cells" && !cells) return null;
  const kind: ObjectListKind = "chart" in change.object ? "charts" : "pictures";
  const sheet = "chart" in change.object ? change.object.chart.sheet : change.object.picture.sheet;
  const subUnitId = sheetId(sheet);
  return subUnitId ? tabList(kind, subUnitId, sheet, list, bytesOf) : null;
}

/**
 * What the grid takes for a tab's list that came from elsewhere (another canvas, an agent, a restore):
 * the tab's objects of that kind the list leaves out taken away, and each it holds set (a `set` of one
 * the grid lacks adds it). Laid in, not told back.
 */
export function listChanges(list: SheetObjects, m: SheetMutation, tab: string): ObjectChange[] {
  const p = m.params as RulesSetParams;
  const items = (Array.isArray(p.list) ? p.list : []) as Array<Record<string, unknown>>;
  const ids = new Set(items.map((x) => x.id));
  if (p.kind === "charts") {
    const gone = list.charts.filter((c) => c.sheet === tab && !ids.has(c.id)).map((chart): ObjectChange => ({ kind: "remove", object: { chart } }));
    return [...gone, ...items.map((x): ObjectChange => ({ kind: "set", object: { chart: { ...(x as never as SheetObjects["charts"][number]), sheet: tab } } }))];
  }
  const gone = list.pictures.filter((x) => x.sheet === tab && !ids.has(x.id)).map((picture): ObjectChange => ({ kind: "remove", object: { picture } }));
  return [
    ...gone,
    ...items.map(({ data: _data, ...x }): ObjectChange => ({ kind: "set", object: { picture: { ...(x as never as SheetObjects["pictures"][number]), sheet: tab } } })),
  ];
}

/** The bytes a list carries for pictures made on a grid, by part. */
export function listMedia(m: SheetMutation): Array<[string, PictureMedia]> {
  const items = ((m.params as RulesSetParams).list ?? []) as Array<{ part?: unknown; contentType?: unknown; data?: unknown }>;
  return Array.isArray(items) ? items.flatMap((x) => (typeof x.part === "string" && typeof x.data === "string" ? [[x.part, { bytes: bytesOfBase64(x.data), type: typeof x.contentType === "string" ? x.contentType : "image/png" }] as [string, PictureMedia]] : [])) : [];
}

/** The bytes of the pictures made on a grid that a snapshot of a sheet the service holds carries (`MEDIA_RESOURCE`), by part. */
export function snapshotMedia(snapshot: { resources?: Array<{ name: string; data: string }> } | null | undefined): Map<string, { bytes: Uint8Array; type: string }> {
  const out = new Map<string, { bytes: Uint8Array; type: string }>();
  const data = snapshot?.resources?.find((r) => r.name === MEDIA_RESOURCE)?.data;
  if (!data) return out;
  try {
    for (const [part, m] of Object.entries(JSON.parse(data) as Record<string, { type?: unknown; data?: unknown }>)) if (typeof m?.type === "string" && typeof m.data === "string") out.set(part, { bytes: bytesOfBase64(m.data), type: m.type });
  } catch {
    // (a resource that cannot be read draws its pictures as empty frames)
  }
  return out;
}

/**
 * The file's names for objects the grid made: a save may name a chart or a picture anew (`ObjectIds`: a new chart
 * takes its part's name, pictures are numbered again), and the grid keeps its own id, the one its Undo and Redo name
 * the object by. A list goes to the host under the file's names (`out`), and one from elsewhere comes in under the
 * grid's (`in`). A book read again from the file starts a new map: the grid then names each as the file does.
 */
export class FileIds {
  /** the grid's id → the file's name for it; for a picture, its part in the file and its part on the grid (what it is drawn from) */
  private readonly named = new Map<string, { id: string; part?: string; own?: string }>();
  /** A save's answer, keyed by what was sent: each object of the grid it names takes the file's name. */
  take(list: SheetObjects, ids: ObjectIds): void {
    for (const o of [...list.charts, ...list.pictures]) {
      const was = this.named.get(o.id);
      const to = ids[was?.id ?? o.id];
      if (!to) continue;
      const part = to.part ?? was?.part;
      this.named.set(o.id, { id: to.id, ...(part ? { part } : {}), ...("part" in o ? { own: o.part } : {}) });
    }
  }
  /** A chart or picture list as the file names its objects. */
  out(m: SheetMutation): SheetMutation {
    return this.named.size ? mapped(m, (id) => this.named.get(id)) : m;
  }
  /** A list from elsewhere as the grid names its objects. */
  in(m: SheetMutation): SheetMutation {
    if (!this.named.size) return m;
    const back = new Map([...this.named].map(([grid, file]) => [file.id, { id: grid, ...(file.own ? { part: file.own } : {}) }]));
    return mapped(m, (id) => back.get(id));
  }
}

/** A list with each object named anew where `to` names it, a picture's part with it. */
function mapped(m: SheetMutation, to: (id: string) => { id: string; part?: string } | undefined): SheetMutation {
  const p = m.params as RulesSetParams;
  if (!Array.isArray(p.list)) return m;
  const list = (p.list as Array<Record<string, unknown>>).map((x) => {
    const name = typeof x.id === "string" ? to(x.id) : undefined;
    return name ? { ...x, id: name.id, ...(name.part && "part" in x ? { part: name.part } : {}) } : x;
  });
  return { ...m, params: { ...p, list } };
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
  /** Bytes that came from elsewhere (another canvas's picture, a restore): kept so the grid draws it. */
  keep(part: string, media: PictureMedia): void {
    this.held.set(part, media);
  }
}

/** Base64 as bytes. */
export function bytesOfBase64(data: string): Uint8Array {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** Bytes as base64, a block at a time (a string of a whole picture's characters at once overflows the call stack). */
export function base64Of(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
