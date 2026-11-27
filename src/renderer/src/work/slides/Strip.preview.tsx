// A preview frame for `bun run ui:preview src/renderer/src/work/slides/Strip.preview.tsx#StripSelected --shot`: the
// strip and the Sorter with slide 3 on the stage, so the selected slide's ring and number can be read in both themes.
import type { DeckView } from "@shared/contract-work-slides";
import { Sorter } from "./Sorter";
import { Strip } from "./Strip";
import { deckView, slide } from "./testkit";

const TITLES = ["Spring LAN 2027", "Why sponsor Spring LAN", "Who comes", "The offer", "Stream package", "Budget", "Thank you"];

const view: DeckView = deckView({
  slides: TITLES.map((title, i) => slide(i + 1, { number: i + 1, title, page: i + 1, ...(i === 0 ? { section: "Spring LAN" } : i === 3 ? { section: "The offer" } : {}), ...(i === 5 ? { hidden: true } : {}) })),
});
const pictureOf = () => ({ doc: null, page: 1 });

/** The strip beside the stage: slide 3 selected, slide 4 under the pointer would take only the quiet fill. */
export function StripSelected() {
  return (
    <div className="flex h-[640px] bg-background">
      <Strip view={view} current="3" narrow={false} pictureOf={pictureOf} pictures={false} hand={null} onPick={() => undefined} />
    </div>
  );
}

/** The Sorter at 800px: four across, slide 3 selected. */
export function SorterSelected() {
  return (
    <div className="flex h-[520px] w-[800px] bg-background">
      <Sorter view={view} current="3" width={800} pictureOf={pictureOf} pictures={false} hand={null} onOpen={() => undefined} />
    </div>
  );
}
