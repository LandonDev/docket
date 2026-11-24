import { useMemo, type ReactNode } from "react";
import type { MailClient, OutboxRow, ThreadSummary } from "work-kit/mail";
import { MAIL_CHAT } from "@shared/work/mailChat";
import { registry } from "../../../lib/connection";
import { newSession } from "../../../lib/session";
import { workDockPort } from "../../../lib/workSwitch";
import { SessionActionsContext, type SessionActions } from "../../../surfaces/threadChat";
import { OfferCard } from "../chat/OfferCard";

/**
 * The chat beside the mail on the preview page (`?chat=1`, docs/agents/work-mail.md "Proving it"): the chat on, its
 * dock's host a stand-in that knows no chat from before and answers every mark, and beside the page the two cards a
 * mail chat answers with, a reply draft and rows to archive, over the same fixture client. Sends and bulk acts are
 * counted where the client answers them (`window.__mailChat.calls`), so a proof can say nothing went.
 */
export const CHAT_WORKSPACE = { id: "preview", environmentId: "preview-host", path: "/preview" };

/** A reply the chat wrote in Marisol's thread, held for his press as every thread's draft is. */
export function chatDrafts(now = Date.now()): OutboxRow[] {
  const text = "Hi Marisol,\n\nThank you for the PO. Invoice 1042 is attached again with PO 7731 on it.\n\nLandon";
  return [
    {
      id: "chat-reply",
      status: "draft",
      version: 1,
      editedAt: now - 60_000,
      origin: { app: "tempcode", threadId: "mail-chat", host: "box", workspaceId: "ws-unify" },
      message: {
        kind: "mail",
        accountId: "a-unify",
        threadId: "c-invoice",
        from: { name: "Landon Hale", address: "landon@unifyplatforms.com" },
        mode: "reply",
        to: [{ name: "Marisol Rivera", address: "marisol@riveradental.com" }],
        cc: [],
        bcc: [],
        subject: "Re: Invoice 1042",
        html: text
          .split("\n\n")
          .map((w) => `<div>${w}</div>`)
          .join("<div><br></div>"),
        text,
        snippet: text.slice(0, 140),
        attachments: [],
        forwardParts: [],
      } as OutboxRow["message"],
    },
  ];
}

const calls: { sends: unknown[]; batches: { ids: string[]; act: unknown }[] } = { sends: [], batches: [] };

/** The chat on, and its host a stand-in: no chat from before, every mark answered, a draft made in the window. */
export function prepareChat(): true {
  MAIL_CHAT.on = true;
  (registry as unknown as { linkOf: (env: string) => unknown }).linkOf = (env: string) => ({
    environmentId: env,
    connected: true,
    request: async (method: string) => (method === "work.mail.chat.find" ? { sessionIds: [] } : { ok: true }),
    onPush: () => () => undefined,
  });
  let n = 0;
  workDockPort.set({
    draft: (_ws, id) => ({ ...newSession(CHAT_WORKSPACE.environmentId, "claude", "/preview", undefined, undefined, undefined, { projectId: null, workspaceId: CHAT_WORKSPACE.id }), id: id ?? `chat-draft-${++n}` }),
    openFile: () => undefined,
    openDiff: () => undefined,
  });
  const errors: string[] = [];
  window.addEventListener("error", (e) => void errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => void errors.push(String((e.reason as Error)?.message ?? e.reason)));
  (window as unknown as { __mailChat: unknown }).__mailChat = { calls, errors };
  const said = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack?.split("\n").slice(0, 4).join(" | ")}` : String(a))).join(" ").slice(0, 600));
    said(...args);
  };
  void import("../chat/MailDock").catch((e: Error) => void errors.push(`MailDock: ${e?.stack ?? e}`));
  return true;
}

/** The fixture client, with every send and every bulk act counted before it runs. */
export function chatClient(client: MailClient): MailClient {
  return {
    ...client,
    useOutboxActions() {
      const actions = client.useOutboxActions();
      return useMemo(() => ({ ...actions, send: (args: Parameters<typeof actions.send>[0]) => (calls.sends.push(args), actions.send(args)) }), [actions]);
    },
    useMailActions() {
      const actions = client.useMailActions();
      return useMemo(
        () => ({
          ...actions,
          batch: (threads: readonly ThreadSummary[], act: Parameters<typeof actions.batch>[1], reopen?: () => void) => {
            calls.batches.push({ ids: threads.map((t) => t.id), act });
            actions.batch(threads, act, reopen);
          },
        }),
        [actions],
      );
    },
  };
}

const actions = new Proxy({}, { get: () => () => undefined }) as SessionActions;

/** The thread actions every chat in the app sits under (App.tsx gives them); here, ones that do nothing. */
export function ChatActions({ children }: { children: ReactNode }) {
  return <SessionActionsContext.Provider value={actions}>{children}</SessionActionsContext.Provider>;
}

/** The two cards a mail chat answers with, beside the page, as its transcript draws them. */
export function ChatSide({ workspaceId }: { workspaceId: string }) {
  const at = { sessionId: "mail-chat", workspaceId, sector: "unify" as const };
  return (
    <>
      <aside data-chat-cards className="flex w-[400px] shrink-0 flex-col gap-4 overflow-y-auto border-s border-border p-4">
        <OfferCard offer={{ draft: { draftId: "chat-reply" } }} at={at} />
        <OfferCard offer={{ rows: { act: "archive", title: "Archive 3 notices", threadIds: ["c-receipt", "c-newsletter", "c-workspace"] } }} at={at} />
      </aside>
    </>
  );
}
