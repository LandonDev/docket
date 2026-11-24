import type { ReactNode } from "react";
import { loadToast } from "../../../components/ui/toaster";
import { sessionStore } from "../../../lib/tcserver/store";
import type { LifeosLink } from "../../../surfaces/lifeosLink";
import { useTranscriptHost, useTranscriptSession } from "../../../surfaces/transcriptSession";
import { openerOf } from "../../canvas/SentChips";
import { Mail, Person } from "../../icons";

/**
 * A mail or a person an answer names, inline: a 20px chip on `muted` with its glyph, that opens the mail in Mail's
 * reader or the person on their page, as a sent chip does (SentChips' `openerOf`). A mail opened from here does not
 * move the chat beside the mail: it stays on what it was about.
 */
export function LifeosChip({ link, children }: { link: LifeosLink; children: ReactNode }) {
  const sessionId = useTranscriptSession();
  const host = useTranscriptHost();
  const meta = sessionId ? sessionStore.metaOf(sessionId) : null;
  const person = link.table === "people";
  const label = typeof children === "string" ? children : person ? "A person" : "A mail";
  const open =
    sessionId && host
      ? openerOf({ noun: person ? "person" : "mail", label, ref: `LifeOS ${link.table} ${link.id}` }, { environmentId: host, sessionId, workspaceId: meta?.workspaceId ?? null })
      : null;
  const Glyph = person ? Person : Mail;
  const body = (
    <>
      <Glyph className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
  const chip = "mx-px inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-md bg-muted px-1.5 align-[-3px] text-xs leading-5 text-foreground";
  if (!open) return <span data-lifeos-chip={link.table} className={chip}>{body}</span>;
  return (
    <button
      type="button"
      data-lifeos-chip={link.table}
      className={`${chip} cursor-default transition-[background-color,scale] duration-(--dur-fast) ease-(--ease-out) hover:bg-accent active:scale-[0.96] motion-reduce:transition-none`}
      onClick={() =>
        void Promise.resolve()
          .then(open)
          .catch(async () => (await loadToast()).error(`Couldn't open the ${person ? "person" : "mail"}`))
      }
    >
      {body}
    </button>
  );
}
