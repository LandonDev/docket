import type { ComponentType, ReactNode } from "react";
import type { ContextChip, SectorKey } from "@shared/work";
import type { IconComponent } from "../../chrome/icons";
import type { Chunk } from "../../lib/lazyChunk";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import type { LifeosSession } from "../shell/lifeos";
import { agendaView } from "../agenda/view";
import { docsView } from "../docs/view";
import { filesView } from "../office/view";
import { mailView } from "../mail/view";
import { routinesView } from "../routines/view";
import { tasksView } from "../tasks/view";

/**
 * The rows over a linked Work workspace's projects (architecture §7.3):
 * Mail, Tasks, Agenda, Docs and Files (Teams files, docs/agents/work-files.md), then Routines (milestone 32). A row opens its view in the main pane under
 * the thread strip. One closed list; each pillar fills its own `view.ts`
 * (milestones 23 and 25, and Docs after them) and edits nothing here.
 */
export type WorkViewId = "mail" | "tasks" | "agenda" | "docs" | "files" | "routines";

export interface WorkViewProps {
  env: string;
  workspace: WorkspaceMeta;
  sector: SectorKey;
  /** The LifeOS session for this workspace's sector: its Convex client, fed JWTs narrowed to the sector. */
  lifeos: LifeosSession;
  /** A new thread's composer with the chip in it (or each of several, up to the composer's eight), here or, given `at`, in that code workspace and project; nothing runs until the person sends. */
  startThread(about: ContextChip | readonly ContextChip[], at?: { cwd: string; projectId: string | null }): void;
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
  /** The fact as a hook, for one that reads LifeOS live; called once per row on every column render, in place of `fact`. */
  useFact?: (workspace: WorkspaceMeta, sector: SectorKey) => string | null;
  /** Whether the view reads LifeOS. Every view says: true puts it behind LifeOS's sign-in and its "did not answer" line; false (Routines, Files: the host's own data) never is. */
  readsLifeos: boolean;
  chunk: Chunk<WorkViewModule>;
}

export const WORK_VIEWS: Record<WorkViewId, WorkViewDef> = {
  mail: mailView,
  tasks: tasksView,
  agenda: agendaView,
  docs: docsView,
  files: filesView,
  routines: routinesView,
};

/** The views in their rows' order. */
export const workViewList = (): WorkViewDef[] => Object.values(WORK_VIEWS).sort((a, b) => a.order - b.order);
