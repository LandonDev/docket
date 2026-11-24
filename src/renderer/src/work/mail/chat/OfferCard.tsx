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
import { sessionFailure, sessionWaits, useLifeosSession } from "../../shell/lifeos";
import { mailClientFor } from "../client";
import { tempcodeMailKit } from "../kit";
import { AddRow } from "./AddRow";
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
    <OfferSession sessionId={sessionId} env={host}>
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

/** The window's LifeOS session for the thread's sector, with Mail's client over it. */
function OfferSession({ sessionId, env, children }: { sessionId: string; env: string; children(at: OfferAt): ReactNode }) {
  const meta = useSessionMeta(sessionId);
  const workspace = useWorkspaces().find((w) => w.id === meta?.workspaceId);
  const sector = (workspace?.sector ?? null) as SectorKey | null;
  const lifeos = useLifeosSession(env, sector);
  if (!workspace || !sector) return null;
  if (!lifeos.client) {
    if (sessionWaits(lifeos)) return <CardBones />;
    return <p className="text-xs text-muted-foreground">{sessionFailure(lifeos.state) || "LifeOS did not answer"}</p>;
  }
  return (
    <ConvexProvider client={lifeos.client}>
      <MailClientProvider client={mailClientFor(env, lifeos.client.url, sector)}>
        <MailKitProvider kit={tempcodeMailKit}>{children({ sessionId, workspaceId: workspace.id, sector })}</MailKitProvider>
      </MailClientProvider>
    </ConvexProvider>
  );
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
