import { useEffect, useState } from "react";
import type { ReviewReady } from "@shared/contract-work-review";
import { weekOf, weekWords } from "@shared/work/review";
import { registry } from "../../lib/connection";
import type { TodayRow, TodaySource } from "../today/types";
import { openReview } from "./open";
import { reviewZone } from "./store";

/**
 * The review on Today (docs/agents/work-today.md "Adding to Today"): one row
 * under "Also" while a review the Friday routine made waits unopened
 * (`work.review.ready` on each host with a job, the newest week winning),
 * gone once he opens it. Its press opens the page at that week. The key is
 * the digest's (`review:<from>`), so the two never show one thing twice.
 */
const DAY = 24 * 60 * 60_000;

/** The row's words: which week it is, said from today. */
export function readyTitle(from: number, now: number, tz: string): string {
  const now0 = weekOf(now, tz).from;
  if (from === now0) return "This week's review is ready";
  if (from === weekOf(now0 - DAY, tz).from) return "Last week's review is ready";
  return "A week's review is ready";
}

export const readyRow = (ready: NonNullable<ReviewReady>, now: number, tz: string): TodayRow => ({
  key: `review:${ready.from}`,
  section: "also",
  sector: null,
  title: readyTitle(ready.from, now, tz),
  detail: weekWords({ from: ready.from }, tz),
  at: ready.madeAt,
  open: () => openReview({ week: ready.from }),
});

export const source: TodaySource = {
  id: "review",
  use(env) {
    // One ask a host that has a job and is linked, asked again when it says a review was made or opened.
    const hosts = [...new Set(env.workspaces.filter((w) => w.open).map((w) => w.environmentId))].sort().join("\n");
    const [ready, setReady] = useState<Record<string, ReviewReady>>({});
    useEffect(() => {
      let live = true;
      const ids = hosts ? hosts.split("\n") : [];
      const ask = (id: string): void =>
        void registry
          .linkOf(id)
          .request<ReviewReady>("work.review.ready", {})
          .then(
            (got) => live && setReady((all) => ({ ...all, [id]: got })),
            // A host from before the review, or one that did not answer: it has no review to name.
            () => live && setReady((all) => ({ ...all, [id]: null })),
          );
      setReady({});
      const offs = ids.map((id) => {
        ask(id);
        return registry.linkOf(id).onPush((push) => {
          if (push.push === "work.review") ask(id);
        });
      });
      return () => {
        live = false;
        for (const off of offs) off();
      };
    }, [hosts]);
    const newest = Object.values(ready).reduce<NonNullable<ReviewReady> | null>((best, r) => (r && (!best || r.from > best.from) ? r : best), null);
    // Until every host asked has answered, a review may yet be waiting: the page is not "All clear" before it knows.
    const out = hosts !== "" && hosts.split("\n").some((id) => !(id in ready));
    return { rows: newest ? [readyRow(newest, env.day.from, reviewZone())] : [], ...(out ? { loading: true } : {}) };
  },
};
