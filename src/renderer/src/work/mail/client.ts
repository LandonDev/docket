import { useMemo } from "react";
import type { MailClient, MailWrite, OutboxActions } from "work-kit/mail";
import { createLifeosMailClient } from "work-kit/lifeos";
import type { MailSeen, MailSendAnswer } from "@shared/contract-work-mail";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";

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
export function sendThroughHost(env: string, actions: OutboxActions): OutboxActions {
  return {
    ...actions,
    send: async (args) => {
      const id = args.waited && args.id ? args.id : await actions.save(args);
      const m = args.message;
      // Everything that goes, so the host refuses a row changed in any of it after this save: the HTML and the files too.
      const attachments = [...(m.attachments ?? []).map((f) => ({ id: f.storageId, name: f.name })), ...(m.forwardParts ?? []).map((f) => ({ id: `part:${f.partId}`, name: f.name }))];
      const seen: MailSeen = { to: m.to.map((a) => a.address), cc: m.cc.map((a) => a.address), bcc: m.bcc.map((a) => a.address), subject: m.subject, text: m.text, html: m.html ?? "", attachments, accountId: m.accountId, ...(m.from ? { from: { ...(m.from.name ? { name: m.from.name } : {}), address: m.from.address } } : {}) };
      const answer = await registry.linkOf(env).request<MailSendAnswer>("work.mail.send", { id, seen, ...(args.sendAt !== undefined ? { sendAt: args.sendAt } : {}), ...(args.waited ? { waited: true } : {}) });
      if (answer.via === "hold") heldSends.add(id);
      return id;
    },
    cancel: (id) => (heldSends.has(id) ? Promise.resolve(false) : actions.cancel(id)),
  };
}

/** Every write a screen makes: its toast on success, with Undo where it has one, and its own words on failure. */
const write: MailWrite = async ({ run, failed, message, undo }) => {
  try {
    const result = await run();
    if (message) {
      void loadToast().then((toast) =>
        toast(message, undo ? { action: { label: "Undo", onClick: () => void undo(result).catch(() => toast.error("Undo did not go through")) } } : undefined),
      );
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

/** The mail client for a host's LifeOS at `convexUrl`: made once, then the same object every time. */
export function mailClientFor(env: string, convexUrl: string): MailClient {
  const key = `${env}|${convexUrl}`;
  let client = clients.get(key);
  if (!client) {
    client = wrapClient(env, createLifeosMailClient({ convexUrl, write }));
    clients.set(key, client);
  }
  return client;
}
