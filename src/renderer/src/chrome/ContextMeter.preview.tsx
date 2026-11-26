// bun run ui:preview src/renderer/src/chrome/ContextMeter.preview.tsx#ContextMeterPreview
// ContextMeterPreview draws the real panel in an open popover. Polling and Compact need interaction.
import type { ComponentProps } from "react";
import { Popover, PopoverContent } from "../components/ui/popover";
import { ContextBreakdown } from "./ContextBreakdown";

export function ContextMeterPreview(props: ComponentProps<typeof ContextBreakdown>) {
  return (
    <Popover open>
      <PopoverContent aria-label="Context breakdown" className="w-80 gap-0 p-3">
        <ContextBreakdown {...props} />
      </PopoverContent>
    </Popover>
  );
}
