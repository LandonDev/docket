import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ConvexProvider } from "convex/react";
import { Mailbox, MailClientProvider, MailKitProvider, opening, useMailClient, type ComposeState, type InboxView, type MailNav, type MailTaskRequest, type OutboxView } from "work-kit/mail";
import "work-kit/mail/styles.css";
import "./mail.css";
import { ChevronLeft } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { openWorkView } from "../../lib/workSwitch";
import { SurfaceSkeleton } from "../../surfaces/SurfaceSkeleton";
import { sessionWaits } from "../shell/lifeos";
import type { WorkViewProps } from "../views/registry";
import { mailClientFor } from "./client";
import { tempcodeMailKit } from "./kit";
import { mailChip } from "./model";

/**
 * The Mail view of a linked Work workspace (docs/agents/work-mail.md):
 * LifeOS's own mail client, on a session narrowed to the workspace's
 * sector, so it lists that sector's mail and no other. Send goes through
 * the host. The header carries Start thread for the open mail and Compose.
 * Under 640px of pane the list and the open mail take turns: opening a mail
 * shows it alone, and its Mail row goes back to the list.
 */

/** The list beside the reading pane, 300px; narrow (under 640px of pane), the list alone at full width. Literal, so Tailwind finds it. */
const LIST = "flex w-[300px] shrink-0 flex-col border-r border-border @max-[40rem]/mail:w-full @max-[40rem]/mail:border-r-0";

export interface MailPage {
  account: string | null;
  inboxView: InboxView;
  threadId: string | null;
  subject: string | null;
  view: "inbox" | OutboxView;
  sheetOpen: boolean;
  compose: ComposeState | null;
}

const BLANK: MailPage = { account: null, inboxView: "everything", threadId: null, subject: null, view: "inbox", sheetOpen: false, compose: null };

// What each workspace's Mail showed, kept while the window lives, so coming back finds the same mail open.
const pages = new Map<string, MailPage>();
const listeners = new Set<() => void>();

/** Changes what a workspace's Mail shows. Exported for the preview page, which sets a scene. */
export function patch(workspaceId: string, next: Partial<MailPage>): void {
  pages.set(workspaceId, { ...(pages.get(workspaceId) ?? BLANK), ...next });
  for (const listener of listeners) listener();
}

function usePage(workspaceId: string): MailPage {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => pages.get(workspaceId) ?? BLANK,
  );
}

const NO_TASKS: ReadonlySet<string> = new Set();

export function View(props: WorkViewProps) {
  const { lifeos, env } = props;
  const convex = lifeos.client;
  // Bones only while the session is on its way; a failed one is the frame's line, with nothing pulsing under it.
  if (!convex) return sessionWaits(lifeos) ? <MailBones /> : null;
  return (
    <ConvexProvider client={convex}>
      <MailClientProvider client={mailClientFor(env, convex.url)}>
        <MailKitProvider kit={tempcodeMailKit}>
          <MailPageBody {...props} />
        </MailKitProvider>
      </MailClientProvider>
    </ConvexProvider>
  );
}

function MailPageBody({ workspace }: WorkViewProps) {
  const id = workspace.id;
  const openTask = useCallback(() => openWorkView({ workspaceId: id, view: "tasks" }), [id]);
  return <MailScreen id={id} onOpenTask={openTask} />;
}

