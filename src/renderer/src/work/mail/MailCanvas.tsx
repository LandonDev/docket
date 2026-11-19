import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConvexProvider, useConvex, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Mailbox, MailClientProvider, MailKitProvider, opening, useMailClient, type ComposeState, type MailNav } from "work-kit/mail";
import type { InlineOp } from "work-kit/formats/diff";
import "work-kit/mail/styles.css";
import "./mail.css";
import type { Principal, SectorKey } from "@shared/work";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { useSessionMeta } from "../../lib/tcserver/store";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { EmptyState, SurfaceSkeleton } from "../../surfaces/SurfaceSkeleton";
import type { CanvasBodyProps, CanvasShell } from "../canvas/kind";
import { openWorkSettings } from "../shell/open";
import { reopenLifeos, sessionWaits, useLifeosSession } from "../shell/lifeos";
import { RuleLine } from "../rules/RuleLine";
import { mailClientFor, tempcodeMailKit } from "./kit";
import { proposalDiff, type Proposal } from "./proposal";

/**
 * A mail item beside a thread (docs/agents/work-mail.md): a draft an agent
 * made, in LifeOS's own composer under the mail it answers. While a rewrite
 * the agent proposed waits (`outbox.proposed`), the draft shows it as words
 * taken and put in, and the bar's stepper takes or leaves it
 * (`compose.settleProposal`); then the composer comes back with what was
 * decided. Send goes through the host, as in the Mail view.
 */

const getDraft = makeFunctionReference<"query", { id: string }, { row: { proposed?: Proposal } } | null>("compose:get");
const settleProposal = makeFunctionReference<"mutation", { id: string; take: boolean }, boolean>("compose:settleProposal");

export function Body({ item, source, env, shell }: CanvasBodyProps) {
  const meta = useSessionMeta(item.sessionId);
  const workspace = useWorkspaces().find((w) => w.id === meta?.workspaceId);
  // A Work Chat's items read through the whole session; a workspace's, through its sector alone.
  const sector = (workspace?.sector ?? null) as SectorKey | null;
  const lifeos = useLifeosSession(env, sector);
  const unreachable = lifeos.state === "unreachable";
  useEffect(() => {
    // Retry asks the host's status afresh and, once it says connected, this sector's session again: watching a host already
    // watched starts nothing. A retry that fails leaves the line as it is; the spinner stopping is the answer.
    const retry = (): Promise<void> => reopenLifeos(env, sector).catch(() => undefined);
    shell.statusLine(unreachable ? { tone: "failed", word: "LifeOS did not answer", detail: "The draft is kept there", action: { label: "Retry", run: retry } } : null);
  }, [shell, unreachable, env, sector]);
  if (source.at !== "lifeos" || source.table !== "outbox") return <EmptyState title="This mail could not be shown" />;
  if (lifeos.state === "off" || lifeos.state === "signed-out" || lifeos.state === "pairing" || lifeos.state === "refused") return <EmptyState title="Sign in to LifeOS" action={{ label: "Sign in", onClick: openWorkSettings }} />;
  // LifeOS did not answer: the state line says so once, and the draft last read stays, read only; with none read, nothing pulses under the line.
  if (!lifeos.client) {
    if (sessionWaits(lifeos)) return <SurfaceSkeleton kind="column" label="Loading the mail" />;
    const kept = lastRead.get(source.id);
    return kept ? <Letter draft={kept} /> : null;
  }
  return (
    <ConvexProvider client={lifeos.client}>
      <MailClientProvider client={mailClientFor(env, lifeos.client.url)}>
        <MailKitProvider kit={tempcodeMailKit}>
          <div className="tc-mail flex h-full min-h-0 flex-col">
            <Draft id={source.id} shell={shell} />
            <SentLine env={env} id={source.id} />
          </div>
        </MailKitProvider>
      </MailClientProvider>
    </ConvexProvider>
  );
}

/** Under a sent mail he changed: the house rule his repeated edit proposes, if any (work/rules). */
function SentLine({ env, id }: { env: string; id: string }) {
  const doc = useMailClient().useComposeDoc(id);
  return doc?.status === "sent" ? <RuleLine env={env} draftId={id} className="shrink-0 border-t border-border px-5 py-2" /> : null;
}

/** The last copy of each draft this window read, so a LifeOS that stops answering leaves it on screen, read only. */
const lastRead = new Map<string, MailWords>();

/** Keeps the copy of a draft just read. */
export function keepRead(id: string, words: MailWords): void {
  lastRead.set(id, words);
}

/** Forgets every kept copy (tests). */
export function resetLastRead(): void {
  lastRead.clear();
}

const NO_TASKS: ReadonlySet<string> = new Set();
const paneOnly = ({ pane }: { list: ReactNode; pane: ReactNode }): ReactNode => pane;
const who = (people: readonly { name?: string | undefined; address: string }[]): string => people.map((p) => p.name?.trim() || p.address).join(", ");

