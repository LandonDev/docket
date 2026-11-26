import { useEffect, useMemo, useRef, useState } from "react";
import { readObjectsResource, SheetCanvas, SheetToolbar, type SheetHandle, type SheetPresence } from "work-kit/sheet";
import type { SessionEvent } from "work-kit/sheet/collab";
import { cutFix, guestCells, typedCells } from "@shared/work/sheetGuest";
import { GUEST_ROW, isObjectList, type RulesSetParams } from "@shared/work/sheets";
import { listChanges, listMedia, snapshotMedia } from "@renderer/work/sheets/objects";
import { SheetBones } from "@renderer/work/sheets/bones";
import { StatusMark } from "@renderer/components/ui/status";
import type { Frame } from "./frame";
import type { Opened, Session } from "./session";
import { openSheetLine, type LineStatus, type SheetLine, type SheetPerson } from "./sheetLine";
import { claimQueue, sheetQueue, type SheetQueue } from "./sheetQueue";

/**
 * A sheet on the hosted page: the owner's grid (work-kit/sheet) on the live
 * sheet socket (docs/agents/work-sheets.md "Live editing"), through work-kit's
 * session (sheetLine.ts): this page's own edits are kept apart from the
 * sheet's order until the sheet answers them, and everyone else's are moved
 * through them before they are laid. A view link is the grid read only. An
 * edit link draws the format row over the grid, with the controls whose
 * presses the service lets a guest send (`GUEST_ROW`): a guest formats cells,
 * merges them and sizes rows and columns, and makes no rule, name or filter.
 *
 * The grid stays editable while the line is down, under one muted line that
 * says where the edits wait: on this device for an Edit link (sheetQueue.ts,
 * a day at most, wiped when the link ends), else in this tab. They go when
 * the sheet is back, each batch with the revision it was made on; what the
 * sheet could not take is said once in one line ("3 edits made offline could
 * not be kept. The sheet changed under them."), and so is an edit it refused
 * ("Edit not saved" and why, in plain words). Either line stands until the
 * next edit the sheet takes. Everyone else's selection is drawn in their hue
 * with their name, as the service names them.
 */

type Mutation = { id: string; params: Record<string, unknown> };

/** Ops from the sheet laid on the guest's grid: a tab's chart or picture list on its objects (its pictures' bytes kept), the rest on its cells. */
function laidFrom(h: SheetHandle, mutations: Mutation[], media: Map<string, { bytes: Uint8Array; type: string }>): void {
  let cells: Mutation[] = [];
  const flush = (): void => {
    if (cells.length) h.apply(cells as never);
    cells = [];
  };
  for (const m of mutations) {
    if (!isObjectList(m)) {
      cells.push(m);
      continue;
    }
    flush();
    const tab = h.store.get().sheets.find((x) => x.id === (m.params as unknown as RulesSetParams).subUnitId)?.name;
    if (tab === undefined) continue;
    for (const [part, got] of listMedia(m)) media.set(part, got);
    h.objects.apply(listChanges(h.objects.list(), m, tab));
  }
  flush();
}
/**
 * Why an edit was not saved, in a guest's words: the service's own reasons are
 * protocol words. A reason with no plain form leaves the line its word alone
 * (null).
 */
export function refusedWords(reason: string): string | null {
  if (/too many edits at once/i.test(reason)) return "Too many edits at once. Wait a minute, then make it again";
  if (/changed under that edit/i.test(reason)) return "Someone changed the sheet first. Type it again";
  if (/^a guest cannot/i.test(reason)) return "Guests can change values and formats only";
  if (/overlap a merged cell/i.test(reason)) return "Those cells overlap a merged cell. Unmerge it first";
  if (/past the end of the sheet/i.test(reason)) return "That reaches past the end of the sheet";
  if (/formula is at most/i.test(reason)) return "That formula is too long";
  if (/cell holds at most/i.test(reason)) return "That is too much text for one cell";
  if (/\bat most\b/i.test(reason)) return "That is too much to change at once. Do it in smaller parts";
  if (/can view, not edit/i.test(reason)) return "This link can view the sheet, not edit it";
  return null;
}

/** An edit the sheet refused, and why in his words (null: the word alone). */
export type Refusal = { why: string | null };

