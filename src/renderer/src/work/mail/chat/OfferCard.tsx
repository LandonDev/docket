import { useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ConvexProvider } from "convex/react";
import { MailClientProvider, MailKitProvider } from "work-kit/mail";
import "work-kit/mail/styles.css";
import "../mail.css";
import type { SectorKey } from "@shared/work";
import { mailOfferOf, type MailOffer } from "@shared/work/mailChat";
import type { Block } from "../../../lib/session";
import { useSessionMeta } from "../../../lib/tcserver/store";
import { useWorkspaces } from "../../../lib/tcserver/workspaces";
import { useTranscriptHost, useTranscriptSession } from "../../../surfaces/transcriptSession";
import { sessionWaits, useLifeosSession, type LifeosSession } from "../../shell/lifeos";
import { DownLine, HostLine } from "../../shell/DownLine";
import { useHostLive } from "../../shell/lifeosLive";
import { mailClientFor } from "../client";
import { tempcodeMailKit } from "../kit";
import { AddKeeper, AddRow } from "./AddRow";
import { CardBones } from "./cardParts";
import { DraftCard } from "./DraftCard";
import { RewriteCard } from "./RewriteCard";
import { RowsCard } from "./RowsCard";

/**
 * A mail chat's answer as mail's own thing (docs/DESIGN.md "The Mail view", the chat's cards): `mail_offer`'s card
 * in the transcript, drawn over the window's own session for the thread's sector. Every press is his, the road
 * Mail's own buttons take; nothing here sends, schedules or archives by itself.
 */
export function MailOfferRow({ block }: { block: Block }) {
  const offer = useMemo(() => offerOfBlock(block), [block]);
  const sessionId = useTranscriptSession();
  const host = useTranscriptHost();
  if (!offer || !sessionId || !host) return null;
  return (
    <OfferSession sessionId={sessionId} env={host} offer={offer} cardKey={`${sessionId}:${block.id}`}>
      {(at) => <OfferCard offer={offer} at={at} />}
    </OfferSession>
  );
}

/** Where a card acts: the thread, its workspace and that workspace's sector. */
export interface OfferAt {
  sessionId: string;
  workspaceId: string;
  sector: SectorKey;
}

export function OfferCard({ offer, at }: { offer: MailOffer; at: OfferAt }) {
  if ("draft" in offer) return <DraftCard draftId={offer.draft.draftId} at={at} />;
  if ("rewrite" in offer) return <RewriteCard draftId={offer.rewrite.draftId} at={at} />;
  if ("rows" in offer) return <RowsCard rows={offer.rows} />;
  if ("task" in offer) return <AddRow task={offer.task} at={at} />;
  return <AddRow event={offer.event} at={at} />;
}

/**
 * The window's LifeOS session for the thread's sector, with Mail's client over it. A proposed task's or event's form is
 * kept above the gate (`AddKeeper`): a drop swaps the card for its line, never the form he has open. Of a thread's cards
 * whose session is down, or whose host said its LifeOS is connecting, one says the line (`useSaysLine`): the state with
 * its press, or the named wait with none; the rest draw nothing until it is back. A status not heard yet keeps the bones.
 */
function OfferSession({ sessionId, env, offer, cardKey, children }: { sessionId: string; env: string; offer: MailOffer; cardKey: string; children(at: OfferAt): ReactNode }) {
  const meta = useSessionMeta(sessionId);
  const workspace = useWorkspaces().find((w) => w.id === meta?.workspaceId);
  const sector = (workspace?.sector ?? null) as SectorKey | null;
  const lifeos = useLifeosSession(env, sector);
  const down = !!sector && !lifeos.client && !sessionWaits(lifeos);
  const host = useHostLive(env);
  const waits = !!sector && !lifeos.client && !down && host.waits;
  const says = useSaysLine(down || waits ? `${sessionId}|${env}|${sector}` : null, cardKey);
  if (!workspace || !sector) return null;
  const at = { sessionId, workspaceId: workspace.id, sector };
  const card = !lifeos.client ? (
    !down && !waits ? (
      <CardBones />
    ) : !says ? null : down ? (
      <SessionLine session={lifeos} env={env} sector={sector} />
    ) : (
      <HostLine data-offer-session live={host} className="text-xs" />
    )
  ) : (
    <ConvexProvider client={lifeos.client}>
      <MailClientProvider client={mailClientFor(env, lifeos.client.url, sector)}>
        <MailKitProvider kit={tempcodeMailKit}>{children(at)}</MailKitProvider>
      </MailClientProvider>
    </ConvexProvider>
  );
  if ("task" in offer || "event" in offer)
    return (
      <AddKeeper {...("task" in offer ? { task: offer.task } : { event: offer.event })} at={at} session={lifeos} cardKey={cardKey}>
        {card}
      </AddKeeper>
    );
  return card;
}

// A thread's cards whose session is down, by thread, host and sector, in the order they went down: the first says
// the line, so one outage is said once however many cards it stops (the owner's rule: the state once a screen).
const downCards = new Map<string, readonly string[]>();
const downHeard = new Set<() => void>();
const hearDown = (listener: () => void): (() => void) => {
  downHeard.add(listener);
  return () => void downHeard.delete(listener);
};
function putDown(scope: string, cards: readonly string[]): void {
  if (cards.length) downCards.set(scope, cards);
  else downCards.delete(scope);
  for (const listener of downHeard) listener();
}

/**
 * Whether this card says its down session's line: the first of its thread's down cards does, the rest do not. Taken
 * before paint, so a second card never shows the line for a frame. A card that leaves (scrolled out, or its session
 * back) hands the line to the next.
 */
export function useSaysLine(scope: string | null, card: string): boolean {
  useLayoutEffect(() => {
    if (!scope) return;
    putDown(scope, [...(downCards.get(scope) ?? []), card]);
    return () => putDown(scope, (downCards.get(scope) ?? []).filter((c) => c !== card));
  }, [scope, card]);
  return useSyncExternalStore(hearDown, () => {
    if (!scope) return false;
    const first = downCards.get(scope)?.[0];
    return first === undefined || first === card;
  });
}

/**
 * Why the card cannot draw, said as every reader of a down session says it (`DownLine`, the rule in lifeosDown.ts):
 * Retry when LifeOS or the host did not answer; Sign in, Show the code or Open Settings where this window may make
 * them, else who can; none for a computer kept from LifeOS.
 */
export function SessionLine({ session, env, sector }: { session: Pick<LifeosSession, "state" | "withheld" | "unanswered">; env: string; sector: SectorKey }) {
  return <DownLine data-offer-session session={{ ...session, environmentId: env, sector, client: null }} className="text-xs" />;
}

/** `mail_offer`'s result, whichever envelope the harness kept it in: the JSON text, its structured content, a text part. */
export function offerOfBlock(block: Block): MailOffer | null {
  if (block.role !== "tool" || block.tool?.status !== "completed" || !block.tool.detail) return null;
  try {
    return offerIn(JSON.parse(block.tool.detail));
  } catch {
    return null;
  }
}

function offerIn(value: unknown): MailOffer | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if ("mailOffer" in record) return mailOfferOf(record);
  if (typeof record.structuredContent === "object" && record.structuredContent && "mailOffer" in record.structuredContent) return mailOfferOf(record.structuredContent);
  const part = Array.isArray(record.content) ? record.content.find((c): c is { type: "text"; text: string } => (c as { type?: unknown })?.type === "text") : undefined;
  if (!part) return null;
  try {
    return offerIn(JSON.parse(part.text));
  } catch {
    return null;
  }
}
