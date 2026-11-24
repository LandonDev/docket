import { createElement, useEffect, useMemo } from "react";
import { needsHim, type SectorKey } from "@shared/work";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { WORK_CHATS_KEY } from "../outbox/model";
import { KindGlyph, rowWords } from "../outbox/OutboxView";
import { loadHost, loadOutbox, useOutbox, wantOutboxItem, type HostItem } from "../outbox/store";
import { askedItemKeys, requestKey, useOpenRequests, type HostRequest } from "../outbox/requests";
import { Outbox } from "../../chrome/icons";
import { storeTitleOf } from "../../lib/threadMentions";
import { shell } from "../../stores/shell";
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
export function heldRows(
  waiting: readonly HostItem[],
  now = Date.now(),
  jobOf: (item: Pick<HostItem, "environmentId" | "workspaceId">) => string | undefined = () => undefined,
  requests: readonly HostRequest[] = [],
): TodayRow[] {
  // A thread's open request is one row, and opens the Outbox on it; the items it lists are not listed again.
  const asked = askedItemKeys(requests);
  const askedRows: TodayRow[] = requests.map((request) => {
    const key = `held:${requestKey(request)}`;
    const job = jobOf(request);
    const thread = storeTitleOf(request.sessionId);
    return {
      key,
      section: SECTION.id,
      sector: (request.sector as SectorKey | null) ?? null,
      ...(job ? { job } : {}),
      title: request.head,
      ...(thread ? { detail: `Asked in ${thread}` } : {}),
      at: request.createdAt,
      when: heldWhen(request.createdAt, now),
      lead: REQUEST_LEAD,
      open: () => {
        wantOutboxItem(requestKey(request));
        shell.openOutbox();
      },
    };
  });
  // The one count (shared/work/outboxCount.ts): a send under way or one he scheduled is not his to decide again.
  return [...askedRows, ...waiting.filter((item) => needsHim(item) && !asked.has(`${item.environmentId}:${item.ref.at}:${item.ref.id}`)).map((item) => {
    const key = heldKey(item);
    const job = jobOf(item);
    const { act, about } = rowWords(item);
    const detail = item.state === "failed" ? (item.error ?? "Couldn't send") : item.state === "stale" ? "Out of date" : (about ?? item.account ?? undefined);
    return {
      key,
      section: SECTION.id,
      sector: (item.sector as SectorKey | null) ?? null,
      ...(job ? { job } : {}),
      title: act,
      ...(detail ? { detail } : {}),
      ...(item.state === "failed" || item.state === "stale" ? { detailLate: true } : {}),
      at: item.createdAt,
      when: heldWhen(item.createdAt, now),
      lead: leadOf(item.kind),
      open: () => openHeld(key),
    };
  })];
}

/** A request's lead: the Outbox's own glyph, muted as every held row's (never amber). */
const REQUEST_LEAD: TodayRow["lead"] = { kind: "glyph", glyph: ({ className }) => createElement(Outbox, { className: `size-3.5 text-muted-foreground ${className ?? ""}` }) };

function useHeld(env: TodayEnv): TodayAnswer {
  const outbox = useOutbox();
  const requests = useOpenRequests();
  useEffect(() => {
    void loadOutbox();
  }, []);
  // Every workspace the window knows, as the sheet reads them: the row and the sheet name one place.
  const catalog = useWorkspaces();
  // The day is one of the row's inputs: a time held "7:42 AM" names its day once the day has turned.
  const day = env.day.from;
  return useMemo(
    () => ({
      rows: heldRows(outbox.waiting, Date.now(), (item) => placeOf(item, (environmentId, workspaceId) => catalog.find((w) => w.environmentId === environmentId && w.id === workspaceId)?.name), requests),
      loading: !outbox.loaded,
      failed: outbox.errors.map((e) => ({ ...e, retry: () => loadHost(e.environmentId) })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `day`: the rows' times are read again when the day turns
    [outbox, catalog, day, requests],
  );
}

export const source: TodaySource = { id: "held", section: SECTION, use: useHeld };
