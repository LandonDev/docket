import { cn } from "../../lib/cn";
import { payloadView, type Field } from "../outbox/model";
import { kindRows } from "./kindRows";
import type { ActViewProps } from "./registry";

/**
 * The view every held act falls back to (docs/agents/work-outbox.md, "The
 * screens"): its fields as a person reads them, then its body as plain text,
 * exactly as it will go. A form's publish, a Google share, a Frame.io post and
 * a Teams post read through their own rows (kindRows.ts); any other kind
 * through the generic reader. A kind with a view of its own
 * (`work/<pillar>/act.ts`) never comes here.
 */
/** A computer act's tool word ("left_click") under a title that already says what the click does: left out of its rows. */
export const actFields = (kind: string, fields: Field[]): Field[] => (kind === "computer.act" ? fields.filter((f) => f.path.join(".") !== "args.action") : fields);

export function GenericActView({ item }: ActViewProps) {
  const own = kindRows(item.kind, item.payload);
  const view = own ? null : payloadView(item.payload);
  const body = own ? (own.body === null ? null : { text: own.body }) : view!.body;
  const fields = own ? own.fields.map((f) => ({ ...f, key: f.label })) : actFields(item.kind, view!.fields).map((f) => ({ ...f, key: f.path.join(".") }));
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col gap-4">
      {fields.length ? (
        <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
          {fields.map((field) => (
            <div key={field.key} className="contents">
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
