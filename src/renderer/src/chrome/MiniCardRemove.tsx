import { AttachmentAction, AttachmentActions } from "../components/ui/attachment";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { X } from "./icons";

/** The Remove action at the end of a composer mini card. */
export function MiniCardRemove({ label, onDismiss }: { label: string; onDismiss: () => void }) {
  return (
    <AttachmentActions>
      <Tooltip>
        <TooltipTrigger render={<AttachmentAction aria-label={label} onClick={onDismiss} />}>
          <X />
        </TooltipTrigger>
        <TooltipContent>Remove</TooltipContent>
      </Tooltip>
    </AttachmentActions>
  );
}

/** A mini card's facts on one line as one comma sentence (DESIGN "Typography": never facts set apart by
 *  space alone): each 4px from the next, the comma drawn after all but the last, the last truncating. */
export const MINI_FACTS = "flex gap-1 [&>span:not(:last-child)]:after:content-[',']";
