// A preview page for `bun run ui:preview src/renderer/src/work/mail/chat/MailDock.preview.tsx#ChatFirstAsk` (and
// #ChatPicked, #ChatAnswered): the chat beside the mail on work-kit's fixture mail, a fresh draft about the open mail,
// the same about ticked rows, and a mail chat's answers as cards. Rendered by nothing in the app; no host, no LifeOS.
import type { ReactNode } from "react";
import { MailClientProvider, MailKitProvider, type MailClient, type ThreadSummary } from "work-kit/mail";
import { corpusThreads, createFixtureMailClient } from "work-kit/mail/fixtures";
import { registry } from "../../../lib/connection";
import { newSession, type Block } from "../../../lib/session";
import { sessionStore } from "../../../lib/tcserver/store";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { workDockPort } from "../../../lib/workSwitch";
import { lifeosChipChunk, workCanvasChunk } from "../../../surfaces/chunks";
import { TranscriptSessionContext } from "../../../surfaces/transcriptSession";
import { AgentMarkdown } from "../../../surfaces/AgentMarkdown";
import { SessionActionsContext, type SessionActions } from "../../../surfaces/threadChat";
import { tempcodeMailKit } from "../kit";
import { MailScreen, mailChatChunk, patch } from "../MailView";
import { OfferCard } from "./OfferCard";

void mailChatChunk.load();
void workCanvasChunk.load();
void lifeosChipChunk.load();

const ID = "w";
const workspace = { id: ID, environmentId: "local", path: "/w" };
const threads = corpusThreads();
const client = createFixtureMailClient({ write: async ({ run }) => run(), instant: true, threads });
const actions = new Proxy({}, { get: () => () => undefined }) as SessionActions;

// No host here: the dock finds no chat from before, and a draft is made in the window.
(registry as unknown as { linkOf: (env: string) => unknown }).linkOf = (env: string) => ({ environmentId: env, connected: true, request: async () => ({ sessionIds: [] }), onPush: () => () => undefined });
let n = 0;
workDockPort.set({ draft: (_ws, id) => ({ ...newSession("local", "claude", "/w", undefined, undefined, undefined, { projectId: null, workspaceId: ID }), id: id ?? `draft-${++n}` }), openFile: () => undefined, openDiff: () => undefined });

function Page({ children }: { children: ReactNode }) {
  return (
    <SessionActionsContext.Provider value={actions}>
      <MailClientProvider client={client}>
        <MailKitProvider kit={tempcodeMailKit}>{children}</MailKitProvider>
      </MailClientProvider>
    </SessionActionsContext.Provider>
  );
}

const Frame = () => (
  <div className="flex h-[720px] w-[1280px] overflow-hidden border border-border">
    <MailScreen id={ID} onOpenTask={() => undefined} chat={{ workspace }} />
  </div>
);

/** Ask on an open mail: the chat beside it, a draft about the mail with its starters. */
export function ChatFirstAsk() {
  patch(ID, { box: "inbox", threadId: threads[0]!.id, chat: true, chatAt: null, compose: null });
  return (
    <Page>
      <Frame />
    </Page>
  );
}

/** Ask with rows ticked: a chat about them, named by their count. */
export function ChatPicked() {
  patch(ID, { box: "inbox", threadId: null, chat: true, chatAt: { box: "inbox", threadId: null, subject: null, query: null, picked: threads.slice(0, 4).map((t) => t.id) }, compose: null });
  return (
    <Page>
      <Frame />
    </Page>
  );
}

// The answers' own reads, as LifeOS would answer them.
const message = { kind: "mail", accountId: "a1", threadId: "t1", mode: "reply", to: [{ name: "Marisol Ortega", address: "marisol@example.com" }], cc: [], bcc: [], subject: "Re: Invoice 1042", html: "", text: "Hi Marisol,\n\nThank you for the PO. I have attached invoice 1042 again with PO-7731 on it, so it can go through this week.\n\nLandon", snippet: "" };
const summary = (id: string, subject: string, sender: string, day: number): ThreadSummary => ({ id, subject, senders: [sender], lastMessageAt: Date.parse(`2026-11-${day}T09:00:00`), messageCount: 1 }) as ThreadSummary;
const rows: Record<string, ThreadSummary> = {
  n1: summary("n1", "Your November statement is ready", "PayLedger", 21),
  n2: summary("n2", "Weekly digest: 12 new posts", "Forum", 20),
  n3: summary("n3", "Your order has shipped", "Parts Supply", 19),
};
const answered = {
  useComposeDoc: (id: string | undefined) => (id === "d1" ? { id: "d1", status: "draft", message, version: 1, editedAt: 0, urls: {} } : undefined),
  useOutboxActions: () => ({}),
  useMailThread: (id: string | null) => (id && rows[id] ? { thread: rows[id], messages: [] } : id === "gone" ? null : undefined),
  useMailActions: () => ({}),
} as unknown as MailClient;

const now = Date.now();
const prose: Block = { id: "a1", role: "assistant", text: "Marisol sent the PO in [Re: Invoice 1042](#lifeos:mailThreads:t1); [Dana Lee](#lifeos:people:p1) is copied. A reply that sends the invoice again is below.", ts: now } as Block;

/** A mail chat's answers: a chip in prose, a draft for his reply, rows to archive, a task and an event to add. */
export function ChatAnswered() {
  sessionStore.adopt({ id: "s1", environmentId: "local", status: "idle", archived: false, workspaceId: ID, projectId: null, scope: "work", createdAt: now, updatedAt: now } as SessionMeta, { created: true });
  const at = { sessionId: "s1", workspaceId: ID, sector: "unify" as const };
  return (
    <TranscriptSessionContext.Provider value="s1">
      <MailClientProvider client={answered}>
        <div className="flex w-[560px] flex-col gap-4 p-6">
          <AgentMarkdown text={prose.text} />
          <OfferCard offer={{ draft: { draftId: "d1" } }} at={at} />
          <OfferCard offer={{ rows: { act: "archive", title: "Archive 3 notices", threadIds: ["n1", "n2", "n3", "gone"] } }} at={at} />
          <OfferCard offer={{ task: { title: "Resend invoice 1042 with the PO", due: "2026-11-25", threadId: "t1" } }} at={at} />
          <OfferCard offer={{ event: { title: "Call with Marisol about billing", start: "2026-11-26T14:00:00", end: "2026-11-26T14:30:00" } }} at={at} />
        </div>
      </MailClientProvider>
    </TranscriptSessionContext.Provider>
  );
}
