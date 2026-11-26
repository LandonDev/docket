import { useId, type ReactNode } from "react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "@renderer/lib/cn";

/**
 * A single choice of a few whose choices each need a line of words, shown at
 * once (what a key may do, what the box may do on this Mac). One tab stop;
 * the arrow keys move the choice. A choice of words alone is `ChoiceToggle`.
 */
function RadioGroup<Value>({ className, ...props }: RadioGroupPrimitive.Props<Value>) {
  return <RadioGroupPrimitive data-slot="radio-group" className={cn("flex w-full flex-col", className)} {...props} />;
}

/** The 16px dot alone, its hit area 24px. The dot fades in over `--dur-fast`
 *  and nothing travels between choices. */
function RadioGroupItem<Value>({ className, ...props }: RadioPrimitive.Root.Props<Value>) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "focus-ring relative flex size-4 shrink-0 items-center justify-center rounded-full border border-check-edge bg-transparent transition-[border-color] duration-(--dur-fast) ease-(--ease-out) after:absolute after:-inset-1 data-checked:border-primary aria-invalid:border-destructive",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        keepMounted
        data-slot="radio-group-indicator"
        className="size-2 rounded-full bg-primary opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-out) data-checked:opacity-100"
      />
    </RadioPrimitive.Root>
  );
}

/** One choice as a row: the dot on the label's line, the label at 13px and
 *  its line of words 12px muted under it. The whole row picks it. */
function RadioChoice<Value>({
  value,
  label,
  description,
  disabled,
  className,
}: {
  value: Value;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  return (
    <label data-slot="radio-choice" className={cn("flex min-h-7 gap-2 py-1 text-[13px] text-foreground", disabled && "opacity-50", className)}>
      <span className="flex h-5 items-center">
        <RadioGroupItem value={value} disabled={disabled} aria-labelledby={id} aria-describedby={description ? descriptionId : undefined} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span id={id} className="leading-5">
          {label}
        </span>
        {description ? (
          <span id={descriptionId} className="text-xs leading-4 text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export { RadioChoice, RadioGroup, RadioGroupItem };
