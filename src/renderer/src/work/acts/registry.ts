import type { ComponentType } from "react";
import type { ActKind, HeldItem } from "@shared/work";
import type { Chunk } from "../../lib/lazyChunk";
import { outboxActs } from "../outbox/act";
import { mailActs } from "../mail/act";
import { agendaActs } from "../agenda/act";
import { browserActs } from "../browser/act";
import { officeActs } from "../office/act";
import { guestsActs } from "../guests/act";
import { googleActs } from "../google/act";
import { formsActs } from "../forms/act";
import { frameioActs } from "../frameio/act";
import { messagesActs } from "../messages/act";

/**
 * How each kind of held act is shown (docs/agents/work-outbox.md): one view
 * per act kind, in the folder of the pillar that owns the kind
 * (`ACT_PILLAR` in src/shared/work/acts.ts, `work/<pillar>/act.ts`). The
 * Outbox draws a held item with exactly what will go; a kind with no view
 * of its own takes the generic one, so every held item shows before its
 * pillar is built. A pillar fills its own file and edits nothing here.
 */

/** What a kind's own view of a held item is handed. */
export interface ActViewProps {
  item: HeldItem;
  /** The host that holds the item. */
  env: string;
}

export interface ActKindView {
  kind: ActKind;
  /** The kind's own view of what will go; null: the generic view (the summary and the payload as text). */
  chunk: Chunk<{ View: ComponentType<ActViewProps> }> | null;
}

/** What a pillar's `act.ts` exports: a view for each kind it owns. */
export type ActViews = Partial<{ [K in ActKind]: ActKindView & { kind: K } }>;

/** Every act kind, once. A kind no pillar's file lists fails typecheck. */
export const ACT_VIEWS: Record<ActKind, ActKindView> = {
  ...outboxActs,
  ...mailActs,
  ...agendaActs,
  ...browserActs,
  ...officeActs,
  ...guestsActs,
  ...googleActs,
  ...formsActs,
  ...frameioActs,
  ...messagesActs,
};
