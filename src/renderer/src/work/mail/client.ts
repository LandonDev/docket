import { useMemo } from "react";
import type { ComposeMessage, MailClient, MailWrite, OutboxActions } from "work-kit/mail";
import { createLifeosMailClient } from "work-kit/lifeos";
import type { MailSeen, MailSendAnswer } from "@shared/contract-work-mail";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import { workOpenPort } from "../../lib/workSwitch";

/**
 * TempCode's `MailClient` (work-kit/mail README, "The two seams"): LifeOS's
 * own, with Send taken through the host. One per host and LifeOS address,
 * kept for the window's life, since the screens call its hooks in a fixed
 * order. The look and manners are `kit.tsx`, which reaches no host.
 */

/** Mail that went through the hold: the hold has it as sent, so Undo cannot pull it back into a draft behind the hold's back. */
const heldSends = new Set<string>();

/**
 * The composer's Send: the draft is saved as he sees it, then the host sends it (`work.mail.send`)
 * only if LifeOS's row still says what he saw (people, subject, words, HTML, files and sender); this window never sends. Undo on a mail the hold
 * sent answers false, which the composer reads as "Already sent".
 *
 * A held draft's send comes here twice over: the composer saved it at the press, waited out the undo time, and now asks with `waited`.
 * That second call saves nothing: what he pressed on is only compared, so an edit made while it waited (by him in another window, by
 * the thread's agent) is never written over, and the host refuses the send because the row no longer says what he saw.
 */
/** Everything of a mail that goes, as he saw it, so the host refuses a row changed in any of it: the HTML and the files too. */
function seenOf(m: ComposeMessage): MailSeen {
  const attachments = [...(m.attachments ?? []).map((f) => ({ id: f.storageId, name: f.name })), ...(m.forwardParts ?? []).map((f) => ({ id: `part:${f.partId}`, name: f.name }))];
  return { to: m.to.map((a) => a.address), cc: m.cc.map((a) => a.address), bcc: m.bcc.map((a) => a.address), subject: m.subject, text: m.text, html: m.html ?? "", attachments, accountId: m.accountId, ...(m.from ? { from: { ...(m.from.name ? { name: m.from.name } : {}), address: m.from.address } } : {}) };
}

export function sendThroughHost(env: string, actions: OutboxActions): OutboxActions {
  return {
    ...actions,
    send: async (args) => {
      const id = args.waited && args.id ? args.id : await actions.save(args);
      const answer = await registry.linkOf(env).request<MailSendAnswer>("work.mail.send", { id, seen: seenOf(args.message), ...(args.sendAt !== undefined ? { sendAt: args.sendAt } : {}), ...(args.waited ? { waited: true } : {}) });
      if (answer.via === "hold") heldSends.add(id);
      return id;
    },
    cancel: (id) => (heldSends.has(id) ? Promise.resolve(false) : actions.cancel(id)),
    // A failed mail one of this host's threads made is sent again by the hold, on what the thread's foot showed him;
    // any other is his own and LifeOS queues it again.
    retry: async (id, row) => {
      if (row?.origin?.app !== "tempcode") return actions.retry(id, row);
      await registry.linkOf(env).request<MailSendAnswer>("work.mail.send", { id, seen: seenOf(row.message) });
      heldSends.add(id);
    },
  };
}

/**
 * Waiting on's Draft a nudge: the host starts a Work thread that drafts the follow-up (held, as every draft),
 * and the thread opens. While the host starts it, a toast says so with a spinner; a refusal says why.
 */
export async function startNudge(env: string, workspaceId: string, threadId: string): Promise<void> {
  const toast = await loadToast();
  const id = toast.loading("Starting a thread to draft the nudge");
  try {
    const { sessionId } = await registry.linkOf(env).request<{ sessionId: string }>("work.mail.nudge", { workspaceId, threadId });
    toast.dismiss(id);
    workOpenPort.get()?.(sessionId);
  } catch (err) {
    toast.error("The nudge did not start", { id, description: refusalWords(err) || undefined });
  }
}

/** How long the `z` key may still take back the last act: as long as its toast offers Undo. */
const UNDO_FOR_MS = 8000;
let last: { undo: () => void; until: number } | null = null;

/** Takes back the last act whose toast offered Undo, as that toast's own Undo would; once, and only while the toast could. */
export function undoLast(): void {
  const act = last;
  last = null;
  if (act && Date.now() <= act.until) act.undo();
}

/** Every write a screen makes: its toast on success, with Undo where it has one, and its own words on failure. */
export const write: MailWrite = async ({ run, failed, message, undo }) => {
  try {
    const result = await run();
    if (message) {
      void loadToast().then((toast) => {
        if (!undo) return void toast(message);
        let done = false;
        const back = (): void => {
          if (done) return;
          done = true;
          void undo(result).catch(() => toast.error("Undo did not go through"));
        };
        last = { undo: back, until: Date.now() + UNDO_FOR_MS };
        toast(message, { duration: UNDO_FOR_MS, action: { label: "Undo", onClick: back } });
      });
    }
    return result;
  } catch {
    void loadToast().then((toast) => toast.error(failed));
    return undefined;
  }
};

function wrapClient(env: string, inner: MailClient): MailClient {
  return {
    ...inner,
    useOutboxActions() {
      const actions = inner.useOutboxActions();
      return useMemo(() => sendThroughHost(env, actions), [actions]);
    },
  };
}

const clients = new Map<string, MailClient>();

/**
 * The mail client for a host's LifeOS at `convexUrl`, one per sector it reads (`scope`: the session's sector,
 * "all" for the whole session): made once, then the same object every time. A client keeps the first page of
 * each list it last showed, so two sectors never share one, or one sector's mail would stand in for the other's.
 */
export function mailClientFor(env: string, convexUrl: string, scope: string): MailClient {
  const key = `${env}|${convexUrl}|${scope}`;
  let client = clients.get(key);
  if (!client) {
    client = wrapClient(env, createLifeosMailClient({ convexUrl, write }));
    clients.set(key, client);
  }
  return client;
}
