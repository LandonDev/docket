import type { ComponentType, ReactNode } from "react";
import type { ContextChip, SectorKey } from "@shared/work";
import type { IconComponent } from "../../chrome/icons";
import type { Chunk } from "../../lib/lazyChunk";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import type { LifeosSession } from "../shell/lifeos";
import { agendaView } from "../agenda/view";
import { filesView } from "../files/view";
import { formsView } from "../msforms/view";
import { mailView } from "../mail/view";
import { messagesView } from "../messages/view";
import { peopleView } from "../people/view";
import { prepView } from "../prep/view";
import { moneyView } from "../money/view";
import { projectsView } from "../projects/view";
import { playsView } from "../routines/plays/view";
import { routinesView } from "../routines/view";
import { tasksView } from "../tasks/view";
import { templatesView } from "../templates/view";

/**
 * The rows over a linked Work workspace's projects (architecture §7.3):
 * Mail, Messages (docs/agents/work-messages.md), Tasks, Projects (the project screens, docs/agents/work-projects.md), Agenda, People (docs/agents/work-people.md), Files (the Files place, docs/agents/work-files.md, where the Docs view folded in), Plays (docs/agents/work-plays.md), then Routines (milestone 32). A row opens its view in the main pane under
 * the thread strip. One closed list; each pillar fills its own `view.ts`
 * (milestones 23 and 25, and the rest after them) and edits nothing here.
 */
export type WorkViewId = "mail" | "messages" | "tasks" | "projects" | "agenda" | "prep" | "people" | "money" | "files" | "forms" | "templates" | "plays" | "routines";

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
  /** In place of the view's name in the header, for a view that stands somewhere inside itself: the way back from a project's page. Until the chunk lands the header shows the name. */
  Title?: (props: WorkViewProps) => ReactNode;
  /**
   * A form he has open over the view (New task, New event), drawn by the frame beside the body, never inside it: a
   * session that drops takes the body away, never what he typed. The form says the session's line itself (`DownLine`)
   * and holds its submit until the session is back.
   */
  Kept?: (props: WorkViewProps) => ReactNode;
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
  /** The view draws its own head (Mail: the list's head and the reader's toolbar), so the frame draws no 40px header over it. The view's region still carries its name, and the header comes back over the sign-in. */
  ownHead?: true;
  /** The view stands inside another and has no row of its own (a meeting's page, inside Agenda): the column draws none for it, and its parent's row reads as open while it shows. */
  inside?: WorkViewId;
  chunk: Chunk<WorkViewModule>;
  /** The bones the frame draws while the chunk loads, in the shape of what lands (Mail's list beside its pane, a meeting's or a
   * project's page); with none, rows. */
  bones?: (workspace: WorkspaceMeta) => ReactNode;
}

export const WORK_VIEWS: Record<WorkViewId, WorkViewDef> = {
  mail: mailView,
  messages: messagesView,
  tasks: tasksView,
  projects: projectsView,
  agenda: agendaView,
  prep: prepView,
  people: peopleView,
  money: moneyView,
  files: filesView,
  forms: formsView,
  templates: templatesView,
  plays: playsView,
  routines: routinesView,
};

/**
 * Whether the Templates row stands in the column (docs/agents/work-templates.md
 * "The row"). On since Files' new view landed: a made file opens in a Files tab
 * there. Set false and the shelf is reached from Files' New alone (the owner's
 * ruling 1 in the templates plan: the row is one line to drop).
 */
export const TEMPLATES_ROW = true;

/** The views in their rows' order. */
export const workViewList = (): WorkViewDef[] => Object.values(WORK_VIEWS).sort((a, b) => a.order - b.order);

/** The views the column draws a row for: every one that does not stand inside another, and Templates only once its row is on (`TEMPLATES_ROW`). */
export const workViewRows = (): WorkViewDef[] => workViewList().filter((view) => !view.inside && (TEMPLATES_ROW || view.id !== "templates"));

/** The column's four daily views, in their rows' order: Mail, Tasks, Agenda, Messages (docs/agents/work.md "The column"). */
export const DAILY_VIEWS: readonly WorkViewId[] = ["mail", "tasks", "agenda", "messages"];

/**
 * The column's view rows: the four daily ones, then the rest behind its More fold (People, Money, Files, Forms,
 * Templates, Plays, Routines), each in its `order`. Projects has no row of either: the Projects heading over the
 * job's projects opens its view.
 */
export function workColumnViews(): { daily: WorkViewDef[]; more: WorkViewDef[] } {
  const rows = workViewRows();
  const daily = DAILY_VIEWS.map((id) => rows.find((view) => view.id === id)).filter((view): view is WorkViewDef => !!view);
  return { daily, more: rows.filter((view) => !DAILY_VIEWS.includes(view.id) && view.id !== "projects") };
}

/** The chunks of the column's other views, in the column's order: what a shown view warms behind itself (WorkViewPage.tsx). */
export const viewChunksAfter = (shown: WorkViewId): Chunk<object>[] => workViewRows().filter((view) => view.id !== shown).map((view) => view.chunk);

/** The row that reads as open for a view: its own, or the row of the view it stands inside. */
export const rowOfView = (view: string): string => (WORK_VIEWS as Record<string, WorkViewDef | undefined>)[view]?.inside ?? view;