/** The page under its providers: the list beside the reading pane, for the workspace (or the preview) named `id`. */
export function MailScreen({ id, onOpenTask }: { id: string; onOpenTask: () => void }) {
  const page = usePage(id);
  const client = useMailClient();
  const accounts = client.useMailAccounts();
  const actions = client.useMailActions();
  const open = client.useMailThread(page.threadId);
  const subject = open?.thread.subject ?? null;
  useEffect(() => {
    if (subject !== page.subject) patch(id, { subject });
  }, [id, subject, page.subject]);

  const nav = useMemo<MailNav>(
    () => ({
      account: page.account,
      inboxView: page.inboxView,
      setInboxView: (inboxView) => patch(id, { inboxView }),
      threadId: page.threadId,
      setThreadId: (threadId) => patch(id, { threadId }),
      view: page.view,
      sheetOpen: page.sheetOpen,
    }),
    [id, page.account, page.inboxView, page.threadId, page.view, page.sheetOpen],
  );
  const setCompose = useCallback((compose: ComposeState | null) => patch(id, { compose }), [id]);
  const onTask = useCallback(
    (request: MailTaskRequest) => {
      // An open task lives in Tasks; a new one is filed from the mail at once, as LifeOS's own sheet would.
      if (request.kind === "task") onOpenTask();
      else actions.makeTask(request.threadId, request.draft);
    },
    [actions, onOpenTask],
  );
  // Narrow, the pane shows only once a mail is open or a new one is being written.
  const reading = page.threadId !== null || page.compose?.full === true;
  const back = page.threadId !== null;
  const frame = useCallback(
    ({ list, pane }: { list: ReactNode; pane: ReactNode }) => <MailFrame list={list} pane={pane} reading={reading} onBack={back ? () => patch(id, { threadId: null }) : null} />,
    [id, reading, back],
  );
  return (
    <div data-mail-kit className="tc-mail h-full min-h-0">
      <Mailbox nav={nav} accounts={accounts} compose={page.compose} setCompose={setCompose} openTaskIds={NO_TASKS} onTask={onTask} frame={frame} sectors={false} />
    </div>
  );
}

/** The list beside the reading pane; narrow, one of the two, with a Mail row back to the list while a mail is open. */
export function MailFrame({ list, pane, reading, onBack }: { list: ReactNode; pane: ReactNode; reading: boolean; onBack: (() => void) | null }) {
  return (
    <div className="@container/mail flex h-full min-h-0">
      <div data-mail-list="" className={cn(LIST, reading && "@max-[40rem]/mail:hidden")}>
        {list}
      </div>
      <div data-mail-pane="" className={cn("flex min-w-0 flex-1 flex-col", !reading && "@max-[40rem]/mail:hidden")}>
        {onBack ? (
          <div className="hidden shrink-0 px-4 pt-2 @max-[40rem]/mail:block">
            <Button variant="ghost" size="xs" onClick={onBack}>
              <ChevronLeft className="size-3.5" />
              Mail
            </Button>
          </div>
        ) : null}
        {pane}
      </div>
    </div>
  );
}

/** While the session opens: the list's rows beside the reading pane's head and lines, the frame Mail lands in. */
export function MailBones() {
  return (
    <div role="status" aria-label="Loading Mail" aria-busy className="@container/mail flex h-full min-h-0 select-none">
      <div className={LIST}>
        <SurfaceSkeleton kind="rows" count={8} />
      </div>
      <div className="min-w-0 flex-1 px-8 pt-8 @max-[40rem]/mail:hidden">
        <Skeleton className="h-4 w-64 max-w-full" />
        <Skeleton className="mt-2 h-3 w-40" />
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-3 w-[88%]" />
          <Skeleton className="h-3 w-[72%]" />
          <Skeleton className="h-3 w-[80%]" />
        </div>
      </div>
    </div>
  );
}

/** The header's controls: Start thread while a mail is open, then Compose. */
export function Head(props: WorkViewProps) {
  return <MailHead {...props} />;
}

function MailHead({ workspace, lifeos, startThread }: WorkViewProps) {
  const page = usePage(workspace.id);
  const ready = !!lifeos.client;
  return (
    <div className="flex items-center gap-1">
      {page.threadId ? (
        <Button variant="ghost" size="sm" onClick={() => startThread(mailChip(page.threadId!, page.subject))}>
          Start thread
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" disabled={!ready} onClick={() => patch(workspace.id, { compose: opening({ open: { kind: "new" }, full: true }), threadId: null })}>
        Compose
      </Button>
    </div>
  );
}
