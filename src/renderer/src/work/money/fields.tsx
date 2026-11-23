import { forwardRef, type ComponentProps, type KeyboardEvent } from "react";
import { GroupInput, InputGroup } from "../../components/ui/input";

/**
 * Money's amount field: "$" as a quiet prefix, a decimal keypad, the field's
 * id and description on the input itself, so `Field`'s label names it.
 */
export const AmountInput = forwardRef<HTMLInputElement, ComponentProps<"input">>(function AmountInput({ className, ...props }, ref) {
  return (
    <InputGroup className={className} leading={<span className="text-[13px] text-muted-foreground">$</span>}>
      <GroupInput ref={ref} inputMode="decimal" autoComplete="off" spellCheck={false} className="tabular-nums" {...props} />
    </InputGroup>
  );
});

/** A form's keys: a held Return (a repeating keydown) never submits again; each save is pressed afresh. */
export function noHeldReturn(e: KeyboardEvent<HTMLFormElement>): void {
  if (e.key === "Enter" && e.repeat) e.preventDefault();
}
