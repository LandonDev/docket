import type { ActViewProps } from "../acts/registry";
import { officeOpFields } from "./calendarAct";

/**
 * A held Outlook calendar act in the Outbox: an invitation or a reply, as he
 * reads it, in the LifeOS calendar act's rows and markup
 * (agenda/CalendarActView.tsx). Outlook's day is not LifeOS's, so there is no
 * day list under it.
 */
export function View({ item }: ActViewProps) {
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col gap-5">
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
        {officeOpFields(item.payload).map((field) => (
          <div key={field.label} className="contents">
            <dt className="truncate text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 break-words whitespace-pre-wrap text-foreground">{field.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
