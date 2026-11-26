import { Combobox, ComboboxCollection, ComboboxContent, ComboboxEmpty, ComboboxGroup, ComboboxItem, ComboboxLabel, ComboboxList, ComboboxSearch, ComboboxSeparator, ComboboxTrigger } from "./ui/combobox";
import { groupsOf, type Choice } from "./choice-select-body";

type Run<T extends string> = { value: string; label?: string; items: Choice<T>[] };

/**
 * `ChoiceSelect` with a field that filters, for a list too long to scan
 * (models by provider, workspaces): the same options, the same trigger, and
 * a search field at the head of its list. Imported through
 * choice-combobox.tsx, which loads it with the select chunk.
 */
export function ChoiceCombobox<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  size = "default",
  className,
  defaultOpen,
}: {
  label: string;
  value: T;
  options: readonly Choice<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  /** Opens on mount: a click on the cold trigger (choice-combobox.tsx) before the chunk landed. */
  defaultOpen?: boolean;
}) {
  const chosen = options.find((option) => option.value === value) ?? null;
  const runs: Run<T>[] = groupsOf(options).map(({ group, items }) => ({ value: group ?? "", label: group, items }));
  return (
    <Combobox
      items={runs}
      value={chosen}
      defaultOpen={defaultOpen}
      disabled={disabled}
      autoHighlight
      itemToStringLabel={(option: Choice<T>) => option.label}
      isItemEqualToValue={(a: Choice<T>, b: Choice<T>) => a.value === b.value}
      onValueChange={(next: Choice<T> | null) => {
        if (next && next.value !== value) onChange(next.value);
      }}
    >
      <ComboboxTrigger aria-label={label} size={size} className={className}>
        {chosen?.label ?? value}
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxSearch aria-label={`Search ${label}`} placeholder="Search" />
        <ComboboxSeparator />
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList>
          {(run: Run<T>) => (
            <ComboboxGroup key={run.value} items={run.items}>
              {run.label ? <ComboboxLabel>{run.label}</ComboboxLabel> : null}
              <ComboboxCollection>
                {(option: Choice<T>) => (
                  <ComboboxItem key={option.value} value={option}>
                    {option.label}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
