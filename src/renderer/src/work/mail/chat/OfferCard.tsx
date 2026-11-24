import { useMemo, type ReactNode } from "react";
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
import { DownLine } from "../../shell/DownLine";
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
    <OfferSession sessionId={sessionId} env={host} offer={offer}>
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
 * kept above the gate (`AddKeeper`): a drop swaps the card for its line, never the form he has open.
 */
function OfferSession({ sessionId, env, offer, children }: { sessionId: string; env: string; offer: MailOffer; children(at: OfferAt): ReactNode }) {
  const meta = useSessionMeta(sessionId);
  const workspace = useWorkspaces().find((w) => w.id === meta?.workspaceId);
  const sector = (workspace?.sector ?? null) as SectorKey | null;
  const lifeos = useLifeosSession(env, sector);
  if (!workspace || !sector) return null;
  const at = { sessionId, workspaceId: workspace.id, sector };
  const card = !lifeos.client ? (
    sessionWaits(lifeos) ? (
      <CardBones />
    ) : (
      <SessionLine session={lifeos} env={env} sector={sector} />
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
      <AddKeeper {...("task" in offer ? { task: offer.task } : { event: offer.event })} at={at} session={lifeos}>
        {card}
      </AddKeeper>
    );
  return card;
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
