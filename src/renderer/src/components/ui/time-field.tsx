import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { Check } from "@renderer/chrome/icons";
import { cn } from "@renderer/lib/cn";
import { clockTime } from "@renderer/lib/duration";
import { ComboboxContent, ComboboxField, ComboboxFieldInput, ComboboxFieldItem, ComboboxList } from "./combobox";

/** "18:30" as his clock says it: "6:30 PM" (`clockTime`, no padded hour); "" for none or a value that is no time. */
export function timeWords(value: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return "";
  const at = new Date(2000, 0, 1, Number(match[1]), Number(match[2]));
  return at.getHours() === Number(match[1]) && at.getMinutes() === Number(match[2]) ? clockTime(at.getTime()) : "";
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * What he typed as a time input's value ("HH:MM", 24-hour), or null when it is no time. "6", "6p", "6pm", "6:30 pm",
 * "630", "18:00" and the field's own "6:30 PM" all read; an hour with no AM or PM is the 24-hour clock's ("6" is
 * 6:00 AM, "18" 6:00 PM). An empty field is "".
 */
export function parseTime(text: string): string | null {
  const typed = text.trim().toLowerCase().replace(/[\s.]/g, "");
  if (!typed) return "";
  const match = /^(\d{1,2})(?::?(\d{2}))?(a|am|p|pm)?$/.exec(typed) ?? /^(\d{1,2})(\d{2})(a|am|p|pm)?$/.exec(typed);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const half = match[3]?.[0];
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "p" ? 12 : 0);
  } else if (hour > 23) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

/** Every quarter hour of a day, as values: "00:00" … "23:45". */
export const QUARTERS: readonly string[] = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`);

/** Whether his clock says the afternoon as 13 and on ("13:00"), not "1:00 PM". */
const onClock24 = (): boolean => timeWords("13:00").replace(/\D/g, "").startsWith("13");

/** The quarter hours that begin with what he typed, digit for digit, matched against the value itself, so his
 *  clock's form never decides it: "6p" or "6:3p" is the 12-hour hour and its half (6:00 to 6:45 PM, 6:30 PM) on any
 *  clock; bare digits are the hour his clock writes ("6" is 6:00 AM to 6:45 PM on a 12-hour clock, 06:00 to 06:45 on a
 *  24-hour one, where "18" is 18:00 to 18:45). Every one while nothing is typed. `clock24` for a test. */
export function timesFor(text: string, clock24 = onClock24()): string[] {
  const typed = text.trim().toLowerCase();
  const digits = typed.replace(/\D/g, "");
  if (!digits) return typed ? [] : [...QUARTERS];
  const half = /[ap]/.exec(typed.replace(/\d|:|\s|\./g, ""))?.[0];
  return QUARTERS.filter((value) => {
    const hour = Number(value.slice(0, 2));
    const minutes = value.slice(3);
    const twelve = `${hour % 12 || 12}${minutes}`;
    if (half) return twelve.startsWith(digits) && (hour < 12 ? "a" : "p") === half;
    return clock24 ? `${hour}${minutes}`.startsWith(digits) || `${value.slice(0, 2)}${minutes}`.startsWith(digits) : twelve.startsWith(digits);
  });
}

/**
 * A time field: a text field that shows his clock's one form ("6:00 PM", never "06:00 PM" and never Chromium's clock
 * glyph) and takes what he types ("6", "6p", "18:00", "6:30 pm"), read on Enter or when he leaves it; words that are
 * no time give the field back its last time. Its value is a time input's own ("18:00", "" for none), so it takes the
 * place of `<Input type="time">`. A press on the field, ↓, or typing drops the quarter hours under it (those that
 * begin with what he typed), the set one ticked and in view; a pick sets it. Without `required`, emptying the field
 * clears it. Lives in the chunk of the dialog that uses it, never the first paint.
 */
function TimeField({
  value,
  onChange,
  required = false,
  placeholder = "No time",
  size = "default",
  className,
  disabled,
  onBlur,
  onKeyDown,
  ...props
}: Omit<ComponentProps<"input">, "value" | "onChange" | "size" | "type"> & {
  value: string;
  onChange: (value: string) => void;
  /** A time must stay set: emptying the field gives the last one back. */
  required?: boolean;
  size?: "sm" | "default";
}) {
  // What he is typing; null while he is not, when the field shows the value in words.
  const [typed, setTyped] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const shown = typed ?? timeWords(value);
  const times = typed === null ? QUARTERS : timesFor(typed);

  // Opened on the set time: its row in view, so a nudge is one step away.
  useEffect(() => {
    if (!open || typed !== null || !value) return;
    const frame = requestAnimationFrame(() => list.current?.querySelector(`[data-time="${value}"]`)?.scrollIntoView?.({ block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [open, typed, value]);

  /** Reads what he typed: a time sets the value, anything else gives the field its last time back. */
  const settle = () => {
    if (typed === null) return;
    const next = parseTime(typed);
    setTyped(null);
    if (next === null || (next === "" && required)) return;
    if (next !== value) onChange(next);
  };

  return (
    <ComboboxField
      items={times as string[]}
      mode="none"
      value={shown}
      onValueChange={(text: string, details) => {
        // A pick fills the field with the row's value: set it, never read it as typing.
        if (details.reason === "item-press") {
          setTyped(null);
          if (text !== value) onChange(text);
          return;
        }
        setTyped(text);
      }}
      open={open && times.length > 0}
      onOpenChange={setOpen}
      openOnInputClick
      disabled={disabled}
    >
      <ComboboxFieldInput
        data-slot="time-field"
        size={size}
        placeholder={placeholder}
        inputMode="text"
        className={cn("tabular-nums", className)}
        onBlur={(event) => {
          settle();
          onBlur?.(event);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          // Enter with no row highlighted reads the words; a highlighted row is the list's to take.
          if (event.key === "Enter" && !event.currentTarget.getAttribute("aria-activedescendant")) settle();
          onKeyDown?.(event);
        }}
        {...props}
      />
      <ComboboxContent className="min-w-32">
        <ComboboxList ref={list} className="max-h-56">
          {(time: string) => (
            <ComboboxFieldItem key={time} value={time} data-time={time} className="justify-between gap-2 tabular-nums">
              {timeWords(time)}
              {time === value ? <Check aria-hidden className="size-3.5 text-muted-foreground" /> : null}
            </ComboboxFieldItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </ComboboxField>
  );
}

export { TimeField };
