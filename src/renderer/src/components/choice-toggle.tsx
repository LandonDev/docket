import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { cn } from "@renderer/lib/cn";

type ToggleChoice<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
  /** Why it is off, on a Tooltip over the choice. */
  note?: string;
};

/**
 * The one adapter from an options array to a single-choice `ToggleGroup`:
 * a bordered track with the chosen option filled, for the few choices a
 * dialog row shows at once (Type, Effort, Host). One option is always
 * chosen: pressing the chosen one again keeps it.
 */
function ChoiceToggle<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  fit,
  "aria-labelledby": labelledBy,
}: {
  label: string;
  value: T;
  options: readonly ToggleChoice<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Shrink to the row's room: the chosen label reads whole, the others are cut at 72px with an ellipsis (a long one
   *  further if the row needs it), so a short one stays whole; each keeps its whole name for a reader. */
  fit?: boolean;
  "aria-labelledby"?: string;
}) {
  return (
    <ToggleGroup
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0] as T | undefined;
        if (picked !== undefined && picked !== value) onChange(picked);
      }}
      disabled={disabled}
      size="xs"
      spacing={0.5}
      // 32px, a select's height, the choices filling it inside the 2px inset (26px, as a segmented tab fills its list).
      className={cn("h-8 rounded-lg border border-input p-0.5", fit && "min-w-0 max-w-full")}
    >
      {options.map((option) => {
        const item = (
          <ToggleGroupItem key={option.value} value={option.value} disabled={option.disabled} className={cn("h-full px-2", fit && cn("min-w-0 max-w-18 data-pressed:max-w-none", option.label.length > 8 && "shrink data-pressed:shrink-0"))}>
            {fit ? <span className="min-w-0 truncate">{option.label}</span> : option.label}
          </ToggleGroupItem>
        );
        // A disabled button takes no pointer, so its note hangs on a wrapper.
        return option.note ? (
          <Tooltip key={option.value}>
            <TooltipTrigger render={<span data-choice-note className="inline-flex h-full" />}>{item}</TooltipTrigger>
            <TooltipContent>{option.note}</TooltipContent>
          </Tooltip>
        ) : (
          item
        );
      })}
    </ToggleGroup>
  );
}

export { ChoiceToggle, type ToggleChoice };
