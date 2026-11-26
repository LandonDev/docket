import { useState, type ComponentProps } from "react";
import { Calendar } from "work-kit/ui/calendar";
import { ChevronDown } from "@renderer/chrome/icons";
import { cn } from "@renderer/lib/cn";
import { Button } from "./button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { SELECT_CHEVRON, SELECT_TRIGGER, SELECT_VALUE } from "./select-trigger";

/** A day as a date input holds it, "2026-11-26", read in his own zone (never as UTC midnight). */
export function dayOf(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getMonth() === Number(match[2]) - 1 ? date : undefined;
}

/** The date input's value for a day. */
export function valueOf(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const SHOWN = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

/**
 * A date field: the select's box showing the day ("Thu, Nov 26, 2026"), and
 * on a press the one calendar the app has (work-kit's, Kobra's adapted, the
 * same as Mail's Send later) in a popover. Its value is a date input's own
 * ("2026-11-26", "" for none), so it takes the place of `<Input type="date">`
 * and its popup wears our tokens in both themes, which Chromium's does not.
 * A pick closes it; without `required`, Clear in its foot empties it. Lives
 * in the chunk of the dialog that uses it, never the first paint.
 */
function DateField({
  value,
  onChange,
  min,
  max,
  required = false,
  placeholder = "No date",
  defaultOpen = false,
  className,
  disabled,
  ...props
}: Omit<ComponentProps<"button">, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  /** The first and last day that may be picked, as date input values. */
  min?: string;
  max?: string;
  /** A day must stay chosen: no Clear. */
  required?: boolean;
  placeholder?: string;
  /** Opens on mount (a preview's open calendar). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const day = dayOf(value);
  const before = min ? dayOf(min) : undefined;
  const after = max ? dayOf(max) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-slot="date-field"
            data-size="default"
            data-placeholder={day ? undefined : ""}
            disabled={disabled}
            className={cn(SELECT_TRIGGER, "w-full tabular-nums", className)}
            {...props}
          />
        }
      >
        <span data-slot="select-value" className={SELECT_VALUE}>
          {day ? SHOWN.format(day) : placeholder}
        </span>
        <ChevronDown aria-hidden className={SELECT_CHEVRON} />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} aria-label="Pick a day" className="w-auto gap-0 p-0">
        <Calendar
          mode="single"
          selected={day}
          defaultMonth={day ?? before}
          disabled={[...(before ? [{ before }] : []), ...(after ? [{ after }] : [])]}
          onSelect={(next: Date | undefined) => {
            // A press on the chosen day keeps it: Clear is how a day goes.
            if (next) onChange(valueOf(next));
            setOpen(false);
          }}
        />
        {!required && day ? (
          <div className="flex justify-end border-t border-border p-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              Clear
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export { DateField };
