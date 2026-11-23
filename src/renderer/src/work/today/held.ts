import { createElement, useEffect, useMemo } from "react";
import type { SectorKey } from "@shared/work";
import { dayTime } from "../../lib/duration";
import { KindGlyph, rowWords } from "../outbox/OutboxView";
import { loadHost, loadOutbox, useOutbox, type HostItem } from "../outbox/store";
import { openHeld } from "./store";
import type { TodayAnswer, TodayEnv, TodayRow, TodaySection, TodaySource } from "./types";

/**
 * Waiting on you: what waits on his press in the Outbox, on every host, as
 * the Outbox's own store has it (live from boot on the `work.outbox` push).
 * A row opens the item whole in a sheet over the page (HeldSheet.tsx), where
 * the Outbox's own Send, Edit and Discard are: Today adds no way to send.
 */

const SECTION: TodaySection = { id: "held", title: "Waiting on you", order: 10, empty: "Nothing waits on your press", fold: 5, bones: "lines" };

/** A held item's row key: the same on every surface that names it. */
export const heldKey = (item: Pick<HostItem, "environmentId" | "ref">): string => `held:${item.environmentId}:${item.ref.at}:${item.ref.id}`;

const glyphs = new Map<string, NonNullable<TodayRow["lead"]> & { kind: "glyph" }>();
/** The Outbox's glyph for a kind, one stable component a kind, so a row's lead never remounts. */
function leadOf(kind: HostItem["kind"]): TodayRow["lead"] {
  let lead = glyphs.get(kind);
  if (!lead) {
    const Glyph = ({ className }: { className?: string }) => createElement(KindGlyph, { kind, className });
    glyphs.set(kind, (lead = { kind: "glyph", glyph: Glyph }));
  }
  return lead;
}

const dates = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/**
 * When an item was held, as a time: "7:42 AM" today, "Sun 7:40 PM" within
 * the last six days, the date alone before that. Never a bare date for
 * yesterday's: in this column a bare date is what a late task's due date
 * looks like.
 */
export function heldWhen(ts: number, now = Date.now()): string {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0);
  return Math.round((day(now) - day(ts)) / 86_400_000) < 7 ? dayTime(ts, now) : dates.format(ts);
}

/**
 * The held items as rows, oldest first: the act, what it is about, when it
 * was held. `jobOf` names the item's own workspace: two hosts may hold a
 * workspace for one sector under different names, and the row must name
 * the one its sheet will.
 */
export function heldRows(waiting: readonly HostItem[], now = Date.now(), jobOf: (item: HostItem) => string | undefined = () => undefined): TodayRow[] {
  return waiting.map((item) => {
    const key = heldKey(item);
    const job = jobOf(item);
    const { act, about } = rowWords(item);
    const detail = item.state === "failed" ? (item.error ?? "Couldn't send") : item.state === "sending" ? "Sending" : (about ?? item.account ?? undefined);
    return {
      key,
      section: SECTION.id,
      sector: (item.sector as SectorKey | null) ?? null,
      ...(job ? { job } : {}),
      title: act,
      ...(detail ? { detail } : {}),
      ...(item.state === "failed" ? { detailLate: true } : {}),
      at: item.createdAt,
      when: heldWhen(item.createdAt, now),
      lead: leadOf(item.kind),
      open: () => openHeld(key),
    };
  });
}

function useHeld(env: TodayEnv): TodayAnswer {
  const outbox = useOutbox();
  useEffect(() => {
    void loadOutbox();
  }, []);
  const jobs = env.workspaces;
  return useMemo(
    () => ({
      rows: heldRows(outbox.waiting, Date.now(), (item) => jobs.find((w) => w.environmentId === item.environmentId && w.workspaceId === item.workspaceId)?.name),
      loading: !outbox.loaded,
      failed: outbox.errors.map((e) => ({ ...e, retry: () => loadHost(e.environmentId) })),
    }),
    [outbox, jobs],
  );
}

export const source: TodaySource = { id: "held", section: SECTION, use: useHeld };
