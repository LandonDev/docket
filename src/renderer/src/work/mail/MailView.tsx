import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ConvexProvider } from "convex/react";
import { Mailbox, MailClientProvider, MailKitProvider, opening, useMailClient, type ComposeState, type InboxView, type MailNav, type MailTaskRequest, type OutboxView } from "work-kit/mail";
import "work-kit/mail/styles.css";
import "./mail.css";
import { Button } from "../../components/ui/button";
import { openWorkView } from "../../lib/workSwitch";
import { SurfaceSkeleton } from "../../surfaces/SurfaceSkeleton";
import type { WorkViewProps } from "../views/registry";
import { mailClientFor, tempcodeMailKit } from "./kit";
import { mailChip } from "./model";

/**
 * The Mail view of a linked Work workspace (docs/agents/work-mail.md):
 * LifeOS's own mail client, on a session narrowed to the workspace's
 * sector, so it lists that sector's mail and no other. Send goes through
 * the host. The header carries Start thread for the open mail and Compose.
 */

interface MailPage {
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

function patch(workspaceId: string, next: Partial<MailPage>): void {
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
  if (!convex) return <SurfaceSkeleton kind="page" label="Loading Mail" />;
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
      if (request.kind === "task") openWorkView({ workspaceId: id, view: "tasks" });
      else actions.makeTask(request.threadId, request.draft);
    },
    [actions, id],
  );
  const frame = useCallback(
    ({ list, pane }: { list: ReactNode; pane: ReactNode }) => (
      <div className="flex h-full min-h-0">
        <div className="flex w-[300px] shrink-0 flex-col border-r border-border">{list}</div>
        <div className="flex min-w-0 flex-1 flex-col">{pane}</div>
      </div>
    ),
    [],
  );
  return (
    <div className="tc-mail h-full min-h-0">
      <Mailbox nav={nav} accounts={accounts} compose={page.compose} setCompose={setCompose} openTaskIds={NO_TASKS} onTask={onTask} frame={frame} />
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
