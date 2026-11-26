// bun run ui:preview src/renderer/src/components/ui/time-field.preview.tsx#TimeFieldOpen --shot --fresh
// The field with its quarter hours open under it, drawn in place (an `inline` list in the popup's own box), as a
// press on the field opens it; and the same after "6p" is typed.
import { Check } from "../../chrome/icons";
import { ComboboxField, ComboboxFieldInput, ComboboxFieldItem, ComboboxList } from "./combobox";
import { QUARTERS, timesFor, timeWords } from "./time-field";

function Open({ typed, value }: { typed?: string; value: string }) {
  const times = typed === undefined ? QUARTERS.slice(QUARTERS.indexOf(value) - 2, QUARTERS.indexOf(value) + 4) : timesFor(typed);
  return (
    <ComboboxField inline open items={times as string[]} mode="none" defaultValue={typed ?? timeWords(value)}>
      <ComboboxFieldInput aria-label="From" className="w-32 tabular-nums" />
      <div className="mt-1 flex w-32 flex-col rounded-xl bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-border">
        <ComboboxList>
          {(time: string) => (
            <ComboboxFieldItem key={time} value={time} className="justify-between gap-2 tabular-nums">
              {timeWords(time)}
              {time === value ? <Check aria-hidden className="size-3.5 text-muted-foreground" /> : null}
            </ComboboxFieldItem>
          )}
        </ComboboxList>
      </div>
    </ComboboxField>
  );
}

export function TimeFieldOpen() {
  return (
    <div className="flex flex-wrap items-start gap-8">
      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">Opened on 6:00 PM</span>
        <Open value="18:00" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">Typed “6p”</span>
        <Open value="18:00" typed="6p" />
      </div>
    </div>
  );
}
