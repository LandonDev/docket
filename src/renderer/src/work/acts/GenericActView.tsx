import { cn } from "../../lib/cn";
import { payloadView } from "../outbox/model";
import type { ActViewProps } from "./registry";

/**
 * The view every held act falls back to (docs/agents/work-outbox.md, "The
 * screens"): its fields as a person reads them, then its body as plain text,
 * exactly as it will go. A kind's own view (`work/<pillar>/act.ts`) takes its
 * place once the pillar lands.
 */
export function GenericActView({ item }: ActViewProps) {
  const { fields, body } = payloadView(item.payload);
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col gap-4">
      {fields.length ? (
        <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
          {fields.map((field) => (
            <div key={field.path.join(".")} className="contents">
              <dt className="truncate text-muted-foreground">{field.label}</dt>
              <dd className="min-w-0 break-words text-foreground">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {body ? <div className={cn("whitespace-pre-wrap break-words text-sm leading-[22px] text-foreground", fields.length > 0 && "border-t border-border pt-4")}>{body.text}</div> : null}
    </div>
  );
}
