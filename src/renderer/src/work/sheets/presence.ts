import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GridSelection, SheetPresence } from "work-kit/sheet";
import type { SheetPerson } from "@shared/contract-work-sheets";
import type { CanvasShell, Presence } from "../canvas/kind";
import type { SheetHost } from "./host";

/**
 * Who else is on a live sheet, for the desktop grid (docs/agents/work-sheets.md "Live editing"). The grid is on no
 * socket of the sheet: it says its selection through its host when it changed, four times a second at most, and
 * hears everyone else's in the `work.sheets` push. Each is drawn on the grid in their hue with their name, as the
 * Work service names them, and their faces go to the pane's bar, as a document's do.
 */

/** A selection is said this often at most. */
export const SAY_EVERY_MS = 250;
/** And said again this often with no change, so a grid left open stays on the sheet (the service lets one go after half an hour's silence). */
export const SAY_AGAIN_MS = 10 * 60_000;

type Said = { sheet: string; range: SheetPerson["range"] } | null;
const boxOf = (s: GridSelection | null): Said => (s ? { sheet: s.sheet, range: { startRow: s.range.startRow, endRow: s.range.endRow, startColumn: s.range.startColumn, endColumn: s.range.endColumn } } : null);

/** One face a person, whichever of their windows holds a selection. */
export function facesOf(people: readonly SheetPerson[]): Presence[] {
  const faces = new Map<string, Presence>();
  for (const p of people) faces.set(`${p.name}|${p.hue}`, { id: p.id, name: p.name, hue: ((((p.hue - 1) % 8) + 8) % 8 + 1) as NonNullable<Presence["hue"]> });
  return [...faces.values()];
}

export function useSheetPresence(host: SheetHost, live: boolean, shell: Pick<CanvasShell, "presence">): { presence: SheetPresence[]; onSelection(selection: GridSelection | null): void } {
  const [people, setPeople] = useState<SheetPerson[]>([]);
  const at = useRef<{ now: Said; said: string | null; timer: ReturnType<typeof setTimeout> | null; on: boolean }>({ now: null, said: null, timer: null, on: false });

  useEffect(() => {
    const say = host.presence?.bind(host);
    if (!live || !say) return;
    const s = at.current;
    s.on = true;
    s.said = null;
    let stopped = false;
    const heard = (got: { people: SheetPerson[] }): void => void (!stopped && setPeople(got.people));
    // Who is here already; then this grid's own selection, if it has one.
    void say(s.now ?? {}).then(heard, () => {});
    s.said = JSON.stringify(s.now);
    const off = host.onPush((push) => push.presence && heard({ people: push.presence }));
    const again = setInterval(() => void (s.now && say(s.now).then(heard, () => {})), SAY_AGAIN_MS);
    return () => {
      stopped = true;
      s.on = false;
      off();
      clearInterval(again);
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
      // The canvas is going: its selection leaves the sheet with it.
      void say({ range: null }).catch(() => {});
      setPeople([]);
    };
  }, [host, live]);

  useEffect(() => {
    shell.presence(facesOf(people));
  }, [shell, people]);
  useEffect(() => () => shell.presence([]), [shell]);

  const onSelection = useCallback(
    (selection: GridSelection | null) => {
      const s = at.current;
      s.now = boxOf(selection);
      if (!s.on || s.timer || JSON.stringify(s.now) === s.said) return;
      s.timer = setTimeout(() => {
        s.timer = null;
        const next = JSON.stringify(s.now);
        if (!s.on || next === s.said) return;
        s.said = next;
        void host.presence?.(s.now ?? { range: null }).then((got) => setPeople(got.people), () => {});
      }, SAY_EVERY_MS);
    },
    [host],
  );

  const presence = useMemo<SheetPresence[]>(() => people.map((p) => ({ id: p.id, name: p.name, hue: p.hue, range: { sheet: p.sheet, ...p.range } })), [people]);
  return { presence, onSelection };
}
