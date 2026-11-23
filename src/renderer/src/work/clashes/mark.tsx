import { useMemo } from "react";
import { clashLine, listFrom, type Clash, type LifeosRange } from "@shared/work/clashes";
import type { SectorKey } from "@shared/work";
import { TruncateTip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { registry } from "../../lib/connection";
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
  // A view whose host this window no longer holds draws no clash, rather than asking a link that is gone.
  const session = useLifeosSession(registry.has(environmentId) ? environmentId : "", null);
  const read = useLifeosQuery<LifeosRange>(session, "clashes:range", { from, to });
  const workspaces = useWorkspaces();
  const range = read.status === "ready" ? read.value : null;
  const failed = read.status === "failed" ? read.error : null;
  return useMemo(() => {
    if (failed !== null) return { ...NO_MARKS, failed };
    if (!range) return NO_MARKS;
    const homes = new Map<SectorKey, string>();
    for (const w of workspaces) if (w.environmentId === environmentId && w.kind === "work" && w.sector && !homes.has(w.sector)) homes.set(w.sector, w.id);
    return marksOf(listFrom(range, (sector) => homes.get(sector)));
  }, [range, failed, workspaces, environmentId]);
}

/**
 * The clashes on an event's row: one line each in the colour that says he is
 * needed, in the words of that event's side. A line is a button; it opens that
 * clash's dialog, so each one named can be reached from the row.
 */
export function ClashLines({ clashes, eventId, environmentId, day }: { clashes: readonly Clash[]; eventId: string; environmentId: string; /** the day the row sits under in its list */ day?: number }) {
  return (
    <>
      {clashes.map((clash) => {
        const words = clashLine(clash, eventId, day === undefined ? {} : { on: day });
        return (
          <TruncateTip key={clash.id} text={words}>
            <Button
              variant="link"
              size="xs"
              data-clash={clash.id}
              className="h-4 max-w-full justify-start self-start rounded-sm px-0 font-normal text-warning underline-offset-2"
              onClick={() => openClash({ id: clash.id, environmentId, clash })}
            >
              <span className="truncate">{words}</span>
            </Button>
          </TruncateTip>
        );
      })}
    </>
  );
}
