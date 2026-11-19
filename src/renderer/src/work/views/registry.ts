import type { ComponentType, ReactNode } from "react";
import type { ContextChip, SectorKey } from "@shared/work";
import type { IconComponent } from "../../chrome/icons";
import type { Chunk } from "../../lib/lazyChunk";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import type { LifeosSession } from "../shell/lifeos";
import { agendaView } from "../agenda/view";
import { docsView } from "../docs/view";
import { mailView } from "../mail/view";
import { tasksView } from "../tasks/view";

/**
 * The four rows over a linked Work workspace's projects (architecture §7.3):
 * Mail, Tasks, Agenda and Docs. A row opens its view in the main pane under
 * the thread strip. One closed list; each pillar fills its own `view.ts`
 * (milestones 23 and 25, and Docs after them) and edits nothing here.
 */
export type WorkViewId = "mail" | "tasks" | "agenda" | "docs";

export interface WorkViewProps {
  env: string;
  workspace: WorkspaceMeta;
  sector: SectorKey;
  /** The LifeOS session for this workspace's sector: its Convex client, fed JWTs narrowed to the sector. */
  lifeos: LifeosSession;
  /** A new thread's composer, here, with the chip in it; nothing runs until the person sends. */
  startThread(about: ContextChip): void;
}

/** What a view's chunk exports: its body, and optionally the controls its header carries after its name (a search, a segment, its verb). */
export interface WorkViewModule {
  View: ComponentType<WorkViewProps>;
  Head?: (props: WorkViewProps) => ReactNode;
}

export interface WorkViewDef {
  id: WorkViewId;
  label: string;
  icon: IconComponent;
  order: number;
  /** The row's one muted trailing fact ("4 unread", "2:00 PM"), or null for none. */
  fact(workspace: WorkspaceMeta): string | null;
  chunk: Chunk<WorkViewModule>;
}

export const WORK_VIEWS: Record<WorkViewId, WorkViewDef> = {
  mail: mailView,
  tasks: tasksView,
  agenda: agendaView,
  docs: docsView,
};

/** The views in their rows' order. */
export const workViewList = (): WorkViewDef[] => Object.values(WORK_VIEWS).sort((a, b) => a.order - b.order);