function Draft({ id, shell }: { id: string; shell: CanvasShell }) {
  const client = useMailClient();
  const convex = useConvex();
  const doc = client.useComposeDoc(id);
  const accounts = client.useMailAccounts();
  const proposed = useQuery(getDraft, { id })?.row?.proposed ?? null;
  const waiting = doc?.status === "draft" && proposed !== null;
  const threadId = doc?.message.threadId ?? null;
  const open = doc?.status === "draft" || doc?.status === "failed";

  const [shownThread, setShownThread] = useState<string | null>(threadId);
  useEffect(() => setShownThread(threadId), [threadId]);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  // Closing the composer is his; it opens again on the draft only when the item comes back or a rewrite was decided.
  const closed = useRef(false);
  useEffect(() => {
    if (!open || waiting) {
      setCompose(null);
      return;
    }
    if (!closed.current) setCompose((now) => now ?? opening({ open: { kind: "row", id }, threadId: threadId ?? undefined, full: !threadId }));
  }, [open, waiting, id, threadId]);
  const putCompose = useCallback((next: ComposeState | null) => {
    closed.current = next === null;
    setCompose(next);
  }, []);

  const settle = useCallback(
    async (take: boolean) => {
      // The composer comes back on what was decided, even if he had closed it: set before the answer, since the query moves first.
      const was = closed.current;
      closed.current = false;
      try {
        await convex.mutation(settleProposal, { id, take });
      } catch (error) {
        closed.current = was;
        const toast = await loadToast();
        toast.error(take ? "The rewrite could not be taken" : "The rewrite could not be dropped", { description: error instanceof Error ? error.message.replace(/^.*ConvexError:\s*/s, "") : undefined });
      }
    },
    [convex, id],
  );
  useEffect(() => {
    if (!waiting) {
      shell.review(null);
      return;
    }
    const by = (proposed?.by?.startsWith("agent:") ? proposed.by : "lifeos:agent") as Principal;
    shell.review({ groups: [{ id: "rewrite", label: "Rewrite", by, count: 1 }], index: 0, count: 1, step: () => {}, accept: () => settle(true), reject: () => settle(false) });
    return () => shell.review(null);
  }, [shell, waiting, proposed?.by, settle]);

  useEffect(() => {
    if (doc) keepRead(id, doc.message);
  }, [doc, id]);

  const nav = useMemo<MailNav>(
    () => ({ account: null, inboxView: "everything", setInboxView: () => {}, threadId: shownThread, setThreadId: setShownThread, view: "inbox", sheetOpen: false }),
    [shownThread],
  );

  if (doc === undefined) return <SurfaceSkeleton kind="column" label="Loading the mail" />;
  if (doc === null) return <EmptyState title="This draft is gone" line="It was discarded in LifeOS." />;
  if (waiting && proposed) {
    const rewrite = <Letter draft={doc.message} proposed={proposed} />;
    if (!threadId) return rewrite;
    // The rewrite takes only the composer's place: the mail it answers stays above it.
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div data-mail-kit className="relative min-h-0 flex-1">
          <Mailbox nav={nav} accounts={accounts} compose={null} setCompose={putCompose} openTaskIds={NO_TASKS} onTask={() => {}} frame={paneOnly} />
        </div>
        <div data-mail-rewrite className="flex max-h-[60%] min-h-0 shrink-0 flex-col border-t border-border">
          {rewrite}
        </div>
      </div>
    );
  }
  // A new mail on its way or gone keeps its words, read only.
  if (!open && !threadId) return <Letter draft={doc.message} lead={doc.status === "sent" ? "Sent to" : "Sending to"} />;
  return (
    <div data-mail-kit className="contents">
      <Mailbox nav={nav} accounts={accounts} compose={compose} setCompose={putCompose} openTaskIds={NO_TASKS} onTask={() => {}} frame={paneOnly} />
    </div>
  );
}

const INS = "rounded-[2px] bg-(--add-bg) box-decoration-clone";
// Removed words keep 70% of the ink, so they read on the tint in both themes.
const DEL = "rounded-[2px] bg-(--del-bg) box-decoration-clone text-foreground/70 line-through decoration-[color-mix(in_srgb,var(--destructive)_70%,transparent)]";

/** Words taken out struck, words put in washed; taken words then new ones read as two, a space's width apart, as Compare draws them. */
export function Runs({ ops }: { ops: InlineOp[] }) {
  return (
    <>
      {ops.map((op, i) => (
        <span key={i} className={cn(op.op === "+" && INS, op.op === "-" && DEL, op.op === "+" && ops[i - 1]?.op === "-" && "ms-1.5")}>
          {op.text}
        </span>
      ))}
    </>
  );
}

export type MailWords = { subject: string; text: string; to: readonly { name?: string | undefined; address: string }[] };

/**
 * A draft read only: whom it goes to and its words, with the agent's rewrite
 * in them when one waits. The subject is the tab's, so it shows here only
 * when the rewrite changes it. The words are the composer's 14/22: mail.css's
 * 13px step is for work-kit's chrome alone.
 */
export function Letter({ draft, proposed, lead = "To" }: { draft: MailWords; proposed?: Proposal; lead?: string }) {
  const diff = proposed ? proposalDiff(draft, proposed) : null;
  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pt-3 pb-4">
      <p className="text-xs leading-5 text-muted-foreground">
        {lead} {who(draft.to)}
      </p>
      {diff?.subject ? (
        <h2 className="mt-1 text-subject font-semibold text-balance">
          <Runs ops={diff.subject} />
        </h2>
      ) : null}
      <div className="mt-3 max-w-[70ch] text-sm leading-[22px] break-words whitespace-pre-wrap select-text">{diff?.body ? <Runs ops={diff.body} /> : draft.text}</div>
    </div>
  );
}
