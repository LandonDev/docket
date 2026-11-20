import { useMemo, useState } from "react";
import { FrameHostProvider, MailFrame, MailKitProvider, prepareMail, type FrameHost, type HoveredLink } from "work-kit/mail";
import "work-kit/mail/styles.css";
import { outgoingHtml } from "@shared/work/mailOutgoing";
import { Paperclip } from "../../chrome/icons";
import { Attachment, AttachmentContent, AttachmentMedia, AttachmentTitle } from "../../components/ui/attachment";
import { SettingSwitch } from "../../components/setting-switch";
import type { ActViewProps } from "../acts/registry";
import { tempcodeMailKit } from "./kit";
import { mailActView } from "./model";

/** The HTML this host will send for a held mail: the outgoing rules on what he wrote, then the quote LifeOS puts under it. */
export function outgoingMail(payload: unknown): string | null {
  const p = (payload ?? {}) as { message?: { html?: unknown }; quote?: unknown };
  const html = typeof p.message?.html === "string" ? p.message.html.trim() : "";
  if (!html) return null;
  return outgoingHtml(html) + (typeof p.quote === "string" ? p.quote : "");
}

/**
 * The mail drawn as it will arrive: the outgoing HTML in a mail frame, on
 * white, with no colour moved and nothing folded, and a link's real address
 * under it while the pointer is on the link. The frame loads nothing and
 * runs nothing, as in the reader.
 */
function AsItLooks({ html }: { html: string }) {
  const prepared = useMemo(() => prepareMail(html, { paper: true, forward: true }), [html]);
  const [link, setLink] = useState<HoveredLink | null>(null);
  // A link here is read, never followed: the press belongs to Send.
  const host = useMemo<FrameHost>(() => ({ openLink: () => {}, hover: setLink }), []);
  return (
    <MailKitProvider kit={tempcodeMailKit}>
      <FrameHostProvider value={host}>
        <div data-mail-drawn className="flex flex-col gap-1.5 border-t border-border pt-4">
          <MailFrame prepared={prepared} showQuotes title="The mail as it will arrive" />
          <p aria-live="polite" className={link?.warn ? "min-h-4 truncate text-xs text-warning" : "min-h-4 truncate text-xs text-muted-foreground"}>
            {link ? `${link.warn ? "Goes to " : ""}${link.href}` : null}
          </p>
        </div>
      </FrameHostProvider>
    </MailKitProvider>
  );
}

/**
 * A held mail in the Outbox (`mail.send`; docs/agents/work-mail.md): who it
 * is from and to, its subject, then its words exactly as they go, and its
 * files. A rewrite an agent left waiting is one muted line: it is taken or
 * left in the draft beside the thread, never here.
 */
export function View({ item }: ActViewProps) {
  const { rows, body, files, proposed, quote } = mailActView(item.payload);
  // Its words as plain text are what he is asked to read: every word that goes is there. The drawn mail is a second look.
  const drawn = useMemo(() => outgoingMail(item.payload), [item.payload]);
  const [looks, setLooks] = useState(false);
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col gap-4">
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="truncate text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 break-words text-foreground">
              {row.people
                ? row.people.map((person, i) => (
                    <span key={person.address}>
                      {i > 0 ? ", " : null}
                      {person.name?.trim() ? (
                        <>
                          {person.name} <span className="text-muted-foreground">{person.address}</span>
                        </>
                      ) : (
                        person.address
                      )}
                    </span>
                  ))
                : row.text}
            </dd>
          </div>
        ))}
      </dl>
      {/* Under the headers, above the body it swaps: it stays under the pointer whatever height either has, and its words switch it too. */}
      {drawn ? (
        <label data-mail-looks className="flex cursor-default items-center justify-between gap-3 text-[13px] text-muted-foreground">
          <span>As it looks</span>
          <SettingSwitch label="As it looks" on={looks} onChange={setLooks} />
        </label>
      ) : null}
      {looks && drawn ? (
        <AsItLooks html={drawn} />
      ) : (
        <>
          {body ? <div className="whitespace-pre-wrap break-words border-t border-border pt-4 text-sm leading-[22px] text-foreground">{body}</div> : null}
          {/* What LifeOS puts under a reply goes too: shown in its place, muted, as a mail client quotes. */}
          {quote ? <div data-mail-quote className="whitespace-pre-wrap break-words text-[13px] leading-5 text-muted-foreground">{quote}</div> : null}
        </>
      )}
      {files.length ? (
        <div className="flex flex-wrap gap-2">
          {files.map((name) => (
            <Attachment key={name} size="sm">
              <AttachmentMedia>
                <Paperclip className="size-3.5" />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{name}</AttachmentTitle>
              </AttachmentContent>
            </Attachment>
          ))}
        </div>
      ) : null}
      {proposed ? <p className="text-xs text-muted-foreground">A rewrite waits in the draft beside its thread.</p> : null}
    </div>
  );
}
