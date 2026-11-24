import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { GenericActView } from "./GenericActView";
import { kindRows, shown, type KindRows } from "./kindRows";
import type { ActViewProps } from "./registry";

/**
 * The parts a kind's own view of a held act is drawn with (docs/agents/work-outbox.md "Kind views"), imported only by
 * those views, each its own lazy chunk: the fields on the 72px label column, the line that says where a post lands,
 * a message as it will show once posted, and the words that go as one block.
 */

/** Fields as a person reads them, on the 72px label column; a row that starts a group of its own has 16px above it. */
export function ActFields({ fields }: { fields: KindRows["fields"] }) {
  return (
    <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
      {fields.map((field, i) => (
        <div key={`${i}:${field.label}`} className="contents">
          <dt className={cn("truncate text-muted-foreground", field.gap && "mt-2.5")}>{field.label}</dt>
          <dd className={cn("min-w-0 break-words whitespace-pre-wrap text-foreground", field.gap && "mt-2.5")}>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Where a post or a change lands, above it: "Esports staff, General". */
export function PlaceLine({ children }: { children: ReactNode }) {
  return <p data-place className="min-w-0 break-words text-xs text-muted-foreground">{children}</p>;
}

/** Words exactly as they go, line breaks kept. */
export function Words({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-w-0 whitespace-pre-wrap break-words text-sm leading-[22px] text-foreground", className)}>{children}</div>;
}

/** A message as it will show once posted: his name, then its words. `above` is what it answers, over it as in the chat. */
export function PostedAs({ children, above }: { children: ReactNode; above?: ReactNode }) {
  return (
    <div data-posted className="flex min-w-0 flex-col gap-1">
      {above}
      <div className="flex min-w-0 flex-col">
        <span className="text-[13px] leading-5 font-semibold text-foreground">You</span>
        <Words>{children}</Words>
      </div>
    </div>
  );
}

/**
 * A kind read through its rows (kindRows.ts): its fields, then its body under a hairline. A kind the rows do not
 * know, or a payload they find nothing in, takes the generic view, which reads every field or says it could not.
 */
export function RowsView(props: ActViewProps) {
  const own = kindRows(props.item.kind, props.item.payload);
  if (!own || (!own.fields.length && !own.body)) return <GenericActView {...props} />;
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col gap-4">
      {own.fields.length ? <ActFields fields={own.fields} /> : null}
      {own.body ? <Words className={own.fields.length ? "border-t border-border pt-4" : undefined}>{shown(own.body)}</Words> : null}
    </div>
  );
}
