import { cn } from "../../lib/cn";
import { ActFields } from "./ActParts";
import { GenericActView } from "./GenericActView";
import { kindRows, type KindRows } from "./kindRows";
import type { ActViewProps } from "./registry";

type Row = KindRows["fields"][number];
/** One change as it lands: where (when not the whole file once), the words it takes out, the words that take their place. */
type Change = { where: string | null; was: string | null; now: string | null; rows: Row[] | null };

/**
 * A change's rows (kindRows `editRows`, each change a group that starts with `gap`) as one block. A row these labels do
 * not name keeps the group as rows, so nothing that goes is ever hidden.
 */
function changesOf(rows: Row[], body: string | null): Change[] {
  const groups: Row[][] = [];
  for (const row of rows) {
    if (row.gap || !groups.length) groups.push([]);
    groups.at(-1)!.push(row);
  }
  return groups.map((group, i) => {
    const one: Change = { where: null, was: null, now: null, rows: null };
    for (const row of group) {
      if (row.label === "Where" && one.where === null) one.where = row.value;
      else if ((row.label === "Replace" || row.label === "Take out") && one.was === null) one.was = row.value;
      else if (row.label === "With" && one.now === null) one.now = row.value;
      else return { ...one, rows: group };
    }
    // A Word insert: where it goes is the group, its words the body.
    if (i === groups.length - 1 && body !== null && one.was === null && one.now === null) one.now = body;
    return one.was === null && one.now === null ? { ...one, rows: group } : one;
  });
}

/**
 * An agent's change to a shared Word document, PowerPoint deck, Google Doc or deck (`office.edit`, `google.edit`): the
 * app and account it goes through, then each change as a block of its own, parted by hairlines: where, when that is not
 * the whole file once, the words it takes out, muted and struck, and the words that take their place. Every value is
 * kindRows' own, so words that read alike are quoted with their escapes there and here.
 */
export function ChangeView(props: ActViewProps) {
  const own = kindRows(props.item.kind, props.item.payload);
  const first = own ? own.fields.findIndex((f) => f.gap) : -1;
  if (!own || first < 0) return <GenericActView {...props} />;
  const head = own.fields.slice(0, first);
  const changes = changesOf(own.fields.slice(first), own.body);
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col gap-4">
      {head.length ? <ActFields fields={head} /> : null}
      <div className={cn("flex min-w-0 flex-col", head.length && "border-t border-border pt-4")}>
        {changes.map((change, i) => (
          <div key={i} data-change className={cn("flex min-w-0 flex-col gap-1", i > 0 && "mt-3 border-t border-border pt-3")}>
            {change.rows ? (
              <ActFields fields={change.rows.map(({ gap: _gap, ...row }) => row)} />
            ) : (
              <>
                {change.where ? <p className="min-w-0 break-words text-xs text-muted-foreground">{change.where}</p> : null}
                <div className="flex min-w-0 flex-col whitespace-pre-wrap break-words text-sm leading-[22px]">
                  {change.was !== null ? (
                    <del className="text-muted-foreground">
                      <span className="sr-only">{change.now === null ? "Take out: " : "Replace: "}</span>
                      {change.was}
                    </del>
                  ) : null}
                  {change.now !== null ? (
                    <ins className="text-foreground no-underline">
                      <span className="sr-only">{change.was === null ? "Add: " : "With: "}</span>
                      {change.now}
                    </ins>
                  ) : null}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
