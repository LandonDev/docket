import type { ReactNode } from "react";
import { Bones } from "../../components/bones";

/** A document's sample words, in the document's own type (work-kit's DOCUMENT_LADDER: an 18/26 title, 15/24 body):
 *  their lengths give the bones a title and the start of a paragraph. Nobody reads them. */
const SAMPLE_TITLE = "Notes from the planning call";
const SAMPLE_BODY = "What we agreed on, who takes each part, and the dates we set for the first review of the draft, with the open questions kept for next week.";

/**
 * A document's bones at its measure (a 52px gutter, a 672px text column), centred as the document is: a title, then
 * the start of a paragraph. A `title` known at once (the item's name, a fetch's progress) is drawn as it is, outside
 * the bones (docs/agents/loading-bones.md rule 3); without one the bones draw a title's line too.
 */
export function ItemBones({ title }: { title?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-[724px] flex-col gap-4 pl-[52px]">
      {title}
      <Bones label="Loading">
        <div className="flex flex-col gap-4">
          {title ? null : <p className="text-lg leading-[26px] font-semibold text-foreground">{SAMPLE_TITLE}</p>}
          <p className="text-[15px] leading-6 text-foreground">{SAMPLE_BODY}</p>
        </div>
      </Bones>
    </div>
  );
}

/** A loading item, in a document's shape and at the document's scroller's insets, so the kind's own bones take its place without moving. */
export function ItemSkeleton() {
  return (
    <div data-canvas-skeleton className="px-6 pt-8">
      <ItemBones />
    </div>
  );
}