/** What the offline line says, by what holds the edits made meanwhile: this device (an Edit link's queue), this tab, or nothing to hold (a reader). */
export const SHEET_OFFLINE_WORDS = {
  device: "Offline. Your edits are kept on this device until the sheet is back.",
  tab: "Offline. Your edits are kept in this tab until the sheet is back.",
  reader: "Offline. Changes will show when the sheet is back.",
} as const;
export const SHEET_FULL_WORDS = "Too many edits are waiting to send. The sheet takes no more until it is back.";

/** Edits the page could not keep, in one sentence: the sheet changed under them, the host cannot say whether they landed, or they waited over a day. */
export function droppedWords(edits: number, why: "changed" | "unknown" | "old", offline: boolean): string {
  const one = edits === 1;
  const n = `${edits} ${one ? "edit" : "edits"}${offline || why === "old" ? " made offline" : ""}`;
  if (why === "unknown") return `${n} could not be confirmed. Check the sheet.`;
  if (why === "old") return `${n} ${one ? "was" : "were"} over a day old and ${one ? "was" : "were"} not kept.`;
  return `${n} could not be kept. The sheet changed under ${one ? "it" : "them"}.`;
}

const newCid = (): string => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `c${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);

export function SheetPage({
  session,
  opened,
  onGone,
  onDown,
  onPeople,
  frame = null,
}: {
  session: Session;
  opened: Opened;
  onGone(): void;
  /** The page never got its sheet. (A page that has it keeps trying for good, under its own line.) */
  onDown(): void;
  /** who else is on the sheet, as their selections come and go: the page's line draws their faces */
  onPeople?(people: { id: string; name: string; color: string }[]): void;
  /** The phone's bridge (frame.ts): the grid says when it has drawn, and takes Undo and Redo. No format or find of the grid. */
  frame?: Frame | null;
}) {
  const linkId = session.mode?.kind === "guest" ? session.mode.id : null;
  const guest = opened.me.startsWith("guest:");
  const edits = opened.role === "edit";
  const [book, setBook] = useState<{ snapshot: Record<string, unknown>; key: number } | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  // Edits the page could not keep, said once in one sentence.
  const [dropped, setDropped] = useState<string | null>(null);
  const [status, setStatus] = useState<LineStatus>({ offline: false, syncing: true, full: false, unsent: 0 });
  // Whether this device holds the edits made offline (an Edit link's queue, one tab at a time).
  const [onDevice, setOnDevice] = useState(false);
  const [people, setPeople] = useState<SheetPerson[]>([]);
  const handle = useRef<SheetHandle | null>(null);
  // The bytes of the pictures made on the owner's grid: the snapshot's, and those that came in an op since.
  const media = useRef(new Map<string, { bytes: Uint8Array; type: string }>());
  // The grid as the row acts on it: state, so the row draws once the grid is up.
  const [grid, setGrid] = useState<SheetHandle | null>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const line = useRef<SheetLine | null>(null);
  // The workbook's id, and the newest grid asked for: only its own coming up answers the session.
  const at = useRef({ unit: "", want: 0 });
  // An edit was made since the standing line was said: the next time every edit is answered, the line goes.
  const editedSince = useRef(false);
  const told = useRef({ onGone, onDown, onPeople });
  told.current = { onGone, onDown, onPeople };

  useEffect(() => {
    let stopped = false;
    let queue: SheetQueue | null = null;
    let release = (): void => {};
    const flush = (): void => queue?.flush();
    const hidden = (): void => void (document.hidden && queue?.flush());
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    void (async () => {
      let saved = null;
      // The queue on this device is an Edit link's alone: a reader has nothing to keep, and the owner's page is his own app's.
      if (linkId !== null && edits) {
        const claim = await claimQueue(linkId);
        if (stopped) return claim.release();
        release = claim.release;
        if (claim.held) {
          queue = sheetQueue(linkId);
          const kept = await queue.load();
          if (stopped) return;
          saved = kept.saved;
          if (kept.old) setDropped(droppedWords(kept.old, "old", true));
          setOnDevice(true);
        }
      }
      const said = (event: SessionEvent, returning: boolean): void => {
        if (event.kind === "refused") {
          editedSince.current = false;
          setRefused({ why: refusedWords(event.reason) });
        } else if (event.kind === "dropped") {
          editedSince.current = false;
          setDropped(droppedWords(event.edits, event.why, returning));
        } else if (event.kind === "settled" && editedSince.current) {
          setRefused(null);
          setDropped(null);
        }
      };
      line.current = openSheetLine({
        session,
        opened,
        cid: saved?.cid ?? newCid(),
        saved,
        lay: (mutations) => {
          if (handle.current) laidFrom(handle.current, mutations, media.current);
        },
        rebuild: (snapshot) => {
          at.current.unit = typeof snapshot.id === "string" ? snapshot.id : "";
          media.current = snapshotMedia(snapshot as never);
          setBook({ snapshot, key: ++at.current.want });
        },
        status: setStatus,
        said,
        people: (list) => {
          setPeople(list);
          // One face a person, whichever of their windows holds a selection.
          const faces = new Map(list.map((p) => [`${p.name}|${p.hue}`, { id: p.id, name: p.name, color: `var(--presence-${((p.hue - 1) % 8) + 1})` }]));
          told.current.onPeople?.([...faces.values()]);
        },
        changed: (s) => queue?.save(s),
        gone: () => {
          // Nothing more is written: the link's copy on this device is being wiped.
          queue?.stop();
          told.current.onGone();
        },
        reopen: () => window.location.reload(),
        down: () => told.current.onDown(),
      });
    })();
    return () => {
      stopped = true;
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      line.current?.stop();
      line.current = null;
      queue?.flush();
      release();
      told.current.onPeople?.([]);
    };
  }, [session, opened, linkId, edits]);

  const presence = useMemo<SheetPresence[]>(() => people.map((p) => ({ id: p.id, name: p.name, hue: p.hue, range: { sheet: p.sheet, ...p.range } })), [people]);

  // The phone's frame: drawn once the grid has painted; Undo and Redo from its More; the keyboard's state from the focus.
  useEffect(() => {
    if (!frame || !grid || !box) return;
    const state = (editing: boolean) => frame.state({ editing: edits && editing, style: null, styles: [], bold: false, italic: false, list: null, undo: edits, redo: edits });
    const unlisten = frame.listen(window, (m) => {
      if (!edits) return;
      if (m.kind === "undo") grid.undo();
      else if (m.kind === "redo") grid.redo();
    });
    const focused = (): void => state(box.contains(document.activeElement));
    box.addEventListener("focusin", focused);
    box.addEventListener("focusout", focused);
    state(false);
    let paint = requestAnimationFrame(() => (paint = requestAnimationFrame(() => frame.drawn({ format: false, find: false, undo: edits }))));
    return () => {
      cancelAnimationFrame(paint);
      unlisten();
      box.removeEventListener("focusin", focused);
      box.removeEventListener("focusout", focused);
    };
  }, [frame, grid, box, edits]);

  // The sheet's own shape while it comes, the format row reserved for an Edit link, so nothing jumps when the grid lands.
  if (!book) return <SheetBones row={edits} />;
  const offlineWords = !edits ? SHEET_OFFLINE_WORDS.reader : onDevice ? SHEET_OFFLINE_WORDS.device : SHEET_OFFLINE_WORDS.tab;
  // One muted line for the state of the line; the sheet taking no more edits says more than its being away.
  const quiet = status.full ? SHEET_FULL_WORDS : status.offline ? offlineWords : null;
  return (
    <>
      {quiet ? (
        <div role="status" data-sheet-offline="" className="flex min-h-8 min-w-0 shrink-0 items-center border-b border-border px-3 py-1 text-[13px] leading-5 text-muted-foreground">
          <span className="min-w-0">{quiet}</span>
        </div>
      ) : null}
      {refused ? (
        <div role="alert" data-sheet-refused="" className="flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[13px] leading-5">
          <StatusMark state="failed" word="Edit not saved" detail={refused.why ?? undefined} className="min-w-0 flex-1" />
        </div>
      ) : null}
      {dropped ? (
        <div role="alert" data-sheet-dropped="" className="flex min-h-8 min-w-0 shrink-0 items-center border-b border-border px-3 py-1 text-[13px] leading-5">
          <span className="min-w-0">{dropped}</span>
        </div>
      ) : null}
      {grid && edits ? <SheetToolbar sheet={grid} controls={GUEST_ROW} boundary={box} mac={IS_MAC} editorKeys /> : null}
      <div ref={setBox} className="flex min-h-0 flex-1 flex-col">
      <SheetCanvas
        key={book.key}
        snapshot={book.snapshot as never}
        // Editable while the line is down: the edits wait and go when the sheet is back. Read only while the grid is put right from the sheet, and while no more edits can wait.
        readOnly={!edits || status.syncing || status.full}
        // A guest changes no filter: the service takes none from one, so the grid offers none.
        filter={false}
        // The sheet's charts and pictures, to see: the row offers a guest none of their controls, so he changes none.
        objects={readObjectsResource(book.snapshot as never) ?? undefined}
        media={async (part) => {
          const got = media.current.get(part);
          if (!got) throw new Error("That picture is not in the sheet.");
          return new Blob([got.bytes as BlobPart], { type: got.type });
        }}
        // A list's drop-down and a validation's refusal are drawn in work-kit's own chrome, as in the app.
        dataChrome
        presence={presence}
        onSelection={(s) => line.current?.select(s ? { sheet: s.sheet, range: { startRow: s.range.startRow, endRow: s.range.endRow, startColumn: s.range.startColumn, endColumn: s.range.endColumn } } : null)}
        onReady={(h) => {
          handle.current = h;
          setGrid(h);
          if (!h) return;
          if (edits)
            h.onMutation((made) => {
              // The sheet's own mutations only: the grid's cell editor runs a document of its own, and its steps are not the sheet's.
              const m = made as unknown as Mutation;
              if (!m.id.startsWith("sheet.mutation.") || (m.params as { unitId?: unknown })?.unitId !== at.current.unit) return;
              const workbook = h.api.getActiveWorkbook();
              // A fill's cells after the first carry a shared formula's id and no text: each is sent with its own formula, read from the grid.
              const formula = (sheet: string, row: number, col: number): string | null => workbook?.getSheetBySheetId(sheet)?.getRange(row, col).getFormula() || null;
              // The grid holds the write already: each value goes with the type the grid gave it.
              const typeOf = (sheet: string, row: number, col: number): number | null => (workbook?.getSheetBySheetId(sheet)?.getSheet().getCellRaw(row, col)?.t as number | null | undefined) ?? null;
              const typed = typedCells(plainCells(m, formula), typeOf);
              // A guest's write is cut by the service to what a guest may send: the page cuts it the same way first, so the sheet commits what was sent.
              const sent = guest ? guestCells([typed])[0]! : typed;
              // The session never lays this page's own op when it comes back: the grid is made to hold the write as it was sent.
              const fix = cutFix(typedCells(m, typeOf), sent);
              if (fix) h.apply([fix] as never);
              editedSince.current = true;
              line.current?.local(sent);
            });
          // The grid the session asked for last stands: what landed meanwhile, and this page's own unsent edits, are laid on it.
          if (book.key === at.current.want) line.current?.ready();
        }}
        className="min-h-0 flex-1"
      />
      </div>
    </>
  );
}

/** The guest's own machine: which key the row's hints name. */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

/**
 * A typed cell as the service takes a guest's: a value, a formula, a style, a type. The grid's
 * editor hands back rich text (`p`) for what was typed; its words become the value, a number
 * when they read as one. A filled cell that names a shared formula by id alone (`si`) takes its
 * own formula's text from the grid (`formula`): the service keeps no id, so without the text the
 * owner would get an empty cell where the guest sees a formula.
 */
export function plainCells(m: Mutation, formula?: (sheet: string, row: number, col: number) => string | null): Mutation {
  if (m.id !== "sheet.mutation.set-range-values") return m;
  const cells = (m.params.cellValue ?? {}) as Record<string, Record<string, Record<string, unknown> | null>>;
  const sheet = typeof m.params.subUnitId === "string" ? m.params.subUnitId : "";
  const out: typeof cells = {};
  for (const [r, cols] of Object.entries(cells)) {
    out[r] = {};
    for (const [c, cell] of Object.entries(cols ?? {})) {
      if (cell && cell.si != null && cell.f == null) {
        const f = formula?.(sheet, Number(r), Number(c)) ?? null;
        if (f) {
          const { si: _id, ...rest } = cell;
          out[r]![c] = { ...rest, f };
          continue;
        }
      }
      if (!cell || !("p" in cell) || cell.v != null || cell.f != null) {
        out[r]![c] = cell;
        continue;
      }
      const { p, ...rest } = cell as { p?: { body?: { dataStream?: string } } };
      const words = (p?.body?.dataStream ?? "").replace(/\r?\n$/, "").replace(/\r/g, "");
      const n = words.trim() !== "" && Number.isFinite(Number(words)) ? Number(words) : null;
      out[r]![c] = { ...rest, v: n ?? words, ...(n !== null ? { t: 2 } : { t: 1 }) };
    }
  }
  return { ...m, params: { ...m.params, cellValue: out } };
}

