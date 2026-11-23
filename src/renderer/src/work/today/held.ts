import { createElement, useEffect, useMemo } from "react";
import type { SectorKey } from "@shared/work";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { WORK_CHATS_KEY } from "../outbox/model";
import { KindGlyph, rowWords } from "../outbox/OutboxView";
import { loadHost, loadOutbox, useOutbox, type HostItem } from "../outbox/store";
import { heldWhen } from "../outbox/when";
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

/**
 * The place a held item is in, as its row and its sheet both name it: Work
 * Chats for an item of no workspace, else the workspace's own name
 * (`nameOf`, by host and id), or none where the window does not know it.
 */
export function placeOf(item: Pick<HostItem, "environmentId" | "workspaceId">, nameOf: (environmentId: string, workspaceId: string) => string | undefined): string | undefined {
  return !item.workspaceId || item.workspaceId === WORK_CHATS_KEY ? "Work Chats" : nameOf(item.environmentId, item.workspaceId);
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
  // Every workspace the window knows, as the sheet reads them: the row and the sheet name one place.
  const catalog = useWorkspaces();
  // The day is one of the row's inputs: a time held "7:42 AM" names its day once the day has turned.
  const day = env.day.from;
  return useMemo(
    () => ({
      rows: heldRows(outbox.waiting, Date.now(), (item) => placeOf(item, (environmentId, workspaceId) => catalog.find((w) => w.environmentId === environmentId && w.id === workspaceId)?.name)),
      loading: !outbox.loaded,
      failed: outbox.errors.map((e) => ({ ...e, retry: () => loadHost(e.environmentId) })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `day`: the rows' times are read again when the day turns
    [outbox, catalog, day],
  );
}

export const source: TodaySource = { id: "held", section: SECTION, use: useHeld };
