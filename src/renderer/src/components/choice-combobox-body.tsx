import { useEffect, useRef, useState } from "react";
import { Combobox, ComboboxCollection, ComboboxContent, ComboboxEmpty, ComboboxField, ComboboxFieldInput, ComboboxFieldItem, ComboboxGroup, ComboboxItem, ComboboxLabel, ComboboxList, ComboboxSearch, ComboboxSeparator, ComboboxTrigger } from "./ui/combobox";
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
      {/* Base UI keeps tabindex 0 on a disabled trigger; Tab passes it, as it passes a disabled ChoiceSelect. */}
      <ComboboxTrigger aria-label={label} size={size} className={className} tabIndex={disabled ? -1 : undefined}>
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

/** The props `TextCombobox` takes, cold (choice-combobox.tsx) and warm alike. */
export type TextComboboxProps = {
  label: string;
  value: string;
  onChange: (text: string) => void;
  suggestions: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  /** set by a `Field` around it, as on any field */
  id?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-describedby"?: string;
};

/** The suggestions that hold the typed words, in their order, each once; all of them for no words. */
export function suggestionsFor(suggestions: readonly string[], text: string): string[] {
  const words = text.trim().toLocaleLowerCase();
  return [...new Set(suggestions)].filter((s) => s.toLocaleLowerCase().includes(words));
}

/**
 * A text field that suggests (a native `<datalist>`'s place): the field itself is the combobox and its text is the
 * value; the rows that hold the typed words drop under it, and none is forced. The popup stays shut while nothing
 * matches. Escape shuts it and keeps the text; Enter takes the highlighted row, and with none highlighted leaves the
 * text and lets a form's submit through. Imported through choice-combobox.tsx, which loads it with the select chunk.
 * `focusAt`: the cold field had the keys when this one swapped in; it takes them, the caret where it was.
 */
export function TextCombobox({
  label,
  value,
  onChange,
  suggestions,
  placeholder,
  disabled,
  size = "default",
  className,
  focusAt,
  ...field
}: TextComboboxProps & { focusAt?: readonly [number, number] | null }) {
  const [open, setOpen] = useState(false);
  const matches = suggestionsFor(suggestions, value);
  const input = useRef<HTMLInputElement>(null);
  const [focus] = useState(focusAt);
  useEffect(() => {
    if (!focus || !input.current) return;
    input.current.focus();
    input.current.setSelectionRange(focus[0], focus[1]);
  }, [focus]);
  return (
    <ComboboxField
      items={matches}
      mode="none"
      value={value}
      onValueChange={(text: string) => onChange(text)}
      open={open && matches.length > 0}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <ComboboxFieldInput ref={input} aria-label={label} placeholder={placeholder} size={size} className={className} {...field} />
      <ComboboxContent>
        <ComboboxList>
          {(text: string) => (
            <ComboboxFieldItem key={text} value={text}>
              {text}
            </ComboboxFieldItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </ComboboxField>
  );
}
