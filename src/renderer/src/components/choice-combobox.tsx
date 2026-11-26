import { useEffect } from "react";
import { ColdSelectTrigger, usePendingOpen, useSelectBody, warmSelects } from "./lazy-select";
import type { ChoiceCombobox as Body } from "./choice-combobox-body";

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
