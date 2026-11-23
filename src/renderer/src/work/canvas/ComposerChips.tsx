import { CHIP_NOUN, type ChipKind } from "@shared/work";
import { Clock, File, Layers, Outbox, X, type IconComponent } from "../../chrome/icons";
import { TruncateTip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { removeContextChip, useContextChips } from "./chips";
import { Calendar, Card, Chat, Doc, Mail, Person, Project, Selection, Task } from "../icons";

/** Each kind's 12px glyph, in the chip and in the `@` list's rows. */
export const CHIP_GLYPH: Record<ChipKind, IconComponent> = {
  task: Task,
  mail: Mail,
  event: Calendar,
  selection: Selection,
  project: Project,
  person: Person,
  doc: Doc,
  item: Layers,
  held: Outbox,
  routine: Clock,
  card: Card,
  chat: Chat,
  file: File,
};

/**
 * What the message is about, in the composer's box over its field
 * (docs/DESIGN.md "The composer's chip row"): one 24px chip each, on the
 * muted fill, the kind's 12px glyph, the label, Remove. A chip carries what a
 * row of text cannot: that the message is tied to that task, mail, event or
 * selection.
 */
export function ComposerChips({ sessionId }: { sessionId: string }) {
  const chips = useContextChips(sessionId);
  if (chips.length === 0) return null;
  return (
    <ul data-composer-chips aria-label="About" className="flex flex-wrap gap-1 px-2 pt-2">
      {chips.map((chip, index) => {
        const Glyph = CHIP_GLYPH[chip.kind] ?? Layers;
        return (
          // The chips of one composer are told apart by what they point at.
          <li key={`${chip.kind}:${JSON.stringify(chip.ref)}:${chip.quote ?? ""}`} data-chip={chip.kind} className="flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md bg-muted ps-2 pe-1 text-xs text-foreground">
            <Glyph className="size-3 shrink-0 text-muted-foreground" />
            <TruncateTip text={chip.label}>
              <span className="min-w-0 truncate">{chip.label}</span>
            </TruncateTip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove the ${CHIP_NOUN[chip.kind] ?? "item"}`}
                    onClick={() => removeContextChip(sessionId, index)}
                    // 16px drawn in the 24px chip, with the chip's height as its hit area.
                    className="relative size-4 rounded-sm text-muted-foreground after:absolute after:-inset-1 after:content-[''] hover:text-foreground"
                  />
                }
              >
                <X className="size-2.5" />
              </TooltipTrigger>
              <TooltipContent>Remove</TooltipContent>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
