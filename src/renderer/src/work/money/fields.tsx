import { forwardRef, type ComponentProps } from "react";
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
