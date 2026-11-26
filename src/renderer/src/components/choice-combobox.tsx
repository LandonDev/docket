import { useEffect, useState, type SyntheticEvent } from "react";
import { cn } from "@renderer/lib/cn";
import { ColdSelectTrigger, usePendingOpen, useSelectBody, warmSelects } from "./lazy-select";
import type { ChoiceCombobox as Body, TextComboboxProps } from "./choice-combobox-body";
import { Input } from "./ui/input";

/** `ChoiceSelect`'s searchable twin (choice-combobox-body.tsx), cold the
 *  same way: until the select chunk lands the field is its own still
 *  trigger, and a click on it opens the list as soon as the chunk is in. */
export function ChoiceCombobox<T extends string>(props: Parameters<typeof Body<T>>[0]) {
  const B = useSelectBody();
  const [pending, open] = usePendingOpen();
  useEffect(() => {
    if (!B) warmSelects();
  }, [B]);
  if (B) return <B.ChoiceCombobox {...props} defaultOpen={pending} />;
  return (
    <ColdSelectTrigger size={props.size} aria-label={props.label} disabled={props.disabled} className={props.className} onOpen={open}>
      {props.options.find((option) => option.value === props.value)?.label ?? props.value}
    </ColdSelectTrigger>
  );
}

/** `TextCombobox` (choice-combobox-body.tsx), a text field that suggests, cold the same way: until the select chunk
 *  lands it is an ordinary `Input` of the same box, so typing works at once; a focus on it brings the chunk, and the
 *  field that swaps in keeps the text (the caller's `value`), the keys and the caret. */
export function TextCombobox({ size = "default", className, onChange, suggestions, ...props }: TextComboboxProps) {
  const B = useSelectBody();
  // Where the cold field's caret stands while it has the keys, for the warm one to take over.
  const [caret, setCaret] = useState<readonly [number, number] | null>(null);
  if (B) return <B.TextCombobox size={size} className={className} onChange={onChange} suggestions={suggestions} focusAt={caret} {...props} />;
  const { label, ...field } = props;
  const keep = (event: SyntheticEvent<HTMLInputElement>) => setCaret([event.currentTarget.selectionStart ?? 0, event.currentTarget.selectionEnd ?? 0]);
  return (
    <Input
      data-slot="combobox-field"
      data-size={size}
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      className={cn(size === "sm" && "h-7 rounded-md", className)}
      onFocus={(event) => {
        keep(event);
        warmSelects();
      }}
      onSelect={keep}
      onBlur={() => setCaret(null)}
      onChange={(event) => {
        keep(event);
        onChange(event.target.value);
      }}
      {...field}
    />
  );
}
