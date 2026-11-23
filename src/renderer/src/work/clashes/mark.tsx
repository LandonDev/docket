import { useMemo } from "react";
import { clashLine, listFrom, type Clash, type LifeosRange } from "@shared/work/clashes";
import type { SectorKey } from "@shared/work";
import { TruncateTip } from "../../components/tip";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { useLifeosQuery, useLifeosSession } from "../shell/lifeos";
import { marksOf, NO_MARKS, type ClashMarks } from "./model";
import { openClash } from "./open";

/**
 * Clashes on the events a view shows (docs/agents/work-clashes.md): read as him,
 * every job at once, since a clash is across jobs and a view's own session reads
 * one. Each side carries this host's Work workspace for its job.
 */
export function useClashes(environmentId: string, from: number, to: number): ClashMarks {
  const session = useLifeosSession(environmentId, null);
  const read = useLifeosQuery<LifeosRange>(session, "clashes:range", { from, to });
  const workspaces = useWorkspaces();
  const range = read.status === "ready" ? read.value : null;
  return useMemo(() => {
    if (!range) return NO_MARKS;
    const homes = new Map<SectorKey, string>();
    for (const w of workspaces) if (w.environmentId === environmentId && w.kind === "work" && w.sector && !homes.has(w.sector)) homes.set(w.sector, w.id);
    return marksOf(listFrom(range, (sector) => homes.get(sector)));
  }, [range, workspaces, environmentId]);
}

/**
 * The clash on an event's row: one line in the colour that says he is needed,
 * in the words of that event's side. It is a button; it opens the Clash dialog.
 */
export function ClashLine({ clashes, eventId, environmentId }: { clashes: readonly Clash[]; eventId: string; environmentId: string }) {
  const first = clashes[0];
  if (!first) return null;
  const more = clashes.length - 1;
  const words = `${clashLine(first, eventId)}${more > 0 ? `, and ${more} more` : ""}`;
  return (
    <TruncateTip text={words}>
      <button
        type="button"
        data-clash={first.id}
        className="relative max-w-full cursor-pointer self-start truncate rounded-sm text-left text-xs text-warning hover:underline hover:underline-offset-2"
        onClick={() => openClash({ id: first.id, environmentId, clash: first })}
      >
        {words}
      </button>
    </TruncateTip>
  );
}
