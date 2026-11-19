import { Paperclip } from "../../chrome/icons";
import { Attachment, AttachmentContent, AttachmentMedia, AttachmentTitle } from "../../components/ui/attachment";
import type { ActViewProps } from "../acts/registry";
import { mailActView } from "./model";

/**
 * A held mail in the Outbox (`mail.send`; docs/agents/work-mail.md): who it
 * is from and to, its subject, then its words exactly as they go, and its
 * files. A rewrite an agent left waiting is one muted line: it is taken or
 * left in the draft beside the thread, never here.
 */
export function View({ item }: ActViewProps) {
  const { rows, body, files, proposed } = mailActView(item.payload);
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
      {body ? <div className="whitespace-pre-wrap break-words border-t border-border pt-4 text-sm leading-[22px] text-foreground">{body}</div> : null}
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
